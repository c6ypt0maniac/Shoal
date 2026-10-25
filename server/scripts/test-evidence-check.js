import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { testEvidence } from '../src/test-evidence.js';
import { withRepo,runTestOnce } from '../src/repo.js';

test('long failure output retains earlier failures and final context within its cap',()=>{
  const names=['pearl collection','jelly cooldown','pause','frame rate','diagonal speed','bounds','restart'];
  const log=names.map(n=>`✖ ${n}\n${'stack detail '.repeat(3000)}`).join('\n')+'\nFINAL_CONTEXT';
  const kept=testEvidence(log);
  for(const n of names)assert.ok(kept.includes(`✖ ${n}`),`${n} was lost`);
  assert.ok(kept.includes('FINAL_CONTEXT'));assert.ok(kept.length<=16000);
});
test('short output is preserved exactly',()=>assert.equal(testEvidence('not ok 1 - collection\nassertion details'),'not ok 1 - collection\nassertion details'));
test('the real test runner preserves multiple failures instead of only the last trace',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'shoal-evidence-'));
  const parentTestContext=process.env.NODE_TEST_CONTEXT;
  try{
    await writeFile(path.join(dir,'fail.test.mjs'),`import test from 'node:test';import assert from 'node:assert/strict';\n${['pearl','damage','pause','movement','diagonal','bounds','restart'].map(n=>`test('${n}',()=>assert.fail('${'trace '.repeat(400)}'));`).join('\n')}`);
    delete process.env.NODE_TEST_CONTEXT;
    const result=await withRepo({workspace:dir,stacks:[],testCommand:JSON.stringify(process.execPath)+' --test'},()=>runTestOnce(dir,'fail.test.mjs'));
    assert.equal(result.passed,false,result.log);
    for(const n of ['pearl','damage','pause','movement','diagonal','bounds','restart'])assert.match(result.log,new RegExp(n));
  }finally{if(parentTestContext!==undefined)process.env.NODE_TEST_CONTEXT=parentTestContext;await rm(dir,{recursive:true,force:true});}
});
