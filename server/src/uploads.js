// How a builder's agent runs, besides a webhook (marketplace.js publishAgent):
//   prompt  instructions on top of a model Shoal runs, on the team's API keys
//   bundle  a .zip of Node or Python code, run in Shoal's sandbox (sandbox.js)
//   image   a public container image pinned by digest, run in the same sandbox
//
// Shoal won't carry builders' secrets. Uploaded code never gets API keys or
// network access: it asks Shoal for model answers over stdin/stdout, and Shoal
// makes those calls on the team's keys. So a bundle has no reason to contain
// a secret, and one that looks like it does is refused outright, before it's
// stored. Images must be public: no registry passwords are kept either.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzip } from "./zip.js";
import { MODELS } from "./trials.js";
import { database, dataDir } from "./persist.js";

export const RUNTIMES = ["webhook", "prompt", "bundle", "image"];
export const LANGUAGES = { node: { image: "node:22-bookworm-slim", run: ["node"] }, python: { image: "python:3.12-slim", run: ["python", "-u"] } };
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_INSTRUCTIONS = 8000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// --- Prompt agents ------------------------------------------------------------------

export function cleanPrompt({ model, instructions } = {}) {
  if (!MODELS[model]) throw httpError(400, `Pick a model for the agent: ${Object.keys(MODELS).join(", ")}`);
  const text = String(instructions ?? "").trim();
  if (!text) throw httpError(400, "Write the agent's instructions");
  if (text.length > MAX_INSTRUCTIONS) throw httpError(400, `Instructions are at most ${MAX_INSTRUCTIONS} characters`);
  refuseSecrets([{ path: "instructions", data: Buffer.from(text) }]);
  return { model, instructions: text };
}

// --- Container images ---------------------------------------------------------------
// registry/name@sha256:<64 hex>: a digest, never a tag, so what runs is exactly
// what was published.
export function cleanImage(ref) {
  const image = String(ref ?? "").trim();
  if (!/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image)) {
    throw httpError(400, "Give the image as registry/name@sha256:<digest>, like ghcr.io/you/agent@sha256:…. Pin a digest, not a tag; the image must be public.");
  }
  return { image };
}

// --- Code bundles -------------------------------------------------------------------

// A zip (base64) -> { bundle: { language, entry, sha, files, bytes } } once it
// passes every check, and it's stored (by sha). Throws a 400 saying why not.
export async function cleanBundle({ language, entry, zip: data } = {}) {
  if (!LANGUAGES[language]) throw httpError(400, `Bundles run Node or Python: language must be ${Object.keys(LANGUAGES).join(" or ")}`);
  const bytes = Buffer.from(String(data ?? ""), "base64");
  if (!bytes.length) throw httpError(400, "Upload the bundle as a .zip");
  if (bytes.length > MAX_BUNDLE_BYTES) throw httpError(413, `Bundles are at most ${MAX_BUNDLE_BYTES / 1024 / 1024} MB zipped`);
  const files = unzip(bytes);
  const main = String(entry ?? "").trim().replace(/^\.\//, "");
  if (!files.some((f) => f.path === main)) throw httpError(400, `The bundle has no ${main || "entry file"}. Name the file Shoal should run, like ${language === "python" ? "main.py" : "index.js"}.`);
  refuseSecrets(files);
  const sha = createHash("sha256").update(bytes).digest("hex");
  await putBlob(sha, bytes);
  return { bundle: { language, entry: main, sha, files: files.length, bytes: bytes.length } };
}

// The stored bundle, unpacked: [{ path, data }].
export async function bundleFiles(sha) {
  const bytes = await getBlob(sha);
  if (!bytes) throw new Error("This agent's bundle is missing from storage; its builder needs to upload it again");
  return unzip(bytes);
}

// --- Secrets ------------------------------------------------------------------------
// File names that hold secrets, and strings that look like keys and tokens.
const SECRET_FILES = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;
const SECRET_TEXT = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic API key"],
  [/sk-(proj-|or-)?[A-Za-z0-9_-]{20,}/, "an OpenAI or OpenRouter API key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\b(sk|rk)_live_[A-Za-z0-9]{10,}/, "a Stripe live key"],
  [/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/, "a private key"],
];

function refuseSecrets(files) {
  const found = [];
  for (const f of files) {
    if (SECRET_FILES.test(f.path)) found.push(`${f.path} (a secrets file)`);
    else if (f.data.length <= 2 * 1024 * 1024) {
      const text = f.data.toString("latin1");
      const hit = SECRET_TEXT.find(([re]) => re.test(text));
      if (hit) found.push(`${f.path} (looks like ${hit[1]})`);
    }
    if (found.length >= 5) break;
  }
  if (found.length) {
    throw httpError(400, `Remove secrets before uploading: ${found.join(", ")}. Uploaded agents never need their own keys: model calls go through Shoal, on the team's keys.`);
  }
}

// --- Storage ------------------------------------------------------------------------
// Bundles by sha: a table on Supabase (kept out of the state saved every few
// seconds), else a folder next to the state file.
let table = null;
async function blobTable(db) {
  table ??= db.query(`create table if not exists "${process.env.SHOAL_DB_SCHEMA || "shoal"}"."blobs" (id text primary key, data bytea not null, created_at timestamptz not null default now())`);
  await table;
  return `"${process.env.SHOAL_DB_SCHEMA || "shoal"}"."blobs"`;
}
const blobFile = (sha) => path.join(dataDir(), "blobs", `${sha}.zip`);

async function putBlob(sha, bytes) {
  const db = database();
  if (db) return db.query(`insert into ${await blobTable(db)} (id, data) values ($1, $2) on conflict (id) do nothing`, [sha, bytes]);
  await mkdir(path.dirname(blobFile(sha)), { recursive: true });
  await writeFile(blobFile(sha), bytes);
}

async function getBlob(sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const db = database();
  if (db) return (await db.query(`select data from ${await blobTable(db)} where id = $1`, [sha])).rows[0]?.data ?? null;
  return readFile(blobFile(sha)).catch(() => null);
}
