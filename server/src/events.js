// Event log that powers the live ticker. Every step of the bounty lifecycle
// is recorded here; pages poll for events newer than the last one they saw.
// Each user has their own log (store.js scoped): an event goes to the user
// whose request or background work emitted it.
import { currentWorkspace, scoped } from "./store.js";

const HISTORY_LIMIT = 500;
// history, the last id, and long-poll requests waiting for the next event.
const log = () => scoped("events", () => ({ history: [], seq: 0, waiters: new Set() }));

// Forget the activity history (account deletion). Ids keep counting up, so
// open pages just see the next event.
export function clearEvents() {
  log().history.length = 0;
}

export function emit(type, data = {}) {
  const { history, waiters } = log();
  const event = { id: ++log().seq, type, at: new Date().toISOString(), ...data };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
  console.log(`[${type}]${currentWorkspace().login === "local" ? "" : ` @${currentWorkspace().login}`}`, data.message ?? "");
  for (const wake of waiters) wake();
  return event;
}

// Resolves once there's an event after `afterId` (at once if there already
// is, or if the ids started over after a restart), or after `ms`. Events
// come in bursts, so it waits a beat after the first to send them together.
// `onClose` registers a callback for when the client goes away.
export function waitForEvents(afterId, ms, onClose) {
  const { seq, waiters } = log();
  if (seq !== afterId) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
    const wake = () => { waiters.delete(wake); clearTimeout(timer); timer = setTimeout(done, 40); };
    timer = setTimeout(done, ms);
    waiters.add(wake);
    onClose?.(done);
  });
}

// Events newer than `afterId`, plus the latest id to ask from next time.
// afterId = 0 returns the recent history.
export function eventsAfter(afterId) {
  const { history, seq } = log();
  return { events: history.filter((e) => e.id > afterId), last: seq };
}
