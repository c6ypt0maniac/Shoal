// Live check of OpenAI paid runs: asks each OpenAI model for a tiny fix
// through the same code path as a paid run (agents.js openaiFix) and prints
// whether it worked and what it cost. Needs OPENAI_API_KEY in .env.
//   npm run smoke:openai                     every model except the Pro ones
//   npm run smoke:openai -- --pro            include Pro models (slow, pricier)
//   npm run smoke:openai -- gpt-6-astra o3   just these
// Uses low reasoning effort to keep it cheap (paid runs use high); the
// request shape is otherwise identical. Expect well under $1 without --pro.
import { MODELS, OPENAI_MODEL_IDS } from "../src/trials.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY in server/.env first.");
  process.exit(1);
}
const { openaiFix } = await import("../src/agents.js");

const args = process.argv.slice(2);
const named = args.filter((a) => !a.startsWith("--"));
const isPro = (id) => /-pro$/.test(id);
const models = named.length ? named : OPENAI_MODEL_IDS.filter((id) => args.includes("--pro") || !isPro(id));
const unknown = models.filter((m) => !MODELS[m] || MODELS[m].provider !== "openai");
if (unknown.length) {
  console.error(`Not OpenAI models in trials.js: ${unknown.join(", ")}`);
  process.exit(1);
}

const PROMPT = [
  "Fix the failing test test/add.test.js: it expects add(2, 3) to be 5.",
  "Repository files:\n--- src/add.js ---\nexport const add = (a, b) => a - b;\n",
  "Return the complete new contents of every file you change (paths relative to the repo root). Only include files you actually change.",
].join("\n\n");

let total = 0;
let failures = 0;
const results = await Promise.all(
  models.map(async (model) => {
    const started = Date.now();
    try {
      const { fix, cost } = await openaiFix(model, PROMPT, { effort: "low" });
      const fixed = fix.files.some((f) => f.path.endsWith("add.js") && /a\s*\+\s*b/.test(f.content));
      return { model, ok: fixed, cost, secs: (Date.now() - started) / 1000, note: fixed ? fix.summary : `unexpected fix: ${JSON.stringify(fix).slice(0, 120)}` };
    } catch (err) {
      return { model, ok: false, cost: err.cost ?? 0, secs: (Date.now() - started) / 1000, note: err.message };
    }
  }),
);
for (const r of results) {
  total += r.cost;
  if (!r.ok) failures++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.model.padEnd(14)} $${r.cost.toFixed(5)}  ${r.secs.toFixed(1)}s  ${String(r.note).slice(0, 140)}`);
}
console.log(`\n${models.length - failures}/${models.length} models worked · total cost $${total.toFixed(4)}`);
process.exit(failures ? 1 : 0);
