// Read-only review of real model submissions. Previews serve static snapshots
// on their own loopback origin; repository scripts are never started.
import http from 'node:http';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { state } from './store.js';
import { getSource, listAllFiles } from './repo.js';
import { inScope, isSecret } from './scope.js';
import { MODELS, pickForProblem } from './trials.js';
import { diffFiles, proofFor } from './proof.js';
import { nameFor } from './marketplace.js';
import { zip } from './zip.js';
import { MOCK } from './agents.js';
import { isSealed, brief, publicLadder } from './api-trials.js';
import { isActive } from './repos.js';

const error = (status, message) => Object.assign(new Error(message), { status });
export function safeReviewPath(input) {
  const p = String(input).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.includes(':') || /[\x00-\x1f]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.')) || isSecret(p) || /(^|\/)(node_modules|secrets?|credentials?)(\/|$)/i.test(p)) throw error(400, 'This file cannot be included in a fix review');
  return p;
}
async function baseRead(p, binary = false, directory = getSource().dir) {
  p = safeReviewPath(p);
  const root = await realpath(directory);
  const file = await realpath(path.join(root, p));
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw error(400, 'File is outside the repository');
  return readFile(file, binary ? undefined : 'utf8');
}
function patchFiles(fix) {
  return (fix.files || []).map(f => {
    const p = safeReviewPath(f.path);
    if (fix.active !== false && !inScope(p)) throw error(403, 'This fix includes files outside the shared code');
    return { path: p, content: String(f.content) };
  });
}
function records(painId, bountyId) {
  const bounty = bountyId && state.bounties.find(b => b.id === bountyId);
  if (bountyId && (!bounty || bounty.painId !== painId)) throw error(404, 'Bounty not found for this problem');
  const trials = bounty && !isActive(bounty) ? [] : state.trials.filter(t => t.painId === painId).map(t => ({ ...t, key: t.id, kind: 'trial', model: t.model, passed: t.status === 'passed', locked: isSealed(t), proof: state.proofs[t.id] || null }));
  const races = (bounty ? [bounty] : state.bounties.filter(b => b.painId === painId)).flatMap(b => (b.attempts || []).map((a, i) => ({ ...a, key: `${b.id}~${i}`, kind: 'race', active: isActive(b), reviewRoot: b.repo?.dir, locked: isSealed(state.trials.find(t => t.id === b.trialId)), model: a.agentId, winner: a.passed && a.agentId === b.winner, status: a.passed ? 'passed' : 'failed', proof: null })));
  return [...trials, ...races];
}
export function resolveFix(key) {
  const trial = state.trials.find(t => t.id === key);
  if (trial) { if (isSealed(trial)) throw error(403, 'This fix is sealed. Unlock it in Model trials before viewing code or previews.'); return { ...trial, key, kind: 'trial', passed: trial.status === 'passed' }; }
  for (const b of state.bounties) {
    const index = key.startsWith(b.id + '~') ? Number(key.slice(b.id.length + 1)) : -1;
    if (Number.isInteger(index) && index >= 0 && b.attempts?.[index]) { if (isSealed(state.trials.find(t => t.id === b.trialId))) throw error(403, 'This fix is sealed. Unlock it in Model trials before viewing code or previews.'); return { ...b.attempts[index], key, active: isActive(b), reviewRoot: b.repo?.dir, model: b.attempts[index].agentId, painId: b.painId, testFile: b.testFile, kind: 'race' }; }
  }
  throw error(404, 'This model attempt is no longer available');
}
export async function reviewFor(painId, bountyId) {
  const pain = state.pains.find(p => p.id === painId) || state.bounties.find(b => b.painId === painId);
  if (!pain) throw error(404, 'Problem not found');
  const rows = records(painId, bountyId);
  const bounty = bountyId && state.bounties.find(b=>b.id===bountyId);
  const active = !bounty || isActive(bounty);
  const proven = active && proofFor(painId).proven;
  const winner = rows.find(r => r.winner);
  const suggested = active && pickForProblem(painId);
  const pick = suggested && !['not_proven', 'unsafe'].includes(state.proofs[suggested.trial.id]?.verdict) ? suggested : null;
  const best = proven ? { key: proven.trialId, model: proven.model, label: 'Best proven model', reason: 'Passed the complete proof report, including challenge tests and both judges.' } : winner ? { key: winner.key, model: winner.model, label: 'Race winner', reason: 'Selected by the race after verification and judging.' } : pick ? { key: pick.trial.id, model: pick.model, label: 'Best verified candidate', reason: `${pick.reason || 'Recommended by the model comparison.'} The complete proof report has not passed yet.` } : null;
  const attempts = await Promise.all(rows.map(async r => {
    let files = [], issue = null;
    try { files = patchFiles(r); } catch (err) { issue = err.message; }
    // Original source, not the workspace where another winning patch may be applied.
    let changes = await diffFiles(files, p=>baseRead(p,false,r.reviewRoot));
    if(r.locked) changes={...changes,files:changes.files.map(({hunks,...f})=>({...f,hunks:[]}))};
    const safeText = value => r.locked ? brief(value) : value;
    const judges = (r.proof?.checks?.review?.judges || r.judges || []).map(j=>({model:j.model,name:j.name,status:j.status,ok:j.ok,via:j.via,summary:safeText(j.summary)}));
    const checks = Object.fromEntries(['stress','suite','rules','challenge'].map(k=>{const c=r.proof?.checks?.[k];return[k,c?{ok:c.ok,total:c.total,passed:c.passed}:null];}));
    return { key:r.key,kind:r.kind,apiTrial:r.kind==='trial'&&r.apiCost!=null,locked:Boolean(r.locked),simulated:r.kind==='race'&&MOCK,model:r.model,name:MODELS[r.model]?.name||nameFor(r.model),status:r.status,passed:Boolean(r.passed),reason:safeText(r.reason||issue),failureLog:r.locked?null:(r.failureLog||null),summary:safeText(r.summary)||'No fix was delivered.',runs:r.runs||[],durationMs:r.durationMs??null,judges,proof:r.proof?{status:r.proof.status,verdict:r.proof.verdict,score:r.proof.score,failures:r.proof.failures?.map(safeText),checks}:null,changes,canPreview:files.length>0&&!issue&&!r.locked,recommended:best?.key===r.key };
  }));
  if (best && winner && !proven && MOCK) { best.label = 'Simulated race winner'; best.reason = 'This race used simulated agents. Its result is not evidence of live model performance.'; }
  return { painId,testFile:pain.testFile,repository:bounty?.repo?.fullName||state.connection.fullName,best,attempts,execution:'api',ladder:active?publicLadder(painId):null,comparisonBase:'Compared with the connected repository source. A passed trial still needs its complete proof report.' };
}
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.wasm':'application/wasm' };
export async function snapshotFor(key, assetsOnly = false) {
  const fix = resolveFix(key), patch = new Map(patchFiles(fix).map(f => [f.path, Buffer.from(f.content)]));
  if (!patch.size) throw error(409, 'This attempt did not deliver a project to preview');
  const map = new Map(); let bytes = 0;
  const paths = [...new Set([...(await listAllFiles(fix.reviewRoot || getSource().dir)), ...patch.keys()])];
  for (const p of paths) {
    try { safeReviewPath(p); } catch { continue; }
    if (assetsOnly && !MIME[path.extname(p).toLowerCase()]) continue;
    const data = patch.get(p) || await baseRead(p, true, fix.reviewRoot);
    bytes += data.length;
    if (bytes > 40 * 1024 * 1024 || map.size >= 4000) throw error(413, 'Project is too large for an inline preview. Download the repository instead.');
    map.set(p, data);
  }
  return { fix, map };
}
export async function downloadFix(key) {
  const { map } = await snapshotFor(key);
  return zip([...map].map(([path, data]) => ({ path, data })));
}
export function previewEntries(map, testFile) {
  const parent = path.posix.dirname(testFile || '');
  const score = p => { const a = path.posix.dirname(p).split('/'), b = parent.split('/'); let n=0; while(n<a.length && a[n]===b[n]) n++; return n*10 + (path.posix.basename(p)==='index.html'?1:0); };
  return [...map.keys()].filter(p => p.endsWith('.html')).sort((a,b) => score(b)-score(a) || a.localeCompare(b));
}
const previews = new Map();
export async function startPreview(key, entry) {
  const { fix, map } = await snapshotFor(key, true), entries = previewEntries(map, fix.testFile);
  if (!entries.length) return { supported: false, message: 'This repository has no HTML page to display. Review the code changes or download the fixed project. Server applications need their own development server.', entries: [] };
  entry = entry || entries[0];
  if (!entries.includes(entry)) throw error(400, 'Choose an HTML page from this project');
  if (/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\.(?:jsx|tsx|ts)(?:[?"'])/i.test(map.get(entry).toString())) return { supported: false, entries, message: 'This frontend needs a JSX/TypeScript build before it can run in a static preview. Review the changes or download the fixed project and run its development server.' };
  const digest = createHash('sha256').update(key + entry);
  for (const [p,b] of map) digest.update(p).update(b);
  const cacheKey = digest.digest('hex');
  if (previews.has(cacheKey)) return previews.get(cacheKey).result;
  // A separate origin prevents project scripts from sharing Shoal's DOM/storage.
  while (previews.size >= 5) { const [old, value] = previews.entries().next().value; value.server.close(); clearTimeout(value.timer); previews.delete(old); }
  const directory = path.posix.dirname(entry);
  const server = http.createServer((req,res) => {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}`) { res.writeHead(403); return res.end(); }
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'");
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
    try {
      const url = new URL(req.url,'http://localhost');
      let file = decodeURIComponent(url.pathname).replace(/^\//,'');
      if (!file) file = entry;
      safeReviewPath(file);
      let data = map.get(file), actual = file;
      if (!data && directory !== '.') { actual = `${directory}/${file}`; data = map.get(actual); }
      if (!data) { res.writeHead(404); return res.end('Asset not found. This preview serves static project files only.'); }
      res.setHeader('Content-Type', MIME[path.extname(actual).toLowerCase()] || 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(400); res.end('Invalid path'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  server.unref();
  const result = { supported: true, url: `http://127.0.0.1:${server.address().port}/${entry.split('/').map(encodeURIComponent).join('/')}`, entry, entries, note: 'Static preview with this model’s patch applied. Network access, forms and server-side code are disabled.' };
  const timer = setTimeout(() => { server.close(); previews.delete(cacheKey); }, 15*60_000); timer.unref();
  previews.set(cacheKey,{ server, timer, result });
  return result;
}
export function closePreviews() { for (const v of previews.values()) { clearTimeout(v.timer); v.server.close(); } previews.clear(); }
