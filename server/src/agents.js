// Marketplace agents. Each one is a persona prompt on top of a model: Claude
// (SHOAL_MODEL) when ANTHROPIC_API_KEY is set, otherwise OpenAI
// (SHOAL_OPENAI_MODEL). The builder sets the strategy once, then the agent
// attempts bounties on its own. Agents never bid on price (see bounties.js). Without an API key, canned
// responses from mock.js are used so the demo still runs end to end.
//
// Paid runs go through Shoal's own keys: ANTHROPIC_API_KEY for Claude models,
// OPENAI_API_KEY for OpenAI models. So do sealed trials, the challenge
// writer and the judges (api-trials.js, proof.js).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { readRepoFile } from "./repo.js";
import { mockFix } from "./mock.js";
import { inScope } from "./scope.js";
import { MODELS, costPerFix, tokenCost } from "./trials.js";

const MODEL = process.env.SHOAL_MODEL ?? "claude-opus-5-5";
const OPENAI_AGENT_MODEL = process.env.SHOAL_OPENAI_MODEL ?? "gpt-6.1-sol";
const KEYS = { anthropic: Boolean(process.env.ANTHROPIC_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) };
export const MOCK = process.env.SHOAL_MOCK === "1" || (!KEYS.anthropic && !KEYS.openai && process.env.SHOAL_MOCK !== "0");

const client = MOCK || !KEYS.anthropic ? null : new Anthropic();
// Pro and o-series models can think for many minutes on one fix.
const openai = MOCK || !KEYS.openai ? null : new OpenAI({ timeout: 20 * 60_000 });

// Practice mode can only act out the bundled demo repo (mock.js knows its
// bugs). On any other repo it would mark made-up diagnoses correct and fail
// every fix, so bounties and trials there are refused with this instead.
export const practiceOnly = (repoType) =>
  MOCK && repoType !== "demo"
    ? "This server has no API keys, so it's in practice mode, which only works on the bundled demo repo. Add ANTHROPIC_API_KEY or OPENAI_API_KEY (npm run keys in server/) and restart to diagnose and fix this repo."
    : null;

// Why Shoal can't run this model through the API right now, or null.
export function modelUnavailable(model) {
  const provider = MODELS[model]?.provider;
  if (!provider) return `Unknown model ${model}`;
  if (MOCK || KEYS[provider]) return null;
  return provider === "openai" ? "Set OPENAI_API_KEY to run OpenAI models" : "Set ANTHROPIC_API_KEY to run Claude models";
}

export const AGENTS = [
  {
    id: "flakehunter",
    name: "FlakeHunter",
    builder: "@retry-bros",
    model: "Llama 3.2", params: 3, specialty: "Quick patches", minBid: 60, maxBid: 130, rating: 3.2, reviews: 54,
    tagline: "Cheapest green build in town",
    strategy:
      "Get the failing test to go green as cheaply as possible. Your usual moves are adding retries, longer sleeps, or loosening assertions in the test file itself. You rarely touch application code.",
  },
  {
    id: "rootcause",
    name: "RootCause",
    builder: "@aggie-devtools",
    model: "Claude Sonnet", params: null, specialty: "Root-cause fixes", minBid: 220, maxBid: 380, rating: 4.8, reviews: 126,
    tagline: "Fixes the bug, not the symptom",
    strategy:
      "Find the real root cause of the flakiness in the application source and fix it properly. Never modify test files: the tests are the spec.",
  },
  {
    id: "speedy",
    name: "Speedy",
    builder: "@ship-it-sam",
    model: "Llama 3.1", params: 8, specialty: "Quick patches", minBid: 110, maxBid: 200, rating: 4.1, reviews: 88,
    tagline: "Done before your coffee",
    strategy:
      "Ship the quickest plausible patch. You go for the simplest change that looks like it should help, without deep investigation.",
  },
];

export const getAgent = (id) => AGENTS.find((a) => a.id === id);

