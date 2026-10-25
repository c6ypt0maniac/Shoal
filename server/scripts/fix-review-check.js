import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { state } from '../src/store.js';
import { setSource } from '../src/repo.js';
import { safeReviewPath, reviewFor, snapshotFor, startPreview, closePreviews, previewEntries } from '../src/fix-review.js';

const root = await mkdtemp(path.join(tmpdir(),'shoal-review-check-'));
await mkdir(path.join(root,'buggy','src'),{recursive:true});
await writeFile(path.join(root,'buggy','index.html'),'<script type="module" src="/game.js"></script>');
await writeFile(path.join(root,'buggy','game.js'),'import { value } from "./src/engine.js"; document.body.textContent=value;');
await writeFile(path.join(root,'buggy','src','engine.js'),'export const value = "broken";');
await writeFile(path.join(root,'.env'),'SECRET=must-not-be-served');
setSource(root);
state.connection={type:'demo',fullName:'review fixture',sharedPaths:[]};
state.pains=[{id:'pain-review',testFile:'buggy/test/engine.test.js',healthy:false}];
state.trials=[{id:'trial-review',painId:'pain-review',testFile:'buggy/test/engine.test.js',model:'claude-haiku-5-5',summary:'Repair engine',files:[{path:'buggy/src/engine.js',content:'export const value = "fixed";'}],status:'passed',runs:[true,true],linesChanged:2,submittedAt:'2026-10-25T00:00:00Z'}];
state.bounties=[{id:'bounty-review',painId:'pain-review',testFile:'buggy/test/engine.test.js',winner:null,attempts:[{agentId:'claude-sonnet-5-5',passed:false,summary:'Unsuccessful fix',reason:'Challenge failed',files:[{path:'buggy/src/engine.js',content:'export const value = "partial";'}],runs:[false]}]}];
test('all model patches are inspectable without changing the source',async()=>{
  const r=await reviewFor('pain-review','bounty-review');
  assert.equal(r.attempts.length,2);assert.equal(r.attempts[1].passed,false);
  assert.equal(r.best.key,'trial-review');assert.match(r.best.label,/candidate/);
  assert.match(r.attempts[0].changes.files[0].hunks[0].lines.find(l=>l.type==='+').text,/fixed/);
  assert.match(r.attempts[0].changes.files[0].hunks[0].lines.find(l=>l.type==='-').text,/broken/);
});
test('full proof is required before calling a candidate proven',async()=>{
  state.proofs['trial-review']={trialId:'trial-review',painId:'pain-review',model:'claude-haiku-5-5',rank:0,status:'done',verdict:'safe',score:100,checks:{review:{judges:[{model:'judge',ok:true}]}},failures:[]};
  const r=await reviewFor('pain-review');assert.equal(r.best.label,'Best proven model');assert.equal(r.attempts[0].judges.length,1);
  state.proofs['trial-review'].verdict='not_proven';assert.equal((await reviewFor('pain-review')).best,null);state.proofs={};
});
test('unknown attempts and mismatched bounties fail explicitly',async()=>{
  await assert.rejects(reviewFor('pain-review','wrong'),e=>e.status===404);
  await assert.rejects(snapshotFor('unknown'),e=>e.status===404);
});
test('path traversal, hidden data, and credential files are rejected',()=>{
  for(const p of ['../secret','buggy/../../a','C:/key','/etc/passwd','.env','x/.env.local','x/secrets/key.json','x/credentials/a','x/a.key'])assert.throws(()=>safeReviewPath(p));
});
test('snapshots contain the chosen patch and never contain secrets',async()=>{
  const {map}=await snapshotFor('trial-review');assert.match(map.get('buggy/src/engine.js').toString(),/fixed/);assert.equal(map.has('.env'),false);
  assert.equal(previewEntries(map,'buggy/test/engine.test.js')[0],'buggy/index.html');
});
test('static preview serves nested root assets from the fixed snapshot',async()=>{
  const p=await startPreview('trial-review');assert.equal(p.supported,true);const origin=new URL(p.url).origin;
  const page=await fetch(p.url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/connect-src 'none'/);
  assert.match(await (await fetch(origin+'/src/engine.js')).text(),/fixed/);
  assert.equal((await fetch(origin+'/.env')).status,400);
  assert.equal((await fetch(origin+'/api/me')).status,404);
  assert.equal((await fetch(origin+'/',{method:'POST'})).status,405);
  assert.equal((await startPreview('trial-review')).url,p.url);
});
test('a bounty on another repo uses its own source instead of the active repo',async()=>{
  const parked=path.join(root,'other');await mkdir(path.join(parked,'buggy','src'),{recursive:true});
  await writeFile(path.join(parked,'buggy','src','engine.js'),'export const value = "other baseline";');
  await writeFile(path.join(parked,'buggy','index.html'),'<h1>Other repository</h1>');
  state.bounties[0].repo={key:'other/repository',type:'github',fullName:'other/repository',dir:parked};
  const r=await reviewFor('pain-review','bounty-review');
  assert.equal(r.attempts.length,1);assert.equal(r.repository,'other/repository');
  assert.match(r.attempts[0].changes.files[0].hunks[0].lines.find(l=>l.type==='-').text,/other baseline/);
  assert.match((await snapshotFor('bounty-review~0')).map.get('buggy/index.html').toString(),/Other repository/);
  delete state.bounties[0].repo;
});
test('sealed fixes stay sealed in reviews, downloads, previews and bounty aliases',async()=>{
  state.trials[0].sealed=true;
  state.trials[0].summary='Repair this. `export const secretPatch = 42`';
  state.bounties[0].trialId='trial-review';
  const r=await reviewFor('pain-review','bounty-review');
  assert.equal(r.attempts[0].locked,true);assert.equal(r.attempts[0].canPreview,false);
  assert.equal(r.attempts[0].changes.files[0].hunks.length,0);assert.doesNotMatch(JSON.stringify(r),/secretPatch|export const value/);
  await assert.rejects(snapshotFor('trial-review'),e=>e.status===403);
  await assert.rejects(startPreview('trial-review'),e=>e.status===403);
  await assert.rejects(snapshotFor('bounty-review~0'),e=>e.status===403);
  state.trials[0].unlockedAt=new Date().toISOString();
  assert.match((await snapshotFor('trial-review')).map.get('buggy/src/engine.js').toString(),/fixed/);
});
test.after(async()=>{closePreviews();await rm(root,{recursive:true,force:true});});
