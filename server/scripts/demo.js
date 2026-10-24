// Terminal walkthrough of the full loop against a running server:
//   npm start   (in one terminal)
//   npm run demo
const BASE = process.env.SHOAL_URL ?? "http://localhost:4000";

const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await post("/api/reset");
} catch {
  console.error(`Can't reach the Shoal server at ${BASE}. Start it first in another terminal with: npm start`);
  process.exit(1);
}

// Only print events from here on.
let { last } = await fetch(`${BASE}/api/events/poll`).then((r) => r.json());

console.log("Scanning repo...");
const pains = await post("/api/scan");
for (const p of pains) {
  console.log(`  ${p.healthy ? "ok   " : "FLAKY"} ${p.testFile.padEnd(22)} ${p.failures}/${p.runs} failed  ~${p.hoursPerWeek} h/week`);
}
const worst = pains.find((p) => !p.healthy);
if (!worst) {
  console.log("Nothing flaky this time. Run the demo again.");
  process.exit(0);
}
await post("/api/demo", { painId: worst.id, reward: 400 });

while (true) {
  const { events, last: newest } = await fetch(`${BASE}/api/events/poll?after=${last}`).then((r) => r.json());
  last = newest;
  for (const e of events) {
    if (e.type.startsWith("scan") || e.type === "reset") continue;
    const runs = e.results ? "  " + e.results.map((ok) => (ok ? "🟢" : "🔴")).join("") : "";
    console.log(`[${e.type}] ${e.message}${runs}`);
    if (e.type === "bounty.settled" || e.type === "bounty.failed") {
      await sleep(300);
      console.log("\nMorning Settlement:", await fetch(BASE + "/api/settlement").then((r) => r.json()));
      process.exit(0);
    }
  }
  await sleep(500);
}
