// Thin client for the Shoal server (server/src/index.js).
// The server isn't answering (stopped, or restarting): say so, not the browser's "Load failed".
export const OFFLINE = "Can't reach the Shoal server. If it isn't running, start it with npm start.";
export const apiHref = path => String(import.meta.env.VITE_SHOAL_API_URL || '').replace(/\/$/, '') + path;

async function req(method, url, body) {
  let r;
  try {
    r = await fetch(apiHref(url), { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw Object.assign(new Error(OFFLINE), { offline: true });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data });
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

  // Saved payment method (set up once, used for every bounty)
  billing: () => get('/api/billing'),
  setupBilling: (from) => post('/api/billing/setup', { from }),
  billingLater: () => post('/api/billing/later'),
  removeBilling: () => del('/api/billing'),

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
  fixes: (painId,bountyId)=>get('/api/problems/'+id(painId)+'/fixes?'+qs({bountyId})),
  previewFix: (key,entry)=>post('/api/fixes/'+id(key)+'/preview',{entry}),
  createFixPullRequest: key=>post('/api/fixes/'+id(key)+'/pull-request'),
  fixDownload: key=>apiHref('/api/fixes/'+id(key)+'/repo'),
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
  sealedTrials: (painId) => post('/api/trials/sealed', painId ? { painId } : {}),
  unlock: (trialId) => post('/api/trials/' + id(trialId) + '/unlock', {}),
  authorize: (painId) => post('/api/trials/authorize', { painId }),
  deleteBounty: (bountyId) => del('/api/bounties/' + id(bountyId)),
  buildFix: (bountyId, model) => post('/api/bounties/' + id(bountyId) + '/build', model ? { model } : {}),
  prove: (painId) => post('/api/proofs', { painId }),

  // Money
  credits: () => get('/api/credits'),
  buyCredits: (dollars) => post('/api/credits/buy', { dollars }),
  ledger: () => get('/api/ledger'),
  settlement: () => get('/api/settlement'),

  // wait: seconds the server may hold the request until something happens (long-poll).
  events: (after, wait = 0) => get('/api/events/poll?after=' + after + (wait ? '&wait=' + wait : '')),
};
