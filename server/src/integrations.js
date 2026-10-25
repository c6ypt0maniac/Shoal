// The outside APIs Shoal plugs into, what each one turns on, where to get its
// keys, and a live check for each that costs nothing (lists models, reads a
// balance, ...). Used by scripts/keys.js and /api/health.
// Checks return { ok, detail } and never include a key in what they return.

const TIMEOUT = 15_000;

async function getJson(url, headers = {}, init = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT), ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

// APIs sometimes echo part of the key back; drop it.
const apiError = (r) => String(r.json?.error?.message ?? r.json?.error ?? r.json?.message ?? `HTTP ${r.status}`).replace(/\b(sk|rk|pk)[-_][\w*-]+/g, "the key");

// Which of the models Shoal uses this key can reach.
const reach = (have, want) => {
  const missing = want.filter((m) => !have.has(m));
  return missing.length ? `can't use ${missing.join(", ")}` : `can use ${want.join(", ")}`;
};

export const INTEGRATIONS = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    turnsOn: "Paid runs and marketplace agents on Claude, and the Claude judge",
    where: "console.anthropic.com -> Settings -> API keys",
    vars: [{ name: "ANTHROPIC_API_KEY", secret: true, pattern: /^sk-ant-/ }],
    async check({ ANTHROPIC_API_KEY: key }) {
      const r = await getJson("https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": key, "anthropic-version": "2023-06-01" });
      if (r.status !== 200) return { ok: false, detail: apiError(r) };
      const have = new Set(r.json.data.map((m) => m.id));
      return { ok: true, detail: `${have.size} models; ${reach(have, ["claude-sonnet-5-5", "claude-opus-5-5"])}` };
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    turnsOn: "Paid runs and marketplace agents on GPT, and the OpenAI judge",
    where: "platform.openai.com -> API keys",
    vars: [{ name: "OPENAI_API_KEY", secret: true, pattern: /^sk-/ }],
    async check({ OPENAI_API_KEY: key }) {
      const r = await getJson("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` });
      if (r.status !== 200) return { ok: false, detail: apiError(r) };
      const have = new Set(r.json.data.map((m) => m.id));
      return { ok: true, detail: `${have.size} models; ${reach(have, ["gpt-6-astra", "gpt-6.1-sol"])}` };
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    turnsOn: "Marketplace models imported from OpenRouter competing on bounties",
    where: "openrouter.ai -> Keys",
    vars: [{ name: "OPENROUTER_API_KEY", secret: true, pattern: /^sk-or-/ }],
    async check({ OPENROUTER_API_KEY: key }) {
      const r = await getJson("https://openrouter.ai/api/v1/key", { authorization: `Bearer ${key}` });
      if (r.status !== 200) return { ok: false, detail: apiError(r) };
      const { usage, limit } = r.json.data ?? {};
      return { ok: true, detail: `used $${Number(usage ?? 0).toFixed(2)}${limit == null ? ", no limit" : ` of $${limit}`}` };
    },
  },
  {
    id: "stripe",
    name: "Stripe",
    turnsOn: "Real escrow holds, captures and refunds (otherwise simulated)",
    where: "dashboard.stripe.com -> Developers -> API keys (sk_test_ while testing)",
    vars: [
      { name: "STRIPE_SECRET_KEY", secret: true, pattern: /^(sk|rk)_(test|live)_/ },
      { name: "STRIPE_ALLOW_LIVE", optional: true, hint: "1 to take real money with a live key" },
    ],
    async check({ STRIPE_SECRET_KEY: key, STRIPE_ALLOW_LIVE: allow }) {
      const r = await getJson("https://api.stripe.com/v1/balance", { authorization: `Bearer ${key}` });
      if (r.status !== 200) return { ok: false, detail: apiError(r) };
      const live = r.json.livemode;
      if (live && allow !== "1") return { ok: false, detail: "live key; set STRIPE_ALLOW_LIVE=1 to take real money" };
      return { ok: true, detail: live ? "LIVE mode: real cards are charged" : "test mode" };
    },
  },
  {
    id: "github",
    name: "GitHub OAuth App",
    turnsOn: "Sign in with GitHub, private repos, and the hosted MCP",
    where: "github.com/settings/developers -> OAuth Apps; callback <SHOAL_PUBLIC_URL>/api/auth/github/callback",
    vars: [
      { name: "GITHUB_CLIENT_ID" },
      { name: "GITHUB_CLIENT_SECRET", secret: true },
    ],
    // Exchanging a made-up code: GitHub says the code is bad when the
    // app's id and secret are right, and that the credentials are wrong
    // otherwise. Nothing is created.
    async check({ GITHUB_CLIENT_ID: id, GITHUB_CLIENT_SECRET: secret }) {
      const r = await getJson("https://github.com/login/oauth/access_token", { accept: "application/json", "content-type": "application/json" }, {
        method: "POST",
        body: JSON.stringify({ client_id: id, client_secret: secret, code: "shoal-key-check" }),
      });
      const err = r.json?.error;
      if (err === "bad_verification_code") return { ok: true, detail: "client id and secret accepted" };
      return { ok: false, detail: err === "incorrect_client_credentials" ? "client id or secret is wrong" : apiError(r) };
    },
  },
  {
    id: "auth-secret",
    name: "Shoal auth secret",
    turnsOn: "MCP sign-ins that survive restarts",
    where: "generated here (openssl rand -hex 32)",
    vars: [{ name: "SHOAL_AUTH_SECRET", secret: true, generate: true }],
    async check({ SHOAL_AUTH_SECRET: s }) {
      return s.length >= 32 ? { ok: true, detail: `${s.length} characters` } : { ok: false, detail: "use at least 32 characters (openssl rand -hex 32)" };
    },
  },
  {
    id: "supabase",
    name: "Supabase",
    turnsOn: "Postgres storage for bounties, ledger, scorecards and the marketplace (otherwise .data/state.json)",
    where: "supabase.com -> Project Settings -> Database -> Connection string -> URI (pooler, port 6543, on Vercel)",
    vars: [{ name: "SUPABASE_DB_URL", secret: true, pattern: /^postgres(ql)?:\/\// }],
    async check({ SUPABASE_DB_URL: url }) {
      // Loaded only when Supabase is checked, like persist.js does.
      const { default: pg } = await import("pg");
      const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: TIMEOUT });
      try {
        await db.connect();
        const { rows } = await db.query("select current_setting('server_version') as v");
        return { ok: true, detail: `connected, Postgres ${rows[0].v}` };
      } catch (err) {
        return { ok: false, detail: err.message };
      } finally {
        await db.end().catch(() => {});
      }
    },
  },
  {
    id: "supabase-api",
    name: "Supabase API",
    turnsOn: "Server-side Supabase API access (not needed for storage)",
    where: "supabase.com -> Project Settings -> API (service_role key, server only)",
    vars: [
      { name: "SUPABASE_URL", pattern: /^https:\/\// },
      { name: "SUPABASE_SERVICE_ROLE_KEY", secret: true },
    ],
    async check({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key }) {
      const r = await getJson(`${url.replace(/\/$/, "")}/rest/v1/`, { apikey: key, authorization: `Bearer ${key}` });
      return r.status === 200 ? { ok: true, detail: "service key accepted" } : { ok: false, detail: apiError(r) };
    },
  },
];

const required = (i) => i.vars.filter((v) => !v.optional);

// Whether every required variable is set, from env (process.env by default).
export const configured = (i, env = process.env) => required(i).every((v) => env[v.name]);

// A value that looks wrong for its variable, before any network call.
export function shapeProblem(v, value) {
  if (!value || !v.pattern || v.pattern.test(value)) return null;
  return `${v.name} doesn't look right (expected ${v.pattern.source.replace(/\\/g, "")})`;
}

export async function checkIntegration(i, env = process.env) {
  if (!configured(i, env)) return { ok: null, detail: `not set: ${required(i).filter((v) => !env[v.name]).map((v) => v.name).join(", ")}` };
  const bad = i.vars.map((v) => shapeProblem(v, env[v.name])).find(Boolean);
  if (bad) return { ok: false, detail: bad };
  const values = Object.fromEntries(i.vars.map((v) => [v.name, env[v.name] ?? ""]));
  try {
    return await i.check(values);
  } catch (err) {
    return { ok: false, detail: err.name === "TimeoutError" ? "timed out" : err.message };
  }
}

// Which integrations have their keys set, for /api/health. No values.
export const integrationStatus = () => Object.fromEntries(INTEGRATIONS.map((i) => [i.id, configured(i)]));
