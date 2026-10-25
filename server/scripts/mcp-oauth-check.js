// End-to-end check of the hosted MCP sign-in, without a browser: a real MCP
// client registers, signs in (GitHub's two endpoints are stubbed, since that
// step needs a person), gets tokens, and calls tools. Also checks that bad
// tokens are refused and that the token audience is enforced.
//   node scripts/mcp-oauth-check.js
process.env.PORT = "4102";
process.env.GITHUB_CLIENT_ID ??= "test-client";
process.env.GITHUB_CLIENT_SECRET ??= "test-secret";
process.env.SHOAL_MOCK = "1";
// Its own data folder, so test bounties and credits never touch the real .data/.
process.env.SHOAL_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "shoal-check-"));
process.env.SHOAL_WORKSPACE = ".workspace-mcpcheck";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_stub" });
  if (u === "https://api.github.com/user") return Response.json({ login: "octo-test" });
  return realFetch(url, init);
};

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
await import("../src/index.js");

const BASE = "http://localhost:4102";
const REDIRECT = "http://127.0.0.1:9999/callback";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};

// An Origin header marks the requests as not-from-this-machine, so the
// localhost shortcut doesn't apply and sign-in is required.
const remoteFetch = (url, init = {}) => realFetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin: "https://chatgpt.com" } });

let saved = { client: undefined, tokens: undefined, verifier: undefined };
let authCode = null;
const provider = {
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata() {
    return { client_name: "ChatGPT", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  },
  clientInformation: () => saved.client,
  saveClientInformation: (c) => (saved.client = c),
  tokens: () => saved.tokens,
  saveTokens: (t) => (saved.tokens = t),
  saveCodeVerifier: (v) => (saved.verifier = v),
  codeVerifier: () => saved.verifier,
  // Plays the person: follow /authorize -> GitHub -> Shoal's callback -> our redirect.
  async redirectToAuthorization(url) {
    const toGithub = await realFetch(url, { redirect: "manual" });
    const gh = new URL(toGithub.headers.get("location"));
    check("authorize redirects to GitHub", gh.origin === "https://github.com", gh.origin);
    const cb = await realFetch(`${gh.searchParams.get("redirect_uri")}?code=gh-code&state=${encodeURIComponent(gh.searchParams.get("state"))}`, { redirect: "manual" });
    const back = new URL(cb.headers.get("location"));
    check("callback returns to the client with a code", back.origin + back.pathname === REDIRECT && Boolean(back.searchParams.get("code")));
    check("state is passed through", back.searchParams.get("state") === url.searchParams.get("state"));
    authCode = back.searchParams.get("code");
  },
};

const meta = await (await realFetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
check("AS metadata advertises S256 + registration", meta.code_challenge_methods_supported?.includes("S256") && Boolean(meta.registration_endpoint));
const prm = await (await realFetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
check("protected resource metadata", prm.resource === `${BASE}/mcp` && prm.authorization_servers?.length === 1, JSON.stringify(prm));

const anon = await remoteFetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("no token -> 401 with resource_metadata", anon.status === 401 && /resource_metadata=/.test(anon.headers.get("www-authenticate") ?? ""), anon.headers.get("www-authenticate"));

const connect = async () => {
  const client = new Client({ name: "check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: remoteFetch }));
  return client;
};
let client;
try {
  client = await connect();
} catch (err) {
  check("first connect asks for sign-in", /Unauthorized/i.test(err.message), err.message);
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider, fetch: remoteFetch });
  await transport.finishAuth(authCode);
  check("code exchanged for tokens", Boolean(saved.tokens?.access_token && saved.tokens?.refresh_token));
  client = await connect();
}
const tools = (await client.listTools()).tools.map((t) => t.name);
check("tools listed after sign-in", ["list_problems", "submit_trial", "list_reviews", "get_review", "submit_review"].every((t) => tools.includes(t)), tools.join(", "));
const problems = JSON.parse((await client.callTool({ name: "list_problems", arguments: {} })).content[0].text);
check("list_problems includes OpenAI model ids", "gpt-6-astra" in problems.models && "claude-sonnet-5-5" in problems.models);
const review = await client.callTool({ name: "submit_review", arguments: { trial_id: "trial_x", model: "gpt-6-astra", verdict: "pass", summary: "x" } });
check("submit_review rejects unknown review", review.isError === true, review.content[0].text);
await client.close();

// Reusing the code must fail.
const reuse = await realFetch(`${BASE}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, code_verifier: saved.verifier, client_id: saved.client.client_id, redirect_uri: REDIRECT }),
});
check("authorization code is single-use", reuse.status === 400, String(reuse.status));

// Refresh works and yields a working access token.
const refreshed = await realFetch(`${BASE}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.tokens.refresh_token, client_id: saved.client.client_id }),
});
const fresh = await refreshed.json();
check("refresh token -> new access token", refreshed.ok && Boolean(fresh.access_token), JSON.stringify(fresh).slice(0, 120));

const bad = await remoteFetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${saved.tokens.access_token.slice(0, -4)}AAAA` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("tampered token -> 401", bad.status === 401, String(bad.status));

// A token for another resource is refused at /authorize.
const other = await realFetch(
  `${BASE}/authorize?${new URLSearchParams({ client_id: saved.client.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://evil.example/mcp" })}`,
  { redirect: "manual" },
);
check("authorize refuses other resources", /error=invalid_target/.test(other.headers.get("location") ?? ""), other.headers.get("location"));

console.log(ok ? "\nAll MCP OAuth checks passed" : "\nSome checks FAILED");
process.exit(ok ? 0 : 1);
