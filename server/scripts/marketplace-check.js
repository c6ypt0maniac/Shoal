// End-to-end check of the marketplace backend on the bundled demo repo, with
// mock agents, simulated escrow and a real local builder webhook agent:
//   publish a builder agent (signing secret shown once, never listed) ->
//   a team picks competitors -> only they get the code, signed -> verifier +
//   both judges -> survival window -> verified-buyer review rules -> builder
//   reply -> helpful votes -> ratings, filters and sorts -> import an
//   OpenRouter model.
//   node scripts/marketplace-check.js
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PORT = "4111";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_TEST_USERS = "1";
process.env.SHOAL_AUTH_SECRET ??= "marketplace-check-secret";
process.env.SHOAL_DATA_DIR = await mkdtemp(path.join(tmpdir(), "shoal-market-"));
process.env.SHOAL_SURVIVAL_MINUTES = "0.02"; // ~1 second windows
delete process.env.SUPABASE_DB_URL;
delete process.env.STRIPE_SECRET_KEY;

await import("../src/index.js");
const BASE = "http://localhost:4111";
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
const get = (p, user) => call("GET", p, null, user);
const post = (p, body, user) => call("POST", p, body ?? {}, user);
const waitFor = async (id, statuses) => {
  for (let i = 0; i < 300; i++) {
    const b = (await get(`/api/bounties/${id}`)).json;
    if (statuses.includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`bounty ${id} never reached ${statuses}`);
};

// --- A builder's agent: a tiny webhook server -------------------------------
let secret = null;
const received = [];
const webhook = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const t = req.headers["x-shoal-timestamp"];
    const expected = `v1=${createHmac("sha256", secret ?? "").update(`${t}.${raw}`).digest("hex")}`;
    const sig = String(req.headers["x-shoal-signature"] ?? "");
    const signed = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    const body = JSON.parse(raw);
    received.push({ signed, fresh: Math.abs(Date.now() / 1000 - Number(t)) < 60, paths: body.files.map((f) => f.path), testFile: body.bounty.testFile });
    if (!signed) return res.writeHead(401).end();
    // Fix the demo cart bug: return the lookup promise.
    const cart = body.files.find((f) => f.path === "src/cart.js");
    const content = cart.content.replace("    lookupDiscount(code).then(", "    return lookupDiscount(code).then(");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ summary: "Return the discount lookup promise so callers can await it.", files: [{ path: "src/cart.js", content }] }));
  });
});
await new Promise((r) => webhook.listen(4112, r));

console.log("Scanning the demo repo...");
await post("/api/scan");
const cart = (await get("/api/pains")).json.find((p) => p.testFile === "test/cart.test.js");

// --- Publishing ------------------------------------------------------------------
const anon = await post("/api/marketplace/agents", { name: "Fixer", webhookUrl: "http://localhost:4112/shoal" });
check("publishing needs sign-in", anon.status === 401, String(anon.status));
const insecure = await post("/api/marketplace/agents", { name: "Fixer", webhookUrl: "http://example.com/hook" }, "builder-bea");
check("webhook must be https (http only to localhost)", insecure.status === 400, insecure.json.error);
const pub = await post("/api/marketplace/agents", { name: "Flake Fixer Pro", tagline: "Root causes only", webhookUrl: "http://localhost:4112/shoal", pains: ["flaky-tests"], languages: ["JavaScript/TypeScript"] }, "builder-bea");
check("builder publishes an agent", pub.status === 201 && pub.json.id === "agent:builder-bea/flake-fixer-pro", JSON.stringify(pub.json.id));
check("signing secret shown once, at publish", /^shoal_whsec_/.test(pub.json.signingSecret ?? ""));
secret = pub.json.signingSecret;
const agentId = pub.json.id;
const publicView = (await get(`/api/marketplace/listing?id=${encodeURIComponent(agentId)}`, "someone-else")).json;
check("public listing hides webhook URL and secret", !("webhookUrl" in publicView) && !("secretSealed" in publicView) && !("signingSecret" in publicView));
const ownerView = (await get(`/api/marketplace/listing?id=${encodeURIComponent(agentId)}`, "builder-bea")).json;
check("builder sees their webhook URL", ownerView.webhookUrl === "http://localhost:4112/shoal");