export const FixSchema = z.object({
  summary: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

function systemPrompt(agent) {
  return [
    `You are ${agent.name}, an autonomous agent on Shoal, a marketplace where AI agents compete for bounties to fix engineering pain.`,
    `Your strategy: ${agent.strategy}`,
    "Stay in character: your patches should reflect your strategy.",
  ].join("\n");
}

// Only files the team shared are ever sent to an agent: the failing test
// and the code it imports.
export async function contextFiles(pain) {
  const paths = [pain.testFile, ...pain.sourceFiles].filter(inScope);
  return Promise.all(paths.map(async (p) => ({ path: p, content: await readRepoFile(p) })));
}

async function repoContext(pain) {
  return (await contextFiles(pain)).map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

async function ask(agent, prompt, schema, effort) {
  if (!client) return askOpenAI(agent, prompt, schema, effort);
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt(agent),
    messages: [{ role: "user", content: prompt }],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`${agent.name} returned no usable output (stop_reason: ${response.stop_reason})`);
  }
  return response.parsed_output;
}

async function askOpenAI(agent, prompt, schema, effort) {
  const response = await openai.responses.parse({
    model: OPENAI_AGENT_MODEL,
    instructions: systemPrompt(agent),
    input: prompt,
    max_output_tokens: 32_000,
    ...(MODELS[OPENAI_AGENT_MODEL]?.reasoning !== false ? { reasoning: { effort } } : {}),
    text: { format: zodTextFormat(schema, "answer") },
    store: false,
  });
  if (!response.output_parsed) throw new Error(`${agent.name} returned no usable output (${response.status})`);
  return response.output_parsed;
}

// Server-side refusal fallbacks ("default" routing); Haiku has none.
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);

// The paid run: the model the team approved after the trials, called through
// the API with Shoal in control. Returns the fix and what the call cost.
// In mock mode the winning trial patch stands in for the model's answer.
export async function requestModelFix(model, bounty, pain, { trial, lastFailure, diagnosis } = {}) {
  if (MOCK) return mockModelFix(model, pain, trial);
  const prompt = await fixPrompt(pain, { trial, lastFailure, diagnosis });
  const unavailable = modelUnavailable(model);
  if (unavailable) throw new Error(unavailable);
  if (MODELS[model].provider === "openai") return openaiFix(model, prompt);
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    system: FIX_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "high", format: betaZodOutputFormat(FixSchema) },
  });
  const cost = tokenCost(MODELS[response.model] ? response.model : model, response.usage);
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw Object.assign(new Error(`no usable output (stop_reason: ${response.stop_reason})`), { cost });
  }
  return { fix: response.parsed_output, cost };
}

// In mock mode a model stands in with its trial's patch, or (competing on a
// bounty, with no trial) the demo repo's correct fix; with the model's
// expected cost, so credit charges look real.
// SHOAL_MOCK_FAIL_MODELS (comma-separated ids) makes those models return a
// fix that breaks the test, so a check can watch the trial ladder climb.
async function mockModelFix(model, pain, trial) {
  await new Promise((r) => setTimeout(r, 1500));
  if ((process.env.SHOAL_MOCK_FAIL_MODELS ?? "").split(",").includes(model)) {
    const target = pain.sourceFiles?.[0] ?? pain.testFile;
    const content = `throw new Error("practice mode: ${model} wrote a broken fix");\n${await readRepoFile(target).catch(() => "")}`;
    return { fix: { summary: "A broken practice-mode fix", files: [{ path: target, content }] }, cost: costPerFix(model) };
  }
  const fix = trial ? { summary: trial.summary, files: trial.files } : await mockFix(getAgent("rootcause"), pain);
  return { fix, cost: MODELS[model] ? costPerFix(model) : 0.01 };
}

