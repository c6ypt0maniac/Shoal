// End-to-end check of the core bounty loop on the bundled demo repo, with
// mock agents and simulated escrow (no keys, no spend):
//   bids, then private parallel attempts -> only the winner's fix is shown ->
//   charged, payout pending -> survival checks on the fix as delivered: the
//   team's own changes (reverting it, deleting the test) only warn, while a
//   fix that fails on its own code is clawed back and refunded -> a fix that
//   survives its window is paid -> scorecards
//   count each outcome -> bounties and ledger are saved to disk.
//   node scripts/survival-check.js
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";

process.env.PORT = "4107";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_MOCK_JUDGES = "1"; // stand-in judges: never spend anyone's Claude/ChatGPT plan or API credit
process.env.SHOAL_DATA_DIR = await mkdtemp(path.join(tmpdir(), "shoal-survival-"));
process.env.SHOAL_WORKSPACE = ".workspace-survivalcheck";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SHOAL_SURVIVAL_MINUTES;

await import("../src/index.js");
const { workspaceDir, DEMO_REPO } = await import("../src/repo.js");
const WORKSPACE = workspaceDir();
const { checkSurvivors } = await import("../src/survival.js");
const { state } = await import("../src/store.js");

const BASE = "http://localhost:4107";
// The built-in persona agents: this check is about their behaviour (bounties
// default to the Claude models otherwise).
const PERSONAS = ["flakehunter", "rootcause", "speedy"];
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const api = async (p, body) => {
  const res = await fetch(BASE + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return res.json();
};
const waitFor = async (id, statuses) => {
  for (let i = 0; i < 300; i++) {
    const b = await api(`/api/bounties/${id}`);
    if (statuses.includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`bounty ${id} never reached ${statuses}`);
};

console.log("Scanning the demo repo...");
await api("/api/scan", {});
const pains = await api("/api/pains");
const cart = pains.find((p) => p.testFile === "test/cart.test.js");
const orders = pains.find((p) => p.testFile === "test/orders.test.js");
check("scan found both flaky tests", Boolean(cart && orders && !cart.healthy && !orders.healthy));
// A git repo, like a connected GitHub repo, so survival windows freeze it.
const git = (cmd) => execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd: WORKSPACE, stdio: "pipe" }).toString().trim();
git("init -q");
git("add -A");
git("commit -qm demo");

// --- 1. Competition, then a regression inside the window ---------------------
const bad = await api("/api/bounties", { painId: cart.id, reward: 300, competitors: PERSONAS, survivalDays: 21 });
check("survival window must be 7, 10 or 14 days", /7, 10, 14/.test(bad.error ?? ""), bad.error);

const first = await api("/api/bounties", { painId: cart.id, reward: 300, competitors: PERSONAS, survivalDays: 10 });
await api(`/api/bounties/${first.id}/run`, {});
let b1 = await waitFor(first.id, ["surviving", "failed"]);
check("verified fix enters its survival window", b1.status === "surviving", b1.status);
check("every agent bid and attempted privately", b1.competition.attempts === 3 && b1.bids.length === 3 && b1.bids.every((x) => x.admitted && x.kind === "estimate" && x.amount > 0), JSON.stringify(b1.bids));
check("only the winner's fix is shown", !("attempts" in b1) && b1.winningAttempt?.agentId === "rootcause", JSON.stringify(b1.winningAttempt?.agentId));
check("team charged the reward", b1.escrow.status === "charged" && b1.escrow.charged === 300, JSON.stringify(b1.escrow));
check("window is 10 days", Math.round((Date.parse(b1.survival.endsAt) - Date.parse(b1.survival.startedAt)) / 86_400_000) === 10);
let ledger = await api("/api/ledger");
check("agent payout is pending, not paid", ledger.find((t) => t.bountyId === first.id)?.status === "pending");

b1 = await api(`/api/bounties/${first.id}/survival/check`, {});
check("survival check: still fixed", b1.status === "surviving" && b1.survival.checks.at(-1).ok === true, JSON.stringify(b1.survival.checks.at(-1)));

// New commits: checked only when they touch the test or its imports, at most hourly.
let checked = await checkSurvivors({ trigger: "new commit a", changed: ["README.md"] });
check("a commit that doesn't touch the test or its imports isn't checked", !checked.includes(first.id));
checked = await checkSurvivors({ trigger: "new commit b", changed: ["src/cart.js"] });
check("a commit touching the code the test imports is checked", checked.includes(first.id));
checked = await checkSurvivors({ trigger: "new commit c", changed: ["test/cart.test.js"] });
b1 = await api(`/api/bounties/${first.id}`);
check("a second relevant commit within the hour isn't checked again", !checked.includes(first.id));
check("...and the next scheduled check comes within that hour", Date.parse(b1.survival.nextCheckAt) <= Date.parse(b1.survival.lastCommitCheckAt) + 3_600_000, b1.survival.nextCheckAt);

