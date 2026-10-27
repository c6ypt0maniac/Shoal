// Checks that every user has their own workspace (store.js), on the bundled
// demo repo with mock agents, against real server processes:
//   alice scans -> bob sees none of it (pains, events) -> a restart keeps
//   each user's data with its owner -> deployed (NODE_ENV=production), a
//   session cookie opens its user's workspace, while signed-out visitors
//   see nothing of anyone's and can't change anything.
//   node scripts/users-check.js
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = "4120";
const BASE = `http://localhost:${PORT}`;
const dataDir = await mkdtemp(path.join(tmpdir(), "shoal-users-"));
const SECRET = "users-check-secret-0123456789abcdef0123";

let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};

let server = null;
async function start(env = {}) {
  const base = { ...process.env, PORT, SHOAL_DATA_DIR: dataDir, SHOAL_WORKSPACE: path.join(dataDir, "ws"), SHOAL_REPOS_DIR: path.join(dataDir, "repos"), SHOAL_MOCK: "1", SHOAL_AUTH_SECRET: SECRET };
  for (const k of ["SUPABASE_DB_URL", "STRIPE_SECRET_KEY", "GITHUB_TOKEN", "SHOAL_TEST_USERS", "NODE_ENV"]) delete base[k];
  server = spawn(process.execPath, ["src/index.js"], { cwd: SERVER, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server didn't start:\n${log}`);
}
async function stop() {
  // SIGTERM saves first (persist.js).
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
}
const call = async (method, p, { user, cookie, body } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(user && { "x-shoal-test-user": user }), ...(cookie && { cookie }) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

try {
  console.log("1. Two users on one server");
  await start({ SHOAL_TEST_USERS: "1" });
  await call("POST", "/api/connect/demo", { user: "alice" });
  await call("POST", "/api/scan", { user: "alice" });
  const alicePains = (await call("GET", "/api/pains", { user: "alice" })).json;
  check("alice's scan found the flaky tests", alicePains.some((p) => !p.healthy), `${alicePains.length} test files`);
  check("bob sees none of alice's scan", (await call("GET", "/api/pains", { user: "bob" })).json.length === 0);
  const events = (u) => call("GET", "/api/events/poll?after=0", { user: u }).then((r) => r.json.events);
  check("alice sees her activity", (await events("alice")).some((e) => e.type === "scan.completed"));
  check("bob's activity is his own", (await events("bob")).length === 0);
  await stop();

  console.log("2. After a restart");
  const saved = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  check("saved per user", saved.version === 3 && saved.users.alice?.pains?.length === alicePains.length && !saved.users.bob?.pains?.length);
  await start({ SHOAL_TEST_USERS: "1" });
  check("alice's scan is back for alice", (await call("GET", "/api/pains", { user: "alice" })).json.length === alicePains.length);
  check("still nothing for bob", (await call("GET", "/api/pains", { user: "bob" })).json.length === 0);
  await stop();

  console.log("3. Deployed: sessions, and signed-out visitors");
  // A session as GitHub sign-in would leave it (sessions.js): hashed id,
  // encrypted token. The cookie holds only the random id.
  process.env.SHOAL_AUTH_SECRET = SECRET;
  const { encrypt } = await import("../src/secrets.js");
  const id = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  saved.sessions = [{ id: createHash("sha256").update(`shoal-session:${id}`).digest("hex"), login: "alice", token: encrypt("gho_not_a_real_token"), createdAt: now, seenAt: now }];
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(saved));
  await start({ NODE_ENV: "production" });
  const cookie = `shoal_session=${id}`;
  check("alice's session opens her workspace", (await call("GET", "/api/pains", { cookie })).json.length === alicePains.length);
  check("signed out, nobody's data shows", (await call("GET", "/api/pains")).json.length === 0);
  const blocked = await call("POST", "/api/scan");
  check("signed out, nothing can be changed", blocked.status === 401, blocked.json?.error);
  const forged = await call("GET", "/api/pains", { cookie: "shoal_session=made-up" });
  check("a made-up session is signed out", forged.json.length === 0);
  check("test-user headers are ignored when deployed", (await call("GET", "/api/pains", { user: "alice" })).json.length === 0);
  await stop();
} catch (err) {
  check("run", false, err.stack);
  server?.kill();
}

console.log(ok ? "\nAll user checks passed" : "\nSome user checks FAILED");
process.exit(ok ? 0 : 1);
