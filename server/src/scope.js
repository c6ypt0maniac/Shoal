// What a team chose to share with agents. Agents only ever see, test, or
// patch files inside the shared folders, and secrets are never shared.
import { state } from "./store.js";

// Never shared, whatever the team picks.
const NEVER_SHARE = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)(secrets?|credentials?)(\/|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/,
];

export const isSecret = (p) => NEVER_SHARE.some((re) => re.test(p));

// sharedPaths: null/empty = whole repo, otherwise the exact folders and files
// agents may see, e.g. ["src", "src/utils", "test/a.test.js"]. Each folder
// counts on its own, so sharing "src" doesn't share "src/internal".
// "." = files at the repo root.
export function inScope(relPath) {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isSecret(p)) return false;
  if (state.generatedTests?.includes(p)) return true;
  const shared = state.connection.sharedPaths;
  if (!shared?.length) return true;
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
  return shared.includes(dir) || shared.includes(p);
}

export const PROBLEMS = {
  "flaky-tests": { label: "Flaky tests", supported: true },
  "slow-ci": { label: "Slow CI", supported: false },
  "failing-builds": { label: "Failing builds", supported: false },
  "slow-reviews": { label: "Slow PR reviews", supported: false },
  "outdated-deps": { label: "Outdated dependencies", supported: false },
  other: { label: "Something else", supported: false },
};

export function cleanProblems(input) {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((p) => (typeof p === "string" ? { id: p } : p))
    .filter((p) => PROBLEMS[p?.id])
    .map((p) => ({ id: p.id, label: PROBLEMS[p.id].label, supported: PROBLEMS[p.id].supported, note: String(p.note ?? "").slice(0, 300) }));
}

export function cleanSharedPaths(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((p) => String(p).replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "") || "."))]
    .filter((p) => p === "." || !p.split("/").includes(".."));
}
