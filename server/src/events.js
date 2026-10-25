// Event log that powers the live ticker. Every step of the bounty lifecycle
// is recorded here; pages poll for events newer than the last one they saw.

const history = [];
const listeners = [];

// Other code (Slack, Jira, Linear) follows the lifecycle by subscribing here.
export const onEvent = (fn) => listeners.push(fn);
const HISTORY_LIMIT = 500;
let seq = 0;

export function emit(type, data = {}) {
  const event = { id: ++seq, type, at: new Date().toISOString(), ...data };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
  console.log(`[${type}]`, data.message ?? "");
  for (const fn of listeners) {
    try {
      Promise.resolve(fn(event)).catch(() => {});
    } catch {}
  }
  return event;
}

// Events newer than `afterId`, plus the latest id to ask from next time.
// afterId = 0 returns the recent history.
export function eventsAfter(afterId) {
  return { events: history.filter((e) => e.id > afterId), last: seq };
}
