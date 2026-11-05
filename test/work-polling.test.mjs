import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { createWorkAnalysis } from '../src/work-analysis.mjs';

test('legacy automation flags and repeated status reads never scan or launch analysis',async t=>{
  await mkdir('.test-output',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-output/work-manual-'));
  await git(root,['init','-b','main']);
  await mkdir(path.join(root,'.workgraph'));
  await writeFile(path.join(root,'.workgraph/state.json'),JSON.stringify({version:1,works:[],automation:{enabled:true},analysis:{fingerprint:'old'}}));
  let scans=0,runs=0;
  const service=createWorkAnalysis({fingerprint:async()=>{scans++;return {fingerprint:'new'};},collector:async()=>({}),runner:async()=>{runs++;return {version:1,works:[]};}});
  t.after(()=>service.close());
  for(let i=0;i<10;i++){await service.status(root);await service.wait(root);}
  assert.equal(scans,0);assert.equal(runs,0);
  await service.start(root);await service.wait(root);
  assert.equal(scans,2);assert.equal(runs,1);
});
