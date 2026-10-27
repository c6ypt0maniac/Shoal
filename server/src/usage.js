// Fair-use limits. Trials and fixes are free on Shoal (teams pay their own
// model tokens), but every scan, verification and survival check runs the
// team's tests on Shoal's server, and that CPU is shared by everyone. So each
// account gets a budget instead of a bill:
//   SHOAL_TRIALS_PER_DAY      sealed trial runs started per day (default 10)
//   SHOAL_SCANS_PER_HOUR      repo scans per hour (default 6)
//   SHOAL_RUNNING_BOUNTIES    bounties racing or verifying at once (default 3)
// The local user (a server or desktop app run for one person) has no limits:
// it's their own machine.
import { LOCAL, currentWorkspace, state } from "./store.js";
import { envLimit } from "./limit.js";

const HOUR = 60 * 60_000, DAY = 24 * HOUR;
const RUNNING = ["diagnosing", "awaiting_go_ahead", "competing", "verifying", "judging"];
const httpError = (status, message) => Object.assign(new Error(message), { status });
const limited = () => currentWorkspace().login !== LOCAL;

// Recent uses of one kind, oldest dropped (kept with the user's data).
function recent(kind, windowMs) {
  const since = Date.now() - windowMs;
  state.usage[kind] = (state.usage[kind] ?? []).filter((at) => Date.parse(at) > since);
  return state.usage[kind];
}

// Why this user can't do it right now, or null. "trials" | "scans" | "bounties".
export function overLimit(kind) {
  if (!limited()) return null;
  if (kind === "bounties") {
    const max = envLimit("SHOAL_RUNNING_BOUNTIES", 3);
    return state.bounties.filter((b) => RUNNING.includes(b.status)).length >= max ? `You can have ${max} bounties running at once. Wait for one to finish.` : null;
  }
  const [max, windowMs, per] = kind === "trials" ? [envLimit("SHOAL_TRIALS_PER_DAY", 10), DAY, "a day"] : [envLimit("SHOAL_SCANS_PER_HOUR", 6), HOUR, "an hour"];
  const used = recent(kind, windowMs);
  if (used.length < max) return null;
  const free = new Date(Date.parse(used[0]) + windowMs);
  return `You've used your ${max} ${kind === "trials" ? "trial runs" : "scans"} for ${per}. More at ${free.toISOString().slice(11, 16)} UTC.`;
}

// Throws a 429 when over the limit; otherwise counts this use.
export function useOnce(kind) {
  const why = overLimit(kind);
  if (why) throw httpError(429, why);
  if (kind !== "bounties" && limited()) recent(kind, kind === "trials" ? DAY : HOUR).push(new Date().toISOString());
}
