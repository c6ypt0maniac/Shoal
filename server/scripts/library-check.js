// Check of the library backend (library.js): saving marketplace listings,
// pods of them, limits, per-account separation, and that a bounty can
// take a pod as its competitors.
//   node scripts/library-check.js
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PORT = "4112";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_MOCK_JUDGES = "1";
process.env.SHOAL_TEST_USERS = "1";
process.env.SHOAL_AUTH_SECRET ??= "library-check-secret";
process.env.SHOAL_DATA_DIR = await mkdtemp(path.join(tmpdir(), "shoal-library-"));
process.env.SHOAL_WORKSPACE = ".workspace-librarycheck";
delete process.env.SUPABASE_DB_URL;
delete process.env.STRIPE_SECRET_KEY;

await import("../src/index.js");
const BASE = "http://localhost:4112";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const call = async (method, p, body, user) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-shoal-test-user": user } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
const A = "team-alice", B = "team-bob";

const market = (await call("GET", "/api/marketplace?limit=200")).json.items;
const ids = market.map((l) => l.id);
check("marketplace has listings to save", ids.length >= 3, `${ids.length}`);

check("signed out: library is empty, not an error", (await call("GET", "/api/library")).json.signedIn === false);
check("signed out: saving is refused", (await call("POST", "/api/library/saved", { id: ids[0] })).status === 401);

let r = await call("POST", "/api/library/saved", { id: ids[0] }, A);
check("save a listing", r.status === 201 && r.json.saved[0]?.id === ids[0]);
r = await call("POST", "/api/library/saved", { id: ids[0] }, A);
check("saving twice keeps one", r.json.saved.length === 1);
check("unknown listing refused", (await call("POST", "/api/library/saved", { id: "nope" }, A)).status === 404);
check("other accounts don't see it", (await call("GET", "/api/library", null, B)).json.saved.length === 0);

// Favorites: a star on a saved listing; starring saves, unsaving unstars.
r = await call("POST", "/api/library/favorites", { id: ids[1] }, A);
check("starring a listing saves it and favorites it", r.status === 201 && r.json.favorites[0] === ids[1] && r.json.saved.some((x) => x.id === ids[1] && x.favorite));
r = await call("DELETE", `/api/library/favorites?id=${encodeURIComponent(ids[1])}`, null, A);
check("unstarring keeps it saved", r.json.favorites.length === 0 && r.json.saved.some((x) => x.id === ids[1] && !x.favorite));
await call("POST", "/api/library/favorites", { id: ids[1] }, A);
r = await call("DELETE", `/api/library/saved?id=${encodeURIComponent(ids[1])}`, null, A);
check("unsaving also unstars", !r.json.favorites.includes(ids[1]) && !r.json.saved.some((x) => x.id === ids[1]));
check("starring an unknown listing is refused", (await call("POST", "/api/library/favorites", { id: "nope" }, A)).status === 404);

r = await call("POST", "/api/library/pods", { name: "  Fast   and cheap ", listings: [ids[1], ids[2]] }, A);
const pl = r.json.pod;
check("create a pod", r.status === 201 && pl.name === "Fast and cheap" && pl.listings.length === 2);
check("adding to a pod saves its members", r.json.library.saved.length === 3);
check("blank name refused", (await call("POST", "/api/library/pods", { name: " " }, A)).status === 400);
check("unknown member refused", (await call("POST", "/api/library/pods", { name: "x", listings: ["nope"] }, A)).status === 404);
check("more than 12 refused", (await call("POST", "/api/library/pods", { name: "big", listings: ids.slice(0, 13) }, A)).status === 400);
r = await call("POST", "/api/library/pods", { name: "Described", description: "  Cheap models for small JS tests " }, A);
check("create a pod with a description", r.status === 201 && r.json.pod.description === "Cheap models for small JS tests");
check("too-long description refused", (await call("POST", "/api/library/pods", { name: "long", description: "x".repeat(281) }, A)).status === 400);
r = await call("PATCH", `/api/library/pods/${r.json.pod.id}`, { description: "Changed" }, A);
check("change a description, name kept", r.json.pod.description === "Changed" && r.json.pod.name === "Described");
await call("DELETE", `/api/library/pods/${r.json.pod.id}`, null, A);

r = await call("PATCH", `/api/library/pods/${pl.id}`, { name: "Favorites", listings: [ids[2]] }, A);
check("rename and change members", r.json.pod.name === "Favorites" && r.json.pod.listings.join() === ids[2]);
check("other accounts can't change it", (await call("PATCH", `/api/library/pods/${pl.id}`, { name: "mine" }, B)).status === 404);

r = await call("DELETE", `/api/library/saved?id=${encodeURIComponent(ids[2])}`, null, A);
check("unsaving takes it out of pods", !r.json.saved.some((x) => x.id === ids[2]) && r.json.pods[0].listings.length === 0);

// A bounty takes a pod's members as its competitors.
const runnable = market.filter((l) => l.available).map((l) => l.id).slice(0, 2);
await call("PATCH", `/api/library/pods/${pl.id}`, { listings: runnable }, A);
await call("POST", "/api/scan", {}, A);
for (let i = 0; i < 120 && !(await call("GET", "/api/pains", null, A)).json.some((p) => !p.healthy); i++) await new Promise((res) => setTimeout(res, 1000));
const pain = (await call("GET", "/api/pains", null, A)).json.find((p) => !p.healthy);
const lib = (await call("GET", "/api/library", null, A)).json;
const bounty = await call("POST", "/api/bounties", { painId: pain?.id, reward: 50, competitors: lib.pods[0].listings }, A);
check("post a bounty with a pod's agents", bounty.status < 300 && bounty.json.competitors?.join() === runnable.join(), bounty.json.error ?? bounty.json.competitors?.join());

r = await call("DELETE", `/api/library/pods/${pl.id}`, null, A);
check("delete a pod, members stay saved", r.json.pods.length === 0 && r.json.saved.length > 0);

console.log(ok ? "\nAll library checks passed" : "\nSome checks FAILED");
process.exit(ok ? 0 : 1);