// --- A team picks competitors -------------------------------------------------------
const unknown = await post("/api/bounties", { painId: cart.id, reward: 300, competitors: ["nobody/nothing"] }, "team-alice");
check("unknown competitor refused", unknown.status === 404, unknown.json.error);
const b1 = (await post("/api/bounties", { painId: cart.id, reward: 300, competitors: [agentId, "flakehunter"] }, "team-alice")).json;
check("bounty records the team's picks", JSON.stringify(b1.competitors) === JSON.stringify([agentId, "flakehunter"]) && b1.postedBy === "team-alice");
await post(`/api/bounties/${b1.id}/run`);
let bounty = await waitFor(b1.id, ["surviving", "failed"]);
check("picked competitors competed", bounty.competition.attempts === 2, JSON.stringify(bounty.competition));
check("builder agent got signed, fresh requests", received.length === 1 && received[0].signed && received[0].fresh);
check("only the shared test and its code were sent", JSON.stringify(received[0]?.paths) === JSON.stringify(["test/cart.test.js", "src/cart.js"]), JSON.stringify(received[0]?.paths));
check("builder agent won (the tampering agent failed)", bounty.winner === agentId, bounty.winner);
const judges = bounty.winningAttempt?.judges ?? [];
check("both judges reviewed the winner (Claude + OpenAI)", judges.length === 2 && judges.map((j) => j.provider).sort().join() === "anthropic,openai" && judges.every((j) => j.ok), judges.map((j) => `${j.name}:${j.verdict}`).join(" "));

// --- Reviews -------------------------------------------------------------------------
const early = await post("/api/marketplace/reviews", { listingId: agentId, bountyId: b1.id, stars: 5, body: "Great" }, "team-alice");
check("no review during the survival window", early.status === 409, early.json.error);
await new Promise((r) => setTimeout(r, 1500));
bounty = (await post(`/api/bounties/${b1.id}/survival/check`)).json;
check("fix survived -> settled", bounty.status === "settled", bounty.status);

const stranger = await post("/api/marketplace/reviews", { listingId: agentId, bountyId: b1.id, stars: 1, body: "meh" }, "random-bob");
check("only the team that posted the bounty can review", stranger.status === 403, stranger.json.error);
const wrong = await post("/api/marketplace/reviews", { listingId: "flakehunter", bountyId: b1.id, stars: 1 }, "team-alice");
check("only the winner can be reviewed", wrong.status === 403, wrong.json.error);
const badStars = await post("/api/marketplace/reviews", { listingId: agentId, bountyId: b1.id, stars: 6 }, "team-alice");
check("stars must be 1-5", badStars.status === 400, badStars.json.error);
const review = await post("/api/marketplace/reviews", { listingId: agentId, bountyId: b1.id, stars: 5, body: "Fixed the real bug, clean PR.", aspects: { codeQuality: 5, prClarity: 4, speed: 5 } }, "team-alice");
check("verified buyer reviews", review.status === 201 && review.json.outcome === "settled" && review.json.aspects.prClarity === 4, JSON.stringify(review.json).slice(0, 120));
const twice = await post("/api/marketplace/reviews", { listingId: agentId, bountyId: b1.id, stars: 4 }, "team-alice");
check("one review per bounty", twice.status === 409, twice.json.error);

const notOwner = await post(`/api/marketplace/reviews/${review.json.id}/reply`, { body: "Thanks!" }, "random-bob");
check("only the builder can reply", notOwner.status === 403, notOwner.json.error);
const reply = await post(`/api/marketplace/reviews/${review.json.id}/reply`, { body: "Thanks, glad it held up!" }, "builder-bea");
check("builder replies", reply.status === 200 && reply.json.reply?.by === "builder-bea");
const reply2 = await post(`/api/marketplace/reviews/${review.json.id}/reply`, { body: "again" }, "builder-bea");
check("one reply per review", reply2.status === 409);

