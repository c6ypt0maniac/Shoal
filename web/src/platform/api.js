// Thin client for the Shoal server (server/src/index.js). In the combined
// deployment the origin is empty. A separately hosted web build sets
// VITE_SHOAL_API_URL to the public backend origin.
const API_ORIGIN = String(import.meta.env.VITE_SHOAL_API_URL || '').replace(/\/$/, '');
export const apiHref = (path) => API_ORIGIN + path;

async function req(method, url, body) {
  const r = await fetch(apiHref(url), {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const get = (u) => req('GET', u), post = (u, b) => req('POST', u, b ?? {}), patch = (u, b) => req('PATCH', u, b ?? {}), del = (u) => req('DELETE', u);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false)).toString();
const id = encodeURIComponent;

export const api = {
  health: () => get('/api/health'),
  me: () => get('/api/me'),
  setRole: (role) => post('/api/me/role', { role }),
  signOut: () => post('/api/auth/github/logout'),
  deleteAccount: () => del('/api/me'),
  mcp: () => get('/api/mcp'),

  // Repo connection
  connection: () => get('/api/connection'),
  ci: () => get('/api/ci'),
  repos: () => get('/api/github/repos'),
  repoFiles: (repo, fresh) => get('/api/repo-files?' + qs({ repo, fresh: fresh ? '1' : '' })),
  problems: () => get('/api/problems'),
  connect: (repo, opts = {}) => post('/api/connect', { repo, ...opts }),
  connectDemo: (opts = {}) => post('/api/connect/demo', opts),
  share: (add) => post('/api/connection/share', { add }),
  sync: () => post('/api/sync'),
  autoSync: (on) => post('/api/sync/auto', { on }),
  scan: () => post('/api/scan'),
  pains: () => get('/api/pains'),
  reset: () => post('/api/reset'),

  // Bounties
  bounties: () => get('/api/bounties'),
  postBounty: (painId, reward, opts = {}) => post('/api/bounties', { painId, reward, ...opts }),
  fund: (b) => post('/api/bounties/' + b + '/fund'),
  run: (b) => post('/api/bounties/' + b + '/run'),
  demoBet: (b, competitor, amount) => post('/api/bounties/' + b + '/bets', { competitor, amount }),
  survivalCheck: (b) => post('/api/bounties/' + b + '/survival/check'),

  // Marketplace (listing ids contain slashes, so single listings go by ?id=)
  agents: () => get('/api/agents'),
  marketplace: (query = {}) => get('/api/marketplace?' + qs(query)),
  listing: (listingId, reviewSort) => get('/api/marketplace/listing?' + qs({ id: listingId, reviewSort })),
  importModel: (openRouterId) => post('/api/marketplace/openrouter', { id: openRouterId }),
  publishListing: (agent) => post('/api/marketplace/agents', agent),
  updateListing: (listingId, changes) => patch('/api/marketplace/agents?id=' + id(listingId), changes),
  rotateSecret: (listingId) => post('/api/marketplace/agents/rotate-secret?id=' + id(listingId)),
  removeListing: (listingId) => del('/api/marketplace/listing?id=' + id(listingId)),
  review: (r) => post('/api/marketplace/reviews', r),
  reply: (reviewId, body) => post('/api/marketplace/reviews/' + id(reviewId) + '/reply', { body }),
  helpful: (reviewId, on) => (on ? post : del)('/api/marketplace/reviews/' + id(reviewId) + '/helpful'),

  // Model trials and the approved API fix
  trials: () => get('/api/trials'),
  claude: (fresh) => get('/api/claude' + (fresh ? '?fresh=1' : '')),
  claudeLogin: () => post('/api/claude/login'),
  claudeCode: (code) => post('/api/claude/login/code', { code }),
  codex: (fresh) => get('/api/codex' + (fresh ? '?fresh=1' : '')),
  codexLogin: () => post('/api/codex/login'),
  runTrials: (use) => post('/api/trials/run', use ? { use } : {}),
  stopTrials: () => post('/api/trials/stop'),
  approve: (painId) => post('/api/trials/approve', { painId }),
  prove: (painId) => post('/api/proofs', { painId }),

  // Money
  credits: () => get('/api/credits'),
  buyCredits: (dollars) => post('/api/credits/buy', { dollars }),
  ledger: () => get('/api/ledger'),
  settlement: () => get('/api/settlement'),

  // wait: seconds the server may hold the request until something happens (long-poll).
  events: (after, wait = 0) => get('/api/events/poll?after=' + after + (wait ? '&wait=' + wait : '')),
};