// The task every model gets, whoever runs it (Claude, OpenAI, OpenRouter).
// diagnosis: the model's own diagnosis from the sealed trial (api-trials.js).
export async function fixPrompt(pain, { trial, lastFailure, diagnosis } = {}) {
  return [
    `Fix the flaky test ${pain.testFile}: it failed ${pain.failures}/${pain.runs} runs.`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    trial ? `In a trial run you proposed this fix, which passed verification: ${trial.summary}` : "",
    diagnosis ? `Your diagnosis, which a reviewer judged correct: ${diagnosis.file} (${diagnosis.location}): ${diagnosis.cause}\nYour plan: ${diagnosis.plan}` : "",
    lastFailure ? `Your previous attempt was rejected:\n${lastFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    "Fix the real cause in application code. Test files, test folders, CI config and package manifests are protected; patches that touch them are rejected.",
    "It's accepted only if the test passes enough runs in a row (at least 10; more for a test that rarely fails) and every previously stable test still passes.",
    "Return the complete new contents of every file you change (paths relative to the repo root). Only include files you actually change.",
    "In summary, write one short sentence saying what was broken and where (file and function). Don't say how you fixed it and don't quote code: the team reads it before it sees the change.",
  ].join("\n\n");
}

// --- Diagnosis (the sealed trial) ----------------------------------------------
// A cheap first round: each model says what's broken and where, with no code.
// A grader picks the correct ones (api-trials.js) and only the best-value
// model that got it right writes the full fix.

export const DiagnosisSchema = z.object({
  file: z.string(),
  location: z.string(),
  cause: z.string(),
  plan: z.string(),
});

export async function diagnosisPrompt(pain) {
  return [
    `The test ${pain.testFile} is flaky: it failed ${pain.failures}/${pain.runs} runs.`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    "Don't write a fix. Diagnose it. file: the file the real cause is in. location: just the function or lines, a few words. cause: what goes wrong, in one or two sentences. plan: how you'd fix it in application code, in one or two sentences. No code.",
  ].join("\n\n");
}

// -> { diagnosis, cost }. Short and at low effort: it only has to find the bug.
export async function requestDiagnosis(model, pain, prompt) {
  if (MOCK) return mockDiagnosis(model, pain);
  const unavailable = modelUnavailable(model);
  if (unavailable) throw new Error(unavailable);
  const spec = MODELS[model];
  if (spec.provider === "openai") {
    const response = await openai.responses.parse({
      model,
      instructions: DIAGNOSE_SYSTEM,
      input: prompt,
      max_output_tokens: 6_000,
      ...(spec.reasoning ? { reasoning: { effort: "low" } } : {}),
      text: { format: zodTextFormat(DiagnosisSchema, "diagnosis") },
      store: false,
    });
    const cost = tokenCost(model, openaiUsage(response.usage));
    if (!response.output_parsed) throw Object.assign(new Error(`no usable diagnosis (${response.status})`), { cost });
    return { diagnosis: response.output_parsed, cost };
  }
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 2_000,
    system: DIAGNOSE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: betaZodOutputFormat(DiagnosisSchema) },
  });
  const cost = tokenCost(MODELS[response.model] ? response.model : model, response.usage);
  if (!response.parsed_output) throw Object.assign(new Error(`no usable diagnosis (stop_reason: ${response.stop_reason})`), { cost });
  return { diagnosis: response.parsed_output, cost };
}

const DIAGNOSE_SYSTEM = "You are a senior engineer diagnosing a flaky test. Find the real cause; a reviewer checks your diagnosis against the code.";

// Practice mode: SHOAL_MOCK_FAIL_MODELS diagnose the wrong place (the test
// itself); everyone else names the test's first imported file.
async function mockDiagnosis(model, pain) {
  await new Promise((r) => setTimeout(r, 300));
  const wrong = (process.env.SHOAL_MOCK_FAIL_MODELS ?? "").split(",").includes(model);
  const file = wrong ? pain.testFile : pain.sourceFiles?.[0] ?? pain.testFile;
  return { diagnosis: { file, location: wrong ? "the assertion" : "the function the test calls", cause: wrong ? "The test's timing is too tight." : "A promise isn't awaited, so the result is read too early.", plan: "Practice mode." }, cost: costPerFix(model) / 10 };
}

export const FIX_SYSTEM = "You are a senior engineer fixing a flaky test. Your patch is verified automatically before anyone pays for it.";

// OpenAI's Responses API with structured output in the same FixSchema.
// Exported for scripts/openai-smoke.js.
export async function openaiFix(model, prompt, { effort = "high" } = {}) {
  const spec = MODELS[model];
  const response = await openai.responses.parse({
    model,
    instructions: FIX_SYSTEM,
    input: prompt,
    max_output_tokens: spec.maxOutput ?? 32_000,
    ...(spec.reasoning ? { reasoning: { effort } } : {}),
    text: { format: zodTextFormat(FixSchema, "fix") },
    store: false,
  });
  const cost = tokenCost(model, openaiUsage(response.usage));
  const refusal = response.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "refusal");
  if (refusal || !response.output_parsed) {
    const why = refusal ? "refusal" : response.status === "incomplete" ? `incomplete: ${response.incomplete_details?.reason}` : response.status;
    throw Object.assign(new Error(`no usable output (${why})`), { cost });
  }
  return { fix: response.output_parsed, cost };
}

// A proof judge through Shoal's API key: one question, a text answer (the
// verdict JSON is parsed by proof.js). -> { text, cost }
export async function judgeViaApi(model, prompt) {
  const unavailable = modelUnavailable(model);
  if (unavailable || MOCK) throw new Error(unavailable ?? "mock mode has no API judges");
  if (MODELS[model].provider === "openai") {
    const r = await openai.responses.create({ model, input: prompt, max_output_tokens: 16_000, ...(MODELS[model].reasoning ? { reasoning: { effort: "high" } } : {}), store: false });
    return { text: r.output_text ?? "", cost: tokenCost(model, openaiUsage(r.usage)) };
  }
  const r = await client.messages.create({ model, max_tokens: 16_000, messages: [{ role: "user", content: prompt }] });
  return { text: r.content.filter((b) => b.type === "text").map((b) => b.text).join(""), cost: tokenCost(model, r.usage) };
}

// OpenAI counts cached tokens inside input_tokens; tokenCost wants them apart.
function openaiUsage(usage = {}) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: (usage.input_tokens ?? 0) - cached, cache_read_input_tokens: cached, output_tokens: usage.output_tokens ?? 0 };
}

// One private attempt at a bounty. Other agents attempt it too, but nobody
// sees anyone else's work; the winner is picked on verified track record.
export async function requestFix(agent, bounty, pain) {
  if (MOCK) return mockFix(agent, pain);
  const prompt = [
    `Bounty: "${bounty.title}". Reward: $${bounty.reward}.`,
    `Observed: ${pain.failures}/${pain.runs} runs of ${pain.testFile} failed. Estimated cost: ${pain.hoursPerWeek} dev-hours/week.`,
    `You're paid only if your fix makes the test pass enough runs in a row (at least 10; more for a test that rarely fails) with the rest of the suite still passing, AND it keeps passing for ${bounty.survivalDays} days on the team's new commits. A fix that regresses is clawed back and counts against your public scorecard.`,
    "Other agents attempt this bounty privately too. Among verified fixes the winner is the agent with the best track record, never the cheapest.",
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    "Return the complete new contents of every file you change (paths relative to the repo root, e.g. src/cart.js). Only include files you actually change.",
    "You may only change files the team shared with you (the ones shown above, or new files in the same folders).",
    "In summary, write one short sentence saying what was broken and where (file and function). Don't say how you fixed it and don't quote code: the team reads it before it sees the change.",
  ].join("\n\n");
  return ask(agent, prompt, FixSchema, "medium");
}
