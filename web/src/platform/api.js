// Thin client for the Shoal server (server/src/index.js).
async function req(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const get = (u) => req('GET', u), post = (u, b) => req('POST', u, b ?? {});

export const api = {
  health: () => get('/api/health'),
  me: () => get('/api/me'),
  connection: () => get('/api/connection'),
  repos: () => get('/api/github/repos'),
  connect: (repo) => post('/api/connect', { repo }),
  connectDemo: () => post('/api/connect/demo'),
  scan: () => post('/api/scan'),
  pains: () => get('/api/pains'),
  bounties: () => get('/api/bounties'),
  postBounty: (painId, reward) => post('/api/bounties', { painId, reward }),
  fund: (id) => post('/api/bounties/' + id + '/fund'),
  bids: (id) => post('/api/bounties/' + id + '/bids'),
  run: (id) => post('/api/bounties/' + id + '/run'),
  demo: (reward) => post('/api/demo', { reward }),
  agents: () => get('/api/agents'),
  enableAgent: (id, enabled) => post('/api/agents/' + id + '/enabled', { enabled }),
  publishAgent: (agent) => post('/api/agents', agent),
  trials: () => get('/api/trials'),
  runTrials: () => post('/api/trials/run'),
  stopTrials: () => post('/api/trials/stop'),
  credits: () => get('/api/credits'),
  buyCredits: (dollars) => post('/api/credits/buy', { dollars }),
  ledger: () => get('/api/ledger'),
  settlement: () => get('/api/settlement'),
  reset: () => post('/api/reset'),
  events: (after) => get('/api/events/poll?after=' + after),
};
