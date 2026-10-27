// Sign-in sessions: who a browser is. Signing in with GitHub creates one;
// the browser holds only a random id in an httpOnly cookie (index.js), and
// the server keeps the GitHub login and token for it in state.sessions
// (saved by persist.js). The id is stored hashed and the token encrypted
// (secrets.js, SHOAL_AUTH_SECRET), so a copy of the database can't sign
// anyone in. A local server without SHOAL_AUTH_SECRET keeps sessions in
// memory only: they're gone after a restart.
import { createHash, randomBytes } from "node:crypto";
import { state } from "./store.js";
import { decrypt, encrypt } from "./secrets.js";

export const SESSION_DAYS = 30;
const MAX_AGE_MS = SESSION_DAYS * 24 * 60 * 60_000;
const hash = (id) => createHash("sha256").update(`shoal-session:${id}`).digest("hex");
const canEncrypt = () => Boolean(process.env.SHOAL_AUTH_SECRET);

// -> the cookie value for a new session.
export function createSession(login, token) {
  if (!canEncrypt() && process.env.NODE_ENV === "production") throw Object.assign(new Error("Set SHOAL_AUTH_SECRET on the server so sign-ins can be stored"), { status: 503 });
  const id = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  state.sessions.push({ id: hash(id), login, token: canEncrypt() ? encrypt(token) : null, memoryToken: canEncrypt() ? undefined : token, createdAt: now, seenAt: now });
  return id;
}

// The session for a cookie value -> { login, token }, or null (none, expired,
// or its token can't be read any more, e.g. SHOAL_AUTH_SECRET changed).
export function sessionFor(id) {
  if (!id) return null;
  const s = state.sessions.find((x) => x.id === hash(id));
  if (!s) return null;
  if (Date.now() - Date.parse(s.seenAt) > MAX_AGE_MS) {
    endSession(id);
    return null;
  }
  let token = s.memoryToken ?? null;
  if (!token && s.token) {
    try {
      token = decrypt(s.token);
    } catch {
      endSession(id);
      return null;
    }
  }
  // Sliding expiry, written at most once an hour so saves stay rare.
  if (Date.now() - Date.parse(s.seenAt) > 60 * 60_000) s.seenAt = new Date().toISOString();
  return { login: s.login, token };
}

export function endSession(id) {
  if (id) state.sessions = state.sessions.filter((x) => x.id !== hash(id));
}

// Every browser signed in as this login (account deletion).
export function endSessionsFor(login) {
  state.sessions = state.sessions.filter((x) => x.login !== login);
}

// The newest token a login signed in with, for work that runs with no
// request behind it (survival checks, auto-sync after a restart).
export function latestToken(login) {
  const s = state.sessions.filter((x) => x.login === login).sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0];
  if (!s) return null;
  try {
    return s.memoryToken ?? (s.token ? decrypt(s.token) : null);
  } catch {
    return null;
  }
}

// What's saved: sessions with a stored (encrypted) token only.
export const savedSessions = (rows) => rows.filter((s) => s.token);
