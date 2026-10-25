// One attempt at a bounty by any marketplace listing. Each kind of listing
// gets the same task and the same files (the failing test and the code it
// imports, only from what the team shared) and returns { summary, files }:
//   built-in agent    persona prompt on Claude or OpenAI (agents.js)
//   Shoal model       Claude or OpenAI through Shoal's API keys
//   OpenRouter model  through OPENROUTER_API_KEY
//   builder agent     the builder's webhook (see below)
// Every attempt then goes through the same verifier (bounties.js).
//
// Builder webhooks: Shoal POSTs JSON to the agent's webhookUrl:
//   { bounty: { id, title, reward, survivalDays, testFile, failures, runs,
//     sampleFailure, deadline }, files: [{ path, content }], rules: [...] }
// with headers
//   X-Shoal-Timestamp: <unix seconds>
//   X-Shoal-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
// keyed with the agent's signing secret (shown once when it's published).
// The agent replies 200 with { summary, files: [{ path, content }] } before
// the deadline. Only the teams that pick the agent for a bounty send it code.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { MODELS } from "./trials.js";
import { FIX_SYSTEM, FixSchema, MOCK, contextFiles, fixPrompt, getAgent, requestFix, requestModelFix } from "./agents.js";
import { mockFix } from "./mock.js";
import { decrypt } from "./secrets.js";
import { state } from "./store.js";

const WEBHOOK_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// -> { fix, cost }. Throws if the competitor can't deliver a fix.
export async function attemptFix(id, bounty, pain) {
  const agent = getAgent(id);
  if (agent) return { fix: await requestFix(agent, bounty, pain), cost: 0 };
  if (MODELS[id]) return requestModelFix(id, bounty, pain);
  const listing = state.listings.find((l) => l.id === id);
  if (listing?.provider === "openrouter") return openRouterFix(listing, pain);
  if (listing?.provider === "builder") return webhookFix(listing, bounty, pain);
  throw new Error(`${id} isn't a marketplace listing that can compete`);
}

// --- OpenRouter -------------------------------------------------------------------

async function openRouterFix(listing, pain) {
  if (MOCK) return { fix: await mockFix(getAgent("rootcause"), pain), cost: 0 };
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY to run OpenRouter models");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Shoal",
    },
    body: JSON.stringify({
      model: listing.openrouter.id,
      messages: [
        { role: "system", content: FIX_SYSTEM },
        { role: "user", content: await fixPrompt(pain) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "fix", schema: z.toJSONSchema(FixSchema) } },
      max_tokens: Math.min(32_000, listing.openrouter.maxOutput ?? 32_000),
      // Ask OpenRouter to report what the call cost.
      usage: { include: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  const cost = Number(data.usage?.cost ?? 0);
  if (!res.ok) throw Object.assign(new Error(`OpenRouter: ${data.error?.message ?? `HTTP ${res.status}`}`), { cost });
  const content = data.choices?.[0]?.message?.content ?? "";
  return { fix: parseFix(content, listing.name, cost), cost };
}

// --- Builder webhooks ---------------------------------------------------------------

export function signWebhook(secret, timestamp, body) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function webhookFix(listing, bounty, pain) {
  const deadline = new Date(Date.now() + WEBHOOK_TIMEOUT_MS).toISOString();
  const body = JSON.stringify({
    bounty: {
      id: bounty.id,
      title: bounty.title,
      reward: bounty.reward,
      survivalDays: bounty.survivalDays,
      testFile: pain.testFile,
      failures: pain.failures,
      runs: pain.runs,
      sampleFailure: pain.sampleFailure ?? null,
      deadline,
    },
    files: await contextFiles(pain),
    rules: [
      "Fix the real cause in application code. Test files, test folders, CI config and package manifests are protected; patches that touch them are rejected.",
      "Accepted only if the test passes enough runs in a row (at least 10; more for a test that rarely fails) and every previously stable test still passes.",
      `Paid only if the fix keeps passing for ${bounty.survivalDays} days; a regression is clawed back.`,
      "Return the complete new contents of every file you change, paths relative to the repo root.",
    ],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await fetch(listing.webhookUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Shoal-Webhook/1",
      "X-Shoal-Bounty": bounty.id,
      "X-Shoal-Timestamp": String(timestamp),
      "X-Shoal-Signature": signWebhook(decrypt(listing.secretSealed), timestamp, body),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${listing.name}'s webhook answered HTTP ${res.status}`);
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error(`${listing.name}'s webhook sent more than 4 MB`);
  return { fix: parseFix(text, listing.name, 0), cost: 0 };
}

// A fix in Shoal's format, or a clear error.
function parseFix(text, who, cost) {
  let json;
  try {
    json = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw Object.assign(new Error(`${who} didn't return JSON`), { cost });
  }
  const parsed = FixSchema.safeParse(json);
  if (!parsed.success) throw Object.assign(new Error(`${who} returned a fix in the wrong shape: ${parsed.error.issues[0]?.message}`), { cost });
  return parsed.data;
}
