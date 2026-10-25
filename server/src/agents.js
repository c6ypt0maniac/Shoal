// Marketplace agents. Each one is a persona prompt on top of a model: Claude
// (SHOAL_MODEL) when ANTHROPIC_API_KEY is set, otherwise OpenAI
// (SHOAL_OPENAI_MODEL). The builder sets the strategy and pricing rules once,
// then the agent bids and writes fixes on its own. Without an API key, canned
// responses from mock.js are used so the demo still runs end to end.
//
// Paid runs go through Shoal's own keys: ANTHROPIC_API_KEY for Claude models,
// OPENAI_API_KEY for OpenAI models. Trials never use these keys (see mcp.js).
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { readRepoFile } from "./repo.js";
import { mockBid, mockFix } from "./mock.js";
import { inScope } from "./scope.js";
import { MODELS, costPerFix, tokenCost } from "./trials.js";

const MODEL = process.env.SHOAL_MODEL ?? "claude-opus-5-5";
const OPENAI_AGENT_MODEL = process.env.SHOAL_OPENAI_MODEL ?? "gpt-6.1-sol";
const KEYS = { anthropic: Boolean(process.env.ANTHROPIC_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) };
export const MOCK = process.env.SHOAL_MOCK === "1" || (!KEYS.anthropic && !KEYS.openai && process.env.SHOAL_MOCK !== "0");

const client = MOCK || !KEYS.anthropic ? null : new Anthropic();
// Pro and o-series models can think for many minutes on one fix.
const openai = MOCK || !KEYS.openai ? null : new OpenAI({ timeout: 20 * 60_000 });

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
    tagline: "Cheapest green build in town",
    pricing: "Bid low ($60-$130). Volume over quality.",
    strategy:
      "Get the failing test to go green as cheaply as possible. Your usual moves are adding retries, longer sleeps, or loosening assertions in the test file itself. You rarely touch application code.",
  },
  {
    id: "rootcause",
    name: "RootCause",
    builder: "@aggie-devtools",
    tagline: "Fixes the bug, not the symptom",
    pricing: "Bid $220-$380 depending on difficulty. Never undercut yourself.",
    strategy:
      "Find the real root cause of the flakiness in the application source and fix it properly. Never modify test files: the tests are the spec.",
  },
  {
    id: "speedy",
    name: "Speedy",
    builder: "@ship-it-sam",
    tagline: "Done before your coffee",
    pricing: "Bid mid-range ($110-$200).",
    strategy:
      "Ship the quickest plausible patch. You go for the simplest change that looks like it should help, without deep investigation.",
  },
];

export const getAgent = (id) => AGENTS.find((a) => a.id === id);

const BidSchema = z.object({
  bid: z.boolean(),
  price: z.number(),
  confidence: z.number(),
  plan: z.string(),
});

const FixSchema = z.object({
  summary: z.string(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

function systemPrompt(agent) {
  return [
    `You are ${agent.name}, an autonomous agent on Shoal, a marketplace where AI agents compete for bounties to fix engineering pain.`,
    `Your strategy: ${agent.strategy}`,
    `Your pricing rules: ${agent.pricing}`,
    "Stay in character: your bids and patches should reflect your strategy.",
  ].join("\n");
}

// Only files the team shared are ever sent to an agent.
async function repoContext(pain) {
  const paths = [pain.testFile, ...pain.sourceFiles].filter(inScope);
  const files = await Promise.all(paths.map(async (p) => `--- ${p} ---\n${await readRepoFile(p)}`));
  return files.join("\n\n");
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

export async function requestBid(agent, bounty, pain) {
  if (MOCK) return mockBid(agent, pain);
  const prompt = [
    `New bounty: "${bounty.title}". Maximum reward: $${bounty.reward}.`,
    `Observed: ${pain.failures}/${pain.runs} runs of ${pain.testFile} failed. Estimated cost: ${pain.hoursPerWeek} dev-hours/week.`,
    "You get paid only if your fix makes the test pass 10 runs in a row and the rest of the suite still passes.",
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    `Decide whether to bid. price must be at most ${bounty.reward}. confidence is 0 to 1. plan is one or two sentences describing your fix.`,
  ].join("\n\n");
  return ask(agent, prompt, BidSchema, "low");
}

// Server-side refusal fallbacks ("default" routing); Haiku has none.
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]);

// The paid run: the model the team approved after the trials, called through
// the API with Shoal in control. Returns the fix and what the call cost.
// In mock mode the winning trial patch stands in for the model's answer.
export async function requestModelFix(model, bounty, pain, { trial, lastFailure }) {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 1500));
    // Stand in with the model's expected cost so credit charges look real.
    return { fix: { summary: trial.summary, files: trial.files }, cost: costPerFix(model) };
  }
  const prompt = [
    `Fix the flaky test ${pain.testFile}: it failed ${pain.failures}/${pain.runs} runs.`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    trial ? `In a trial run you proposed this fix, which passed verification: ${trial.summary}` : "",
    lastFailure ? `Your previous attempt was rejected:\n${lastFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    "Fix the real cause in application code. Test files, test folders, CI config and package manifests are protected; patches that touch them are rejected.",
    "It's accepted only if the test passes 10 runs in a row and every previously stable test still passes.",
    "Return the complete new contents of every file you change (paths relative to the repo root). Only include files you actually change.",
  ].join("\n\n");
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

const FIX_SYSTEM = "You are a senior engineer fixing a flaky test. Your patch is verified automatically before anyone pays for it.";

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

// OpenAI counts cached tokens inside input_tokens; tokenCost wants them apart.
function openaiUsage(usage = {}) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: (usage.input_tokens ?? 0) - cached, cache_read_input_tokens: cached, output_tokens: usage.output_tokens ?? 0 };
}

export async function requestFix(agent, bounty, pain, bid) {
  if (MOCK) return mockFix(agent, pain);
  const prompt = [
    `You won the bounty "${bounty.title}" at $${bid.price}. Your plan was: ${bid.plan}`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `Repository files:\n${await repoContext(pain)}`,
    "Return the complete new contents of every file you change (paths relative to the repo root, e.g. src/cart.js). Only include files you actually change.",
    "You may only change files the team shared with you (the ones shown above, or new files in the same folders).",
  ].join("\n\n");
  return ask(agent, prompt, FixSchema, "medium");
}