// The team copies the fix, then puts the original bug back and deletes the
// test: no refund, since the guarantee covers the fix as delivered.
const buggy = await readFile(path.join(DEMO_REPO, "src/cart.js"), "utf8");
await writeFile(path.join(WORKSPACE, "src/cart.js"), buggy);
await rename(path.join(WORKSPACE, "test/cart.test.js"), path.join(WORKSPACE, "test/cart.test.js.gone"));
b1 = await api(`/api/bounties/${first.id}/survival/check`, {});
check("the team reverting the fix or deleting the test isn't a refund", b1.status === "surviving" && b1.escrow.status === "charged" && b1.survival.checks.at(-1).ok === true, JSON.stringify(b1.survival.checks.at(-1)));
check("...but it's flagged", b1.survival.checks.at(-1).drifted?.includes("src/cart.js"), JSON.stringify(b1.survival.checks.at(-1).drifted));
await rename(path.join(WORKSPACE, "test/cart.test.js.gone"), path.join(WORKSPACE, "test/cart.test.js"));
check("checks run on the repo as it was when the fix landed", b1.survival.frozen && b1.survival.checks.at(-1).frozen === true && git(`rev-parse refs/shoal/survival/${first.id}`) === b1.survival.frozen);

// The team breaks a file the fix didn't touch and Shoal didn't pin (the
// package's module type): its own change, so still no refund.
const manifest = await readFile(path.join(WORKSPACE, "package.json"), "utf8");
await writeFile(path.join(WORKSPACE, "package.json"), manifest.replace('"type": "module"', '"type": "commonjs"'));
b1 = await api(`/api/bounties/${first.id}/survival/check`, {});
check("breaking an unpinned file isn't a refund either", b1.status === "surviving" && b1.survival.checks.at(-1).ok === true, JSON.stringify(b1.survival.checks.at(-1)));
await writeFile(path.join(WORKSPACE, "package.json"), manifest);

// The fix itself doesn't hold (it hid the flakiness): stand in for one by
// pinning the original bug as the delivered fix.
state.bounties.find((x) => x.id === first.id).survival.pinned.find((f) => f.path === "src/cart.js").content = buggy;
b1 = await api(`/api/bounties/${first.id}/survival/check`, {});
check("a fix that fails on its own code is clawed back", b1.status === "clawed_back" && b1.survival.status === "regressed", b1.survival.reason);
check("team refunded", b1.escrow.status === "refunded" && b1.escrow.refunded === 300, JSON.stringify(b1.escrow));
let kept = true;
try { git(`rev-parse --verify -q refs/shoal/survival/${first.id}`); } catch { kept = false; }
check("its snapshot is let go once the window is over", !kept);
ledger = await api("/api/ledger");
check("ledger marks it clawed back", ledger.find((t) => t.bountyId === first.id)?.status === "clawed_back");

// --- 2. A fix that survives its window gets paid -----------------------------
process.env.SHOAL_SURVIVAL_MINUTES = "0.02"; // ~1 second windows from here on
const second = await api("/api/bounties", { painId: orders.id, reward: 200, competitors: PERSONAS });
await api(`/api/bounties/${second.id}/run`, {});
let b2 = await waitFor(second.id, ["surviving", "failed"]);
check("second fix verified", b2.status === "surviving", b2.status);
await new Promise((r) => setTimeout(r, 1500));
b2 = await api(`/api/bounties/${second.id}/survival/check`, {});
check("survived the window -> settled", b2.status === "settled" && b2.survival.status === "survived", b2.status);
ledger = await api("/api/ledger");
const paid = ledger.find((t) => t.bountyId === second.id);
check("payout cleared (reward minus 15%)", paid?.status === "paid" && paid.agentPayout === 170 && paid.platformFee === 30, JSON.stringify(paid));

// --- 3. Scorecards and settlement -----------------------------------------------
const board = await api("/api/agents");
const root = board.find((a) => a.id === "rootcause");
const hunter = board.find((a) => a.id === "flakehunter");
check("winner's scorecard: 2 wins, 1 survived, 1 clawback", root.wins === 2 && root.survived === 1 && root.clawbacks === 1 && root.earned === 170, JSON.stringify(root));
check("tampering agent: attempts but nothing verified", hunter.attempts === 2 && hunter.verified === 0, JSON.stringify(hunter));
check("no seeded numbers", board.every((a) => a.attempts <= 2));
check("best record ranks first", board[0].id === "rootcause", board.map((a) => `${a.id}:${a.score}`).join(" "));
const s = await api("/api/settlement");
check("settlement: 1 cleared, 1 clawed back today", s.clearedToday.length === 1 && s.clawedBackToday.length === 1 && s.totalPaid === 170, JSON.stringify(s));

// --- 4. Reconnecting can't drop a window; state is on disk ------------------------
process.env.SHOAL_SURVIVAL_MINUTES = "60";
const orders2 = (await api("/api/pains")).find((p) => p.testFile === "test/cart.test.js");
const third = await api("/api/bounties", { painId: orders2.id, reward: 100, competitors: PERSONAS });
await api(`/api/bounties/${third.id}/run`, {});
await waitFor(third.id, ["surviving", "failed"]);
const blocked = await fetch(`${BASE}/api/reset`, { method: "POST" });
check("reset refused while a fix is in its window", blocked.status === 409, String(blocked.status));
await new Promise((r) => setTimeout(r, 3500));
const saved = JSON.parse(await readFile(path.join(process.env.SHOAL_DATA_DIR, "state.json"), "utf8"));
// Bounties and the ledger are the local user's (persist.js, version 3); scorecards are shared.
const mine = saved.users?.local ?? {};
check("bounties, ledger and scorecards saved to disk", mine.bounties?.length === 3 && mine.ledger?.length === 3 && saved.scorecards.find((c) => c.id === "rootcause")?.wins >= 2, `${mine.bounties?.length} bounties`);

console.log(ok ? "\nAll survival checks passed" : "\nSome checks FAILED");
process.exit(ok ? 0 : 1);