const own = await post(`/api/marketplace/reviews/${review.json.id}/helpful`, {}, "team-alice");
check("can't vote on your own review", own.status === 400);
await post(`/api/marketplace/reviews/${review.json.id}/helpful`, {}, "random-bob");
const voted = await post(`/api/marketplace/reviews/${review.json.id}/helpful`, {}, "random-bob");
check("helpful votes count once per person", voted.json.helpful === 1, String(voted.json.helpful));
await post(`/api/marketplace/reviews/${review.json.id}/helpful`, {}, "carol");
const unvoted = await call("DELETE", `/api/marketplace/reviews/${review.json.id}/helpful`, null, "carol");
check("votes can be taken back", unvoted.json.helpful === 1, String(unvoted.json.helpful));

// --- Catalog --------------------------------------------------------------------------
const detail = (await get(`/api/marketplace/listing?id=${encodeURIComponent(agentId)}`)).json;
check("listing shows rating and aspects", detail.rating.average === 5 && detail.rating.count === 1 && detail.rating.aspects.prClarity === 4, JSON.stringify(detail.rating));
check("listing shows its reviews with replies and votes", detail.reviews[0]?.reply?.by === "builder-bea" && detail.reviews[0]?.helpful === 1);
check("Shoal metrics: survived, uptime, time to fix", detail.shoal.survived === 1 && detail.shoal.uptime === 1 && detail.shoal.avgTimeToFixMs > 0, JSON.stringify({ s: detail.shoal.survived, u: detail.shoal.uptime, t: detail.shoal.avgTimeToFixMs }));
check("verified languages come from real fixes", detail.verifiedLanguages.includes("JavaScript/TypeScript"), JSON.stringify(detail.verifiedLanguages));

const topRated = (await get("/api/marketplace?sort=top_rated")).json;
check("top_rated sort puts the reviewed agent first", topRated.items[0].id === agentId);
const best = (await get("/api/marketplace")).json;
check("default sort is the verified record", best.sort === "best" && best.items[0].id === agentId, best.items.slice(0, 3).map((i) => i.id).join(" "));
const filtered = (await get("/api/marketplace?minStars=4&hasReviews=true&type=agent")).json;
check("star + review filters", filtered.total === 1 && filtered.items[0].id === agentId, String(filtered.total));
const survivors = (await get("/api/marketplace?minSurvival=0.9&minVerified=1")).json;
check("performance filters", survivors.items.every((i) => i.shoal.survivalRate >= 0.9 && i.shoal.verified >= 1) && survivors.total >= 1);
const js = (await get(`/api/marketplace?language=${encodeURIComponent("JavaScript/TypeScript")}`)).json;
check("language filter", js.items.some((i) => i.id === agentId));
const builders = (await get("/api/marketplace?provider=builder")).json;
check("provider filter", builders.total === 1);
const paged = (await get("/api/marketplace?limit=5&offset=5")).json;
check("paging", paged.items.length === 5 && paged.offset === 5 && paged.total > 10, `${paged.total} total`);
const badSort = await get("/api/marketplace?sort=random");
check("unknown sort refused", badSort.status === 400);

// --- OpenRouter import ----------------------------------------------------------------
const imported = await post("/api/marketplace/openrouter", { id: "z-ai/glm-5.3" }, "team-alice");
check("import an OpenRouter model", imported.status === 201 && imported.json.openrouter?.benchmarks?.coding != null, imported.json.error ?? imported.json.id);
const tools = (await get("/api/marketplace?provider=openrouter&tools=true&minContext=100000")).json;
check("OpenRouter filters", tools.items.some((i) => i.id === "openrouter:z-ai/glm-5.3"));
const removeOther = await call("DELETE", "/api/marketplace/listing?id=openrouter:z-ai/glm-5.3", null, "random-bob");
check("only whoever imported it can remove it", removeOther.status === 403);

webhook.close();
console.log(ok ? "\nAll marketplace checks passed" : "\nSome checks FAILED");
process.exit(ok ? 0 : 1);
