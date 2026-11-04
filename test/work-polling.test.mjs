import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { createWorkAnalysis } from '../src/work-analysis.mjs';

const work={id:'WG-POLL',title:'Polling fixture',status:'进行中',commits:[]};
async function fixture(t,options={}) {
  await mkdir('.test-output',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-output/work-poll-'));
  await git(root,['init','-b','main']);
  await mkdir(path.join(root,'.workgraph'));
  await writeFile(path.join(root,'.workgraph/state.json'),JSON.stringify({version:1,works:[work],automation:{enabled:true},analysis:{fingerprint:'before'}}));
  const service=createWorkAnalysis({intervalMs:1e8,collector:async()=>({scope:'incremental'}),runner:async()=>({version:1,works:[work]}),...options});
  t.after(()=>service.close());
  return {root,service};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('five-second status requests share a fifteen-second scan budget and manual runs stay fresh',async t=>{
  let time=0,scans=0;
  const {root,service}=await fixture(t,{now:()=>time,fingerprint:async()=>{scans++;return {fingerprint:'before'};}});
  for(time=0;time<=30000;time+=5000){await service.status(root);await service.wait(root);}
  assert.equal(scans,3,'only t=0, 15s and 30s perform an automatic fingerprint');
  time=30000;
  for(let i=0;i<2;i++){await service.start(root,'update');assert.equal((await service.wait(root)).state,'idle');}
  assert.equal(scans,7,'each explicit run still gets a fresh baseline and recheck');
});

test('scheduler and concurrent status calls coalesce; status never waits for the in-flight fingerprint',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let time=0,scans=0,active=0,maxActive=0;
  const entered=deferred(),release=deferred();
  const {root,service}=await fixture(t,{intervalMs:15000,now:()=>time,fingerprint:async()=>{
    scans++;active++;maxActive=Math.max(maxActive,active);
    if(scans===2){entered.resolve();await release.promise;}
    active--;return {fingerprint:'before'};
  }});
  await service.status(root);await service.wait(root);assert.equal(scans,1);
  time=15000;t.mock.timers.tick(15000);await entered.promise;
  const statuses=await Promise.all(Array.from({length:5},()=>service.status(root)));
  assert.ok(statuses.every(status=>status.state==='idle'));
  assert.equal(scans,2);assert.equal(active,1,'status returns before blocked fingerprint finishes');
  time=30000;t.mock.timers.tick(15000);await service.status(root);
  assert.equal(scans,2,'later scheduler/status requests reuse the pending check');
  release.resolve();await service.wait(root);assert.equal(maxActive,1);
});

test('a manual request joins an in-flight check and performs its own fresh consistency scans without overlap',async t=>{
  let scans=0,active=0,maxActive=0;
  const entered=deferred(),release=deferred();
  const {root,service}=await fixture(t,{fingerprint:async()=>{
    scans++;active++;maxActive=Math.max(maxActive,active);
    if(scans===1){entered.resolve();await release.promise;}
    active--;return {fingerprint:'before'};
  }});
  await service.status(root);await entered.promise;
  const start=service.start(root,'update');
  await service.status(root);assert.equal(scans,1);
  release.resolve();await start;assert.equal((await service.wait(root)).state,'idle');
  assert.equal(scans,3);assert.equal(maxActive,1);
});

test('same-HEAD untracked edits still trigger an update after thirty stable seconds',async t=>{
  let time=0,runs=0;
  const {root,service}=await fixture(t,{now:()=>time,fingerprint:async root=>({head:'unchanged',fingerprint:await readFile(path.join(root,'untracked.txt'),'utf8')}),runner:async()=>{runs++;return {version:1,works:[work]};}});
  await writeFile(path.join(root,'untracked.txt'),'before');
  await service.status(root);await service.wait(root);
  await writeFile(path.join(root,'untracked.txt'),'after');
  for(time=5000;time<=40000;time+=5000){await service.status(root);await service.wait(root);assert.equal(runs,0);}
  time=45000;await service.status(root);await service.wait(root);assert.equal(runs,1);
  const record=JSON.parse(await readFile(path.join(root,'.workgraph/state.json'),'utf8'));
  assert.equal(record.analysis.head,'unchanged');assert.equal(record.analysis.fingerprint,'after');
});

test('throttled scans retain the sixty-second failure backoff and stop after three unchanged failures',async t=>{
  let time=0,runs=0;
  const {root,service}=await fixture(t,{now:()=>time,settleMs:30000,fingerprint:async()=>({fingerprint:'changed'}),runner:async()=>{runs++;throw Error('offline');}});
  for(time=0;time<=210000;time+=5000){await service.status(root);await service.wait(root);}
  assert.equal(runs,3);
  assert.equal((await service.wait(root)).state,'failed');
});
