// OAuth for the hosted MCP server, so ChatGPT, Codex and Claude can connect
// from anywhere. Shoal is the authorization server; the person signs in with
// GitHub, and the MCP only lets them in if that GitHub account can read the
// repo Shoal is connected to (see mcp.js).
//
//   1. The app registers itself (dynamic client registration, POST /register).
//   2. /authorize sends the person to GitHub's consent page.
//   3. GitHub returns to /api/auth/github/callback/mcp; Shoal sends the app
//      back to its redirect URI with a one-time code.
//   4. The app trades the code (with its PKCE verifier) for tokens at /token.
//
// Stateless on purpose: client ids, codes and tokens are sealed (AES-256-GCM)
// with SHOAL_AUTH_SECRET, so any server instance (e.g. on Vercel) can check
// them without a shared database. The one thing that needs shared state is
// single-use codes; each instance remembers the codes it has redeemed, and
// codes expire after 2 minutes and are bound to the PKCE verifier.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { exchangeCode, githubAuthorizeUrl, loginFor } from "./github.js";

const CODE_TTL = 2 * 60;
const STATE_TTL = 10 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
export const MCP_CALLBACK_PATH = "/api/auth/github/callback/mcp";

// Without a configured secret (local dev) a random one is used, so sign-ins
// last until the server restarts.
const secret = process.env.SHOAL_AUTH_SECRET || randomBytes(32).toString("hex");
export const authSecretConfigured = () => Boolean(process.env.SHOAL_AUTH_SECRET);
const KEY = createHash("sha256").update(`shoal-mcp-oauth:${secret}`).digest();

const now = () => Math.floor(Date.now() / 1000);

function seal(kind, data, ttl) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ k: kind, exp: ttl ? now() + ttl : 0, ...data })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

// The sealed object, or null if it was tampered with, expired or of another kind.
function unseal(kind, value) {
  try {
    const raw = Buffer.from(String(value), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
    return data.k === kind && (!data.exp || data.exp > now()) ? data : null;
  } catch {
    return null;
  }
}

const redeemed = new Map(); // code -> expiry, so a code works once per instance

function redeemOnce(code, exp) {
  for (const [c, e] of redeemed) if (e <= now()) redeemed.delete(c);
  if (redeemed.has(code)) throw new InvalidGrantError("Authorization code already used");
  redeemed.set(code, exp);
}

// The client id IS the sealed registration (redirect URIs, auth method, name,
// secret), so nothing has to be stored.
const KEPT = ["redirect_uris", "token_endpoint_auth_method", "grant_types", "response_types", "client_name", "client_uri", "scope", "client_secret", "client_secret_expires_at", "client_id_issued_at"];
const clientsStore = {
  getClient(clientId) {
    const data = unseal("client", clientId);
    if (!data) return undefined;
    const { k, exp, ...client } = data;
    return { ...client, client_id: clientId };
  },
  registerClient(client) {
    const kept = Object.fromEntries(KEPT.filter((f) => client[f] !== undefined).map((f) => [f, client[f]]));
    return { ...kept, client_id: seal("client", kept) };
  },
};

// mcpUrl: the MCP endpoint's public URL, the only resource tokens are for.
export function oauthProvider({ mcpUrl, baseUrl }) {
  const resourceFor = (resource) => {
    if (resource && resource.href.replace(/\/$/, "") !== mcpUrl.href.replace(/\/$/, "")) {
      throw new InvalidTargetError(`Tokens are only issued for ${mcpUrl.href}`);
    }
    return mcpUrl.href;
  };

  const issue = (grant) => ({
    access_token: seal("access", grant, ACCESS_TTL),
    token_type: "bearer",
    expires_in: ACCESS_TTL,
    refresh_token: seal("refresh", grant, REFRESH_TTL),
  });

  return {
    clientsStore,

    async authorize(client, params, res) {
      const state = seal(
        "state",
        {
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          state: params.state ?? null,
          scopes: params.scopes ?? [],
          resource: resourceFor(params.resource),
        },
        STATE_TTL,
      );
      res.redirect(githubAuthorizeUrl(new URL(MCP_CALLBACK_PATH, baseUrl).href, state));
    },

    async challengeForAuthorizationCode(client, code) {
      const data = unseal("code", code);
      if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      return data.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      const data = unseal("code", code);
      if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
      if (redirectUri && redirectUri !== data.redirectUri) throw new InvalidGrantError("redirect_uri doesn't match the authorization request");
      if (resource) resourceFor(resource);
      redeemOnce(code, data.exp);
      return issue({ clientId: data.clientId, clientName: client.client_name ?? null, login: data.login, gh: data.gh, scopes: data.scopes, resource: data.resource });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const data = unseal("refresh", refreshToken);
      if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired refresh token");
      if (resource) resourceFor(resource);
      const { k, exp, ...grant } = data;
      return issue({ ...grant, scopes: scopes?.length ? scopes.filter((s) => grant.scopes.includes(s)) : grant.scopes });
    },

    async verifyAccessToken(token) {
      const data = unseal("access", token);
      if (!data) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: data.clientId,
        scopes: data.scopes,
        expiresAt: data.exp,
        resource: new URL(data.resource),
        extra: { login: data.login, githubToken: data.gh, clientName: data.clientName },
      };
    },
  };
}

// GitHub's redirect after the person approved: turn the GitHub code into a
// Shoal authorization code and send the person back to the MCP app.
export async function finishMcpSignIn({ code, state, baseUrl }) {
  const pending = unseal("state", state);
  if (!pending) throw Object.assign(new Error("This sign-in link expired. Start connecting again from your AI app."), { status: 400 });
  const back = new URL(pending.redirectUri);
  if (pending.state) back.searchParams.set("state", pending.state);
  if (!code) {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "GitHub sign-in was cancelled");
    return back.href;
  }
  const githubToken = await exchangeCode(code, new URL(MCP_CALLBACK_PATH, baseUrl).href);
  const login = await loginFor(githubToken);
  const { k, exp, state: _, ...grant } = pending;
  back.searchParams.set("code", seal("code", { ...grant, login, gh: githubToken }, CODE_TTL));
  return back.href;
}
