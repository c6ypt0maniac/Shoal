// Plug Shoal's API keys in: walks through each outside API, asks for its keys
// (typed hidden), checks them live against the API, and writes them to
// server/.env. Other lines in .env, and comments, are kept as they are.
//   npm run keys                    set up everything, one API at a time
//   npm run keys -- openai stripe   just these
//   npm run keys -- --check         check what's in .env, change nothing
// Keys are never printed; only their last 4 characters.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { INTEGRATIONS, checkIntegration, configured, shapeProblem } from "../src/integrations.js";

const ENV_FILE = process.env.SHOAL_ENV_FILE ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.env");
const EXAMPLE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.env.example");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const named = args.filter((a) => !a.startsWith("--"));
const unknown = named.filter((n) => !INTEGRATIONS.some((i) => i.id === n));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(", ")}. Choose from ${INTEGRATIONS.map((i) => i.id).join(", ")}`);
  process.exit(1);
}
const chosen = named.length ? INTEGRATIONS.filter((i) => named.includes(i.id)) : INTEGRATIONS;

// --- .env, line by line ---------------------------------------------------

if (!existsSync(ENV_FILE) && !checkOnly) copyFileSync(EXAMPLE, ENV_FILE);
let lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
const env = {};
for (const line of lines) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
  if (m) env[m[1]] = unquote(m[2]);
}

function setVar(name, value) {
  env[name] = value;
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
  // Set it where it is, or uncomment the example line, or add it at the end.
  const commented = lines.findIndex((l) => new RegExp(`^#\\s*${name}\\s*=`).test(l));
  if (at >= 0) lines[at] = line;
  else if (commented >= 0) lines[commented] = line;
  else if (lines.at(-1) === "") lines.splice(-1, 0, line);
  else lines.push(line);
}

// Only this user can read it.
const save = () => {
  writeFileSync(ENV_FILE, lines.join("\n"));
  chmodSync(ENV_FILE, 0o600);
};

const mask = (v) => (!v ? "not set" : v.length <= 8 ? "set" : `set, ends ...${v.slice(-4)}`);
const icon = (ok) => (ok === true ? "OK  " : ok === false ? "FAIL" : "--  ");

// --- Check only -------------------------------------------------------------

if (checkOnly) {
  if (!existsSync(ENV_FILE)) console.log("No server/.env yet: run npm run keys to make one.\n");
  // Real environment variables win, so env pulled from Vercel can be checked too.
  const all = { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
  const results = await Promise.all(chosen.map(async (i) => [i, await checkIntegration(i, all)]));
  for (const [i, r] of results) console.log(`${icon(r.ok)}  ${i.name.padEnd(20)} ${r.detail}`);
  const failed = results.filter(([, r]) => r.ok === false).length;
  const off = results.filter(([, r]) => r.ok === null).map(([i]) => i.id);
  console.log(`\n${failed ? `${failed} failed.` : "Everything that's set works."}${off.length ? ` Not set: ${off.join(", ")} (npm run keys -- ${off[0]}).` : ""}`);
  process.exit(failed ? 1 : 0);
}

// --- Interactive ------------------------------------------------------------

if (!process.stdin.isTTY) {
  console.error("Run this in a terminal (it asks for keys), or use --check.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Hide what's typed for secrets: once the prompt is out, echo nothing until Enter.
let hidden = false;
rl._writeToOutput = (s) => hidden || rl.output.write(s);
const ask = (q, secret = false) =>
  new Promise((resolve) => {
    rl.question(q, (a) => {
      hidden = false;
      if (secret) process.stdout.write(a ? "(hidden)\n" : "\n");
      resolve(a.trim());
    });
    hidden = secret;
  });

console.log(`Plugging in Shoal's APIs. Keys go to ${ENV_FILE} (gitignored).`);
console.log("Press Enter to keep what's there, type - to clear it.\n");

for (const i of chosen) {
  const before = await checkIntegration(i, env);
  console.log(`== ${i.name}: ${i.turnsOn}`);
  console.log(`   Get it: ${i.where}`);
  console.log(`   Now: ${icon(before.ok).trim() || "--"} ${before.detail}`);
  if (before.ok && (await ask("   Change it? [y/N] ")).toLowerCase() !== "y") {
    console.log("");
    continue;
  }
  if (!configured(i, env) && !named.length && (await ask("   Set it up now? [Y/n] ")).toLowerCase() === "n") {
    console.log("");
    continue;
  }

  for (let tries = 0; tries < 3; tries++) {
    for (const v of i.vars) {
      if (v.generate && !env[v.name]) {
        setVar(v.name, randomBytes(32).toString("hex"));
        console.log(`   ${v.name}: generated`);
        continue;
      }
      let value;
      for (;;) {
        value = await ask(`   ${v.name} (${mask(env[v.name])}${v.optional ? ", optional" : ""}${v.hint ? `: ${v.hint}` : ""}): `, v.secret);
        const problem = value && value !== "-" ? shapeProblem(v, value) : null;
        if (!problem) break;
        console.log(`   ${problem}`);
      }
      if (value === "-") setVar(v.name, "");
      else if (value) setVar(v.name, value);
    }
    if (!configured(i, env)) {
      console.log("   Left unset.");
      break;
    }
    process.stdout.write("   Checking... ");
    const r = await checkIntegration(i, env);
    console.log(`${icon(r.ok).trim()} ${r.detail}`);
    if (r.ok) break;
    if ((await ask("   Try again? [Y/n] ")).toLowerCase() === "n") break;
  }
  save();
  console.log("");
}

rl.close();
save();
console.log("Saved. Restart the server to pick the keys up.");
console.log("On Vercel, add the same variables under Project -> Settings -> Environment Variables,");
console.log("or check them from here with: vercel env pull .env.vercel && node --env-file=.env.vercel scripts/keys.js --check");
