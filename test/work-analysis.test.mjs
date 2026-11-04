import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { createWorkAnalysis, workFingerprint, runCodexAnalysis } from '../src/work-analysis.mjs';
import { readWorkGraph } from '../src/work-graph.mjs';

const work = {id:'WG-A',title:'existing work',status:'进行中',commits:[]};
test('bare history stays readable but cannot start an analysis',async t=>{
  await mkdir('.test-output',{recursive:true});const root=await mkdtemp(path.resolve('.test-output/analysis-bare-'));
  await git(root,['init','--bare']);const service=createWorkAnalysis();t.after(()=>service.close());
  assert.equal((await readWorkGraph(root)).initialized,false);
  assert.equal((await service.status(root)).state,'unavailable');
  await assert.rejects(()=>service.start(root),/裸仓库/);
});
async function fixture(t,runner,options={}) {
  await mkdir('.test-output',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-output/analysis-'));
  await git(root,['init','-b','main']);
  await writeFile(path.join(root,'code.txt'),'before');
  const service=createWorkAnalysis({runner,intervalMs:1e8,...options});t.after(()=>service.close());
  return {root,service};
}

test('initialization migrates existing work, persists baseline and avoids self-triggering',async t=>{
  let calls=0;
  const {root,service}=await fixture(t,async({previous,mode})=>{calls++;assert.equal(mode,'initialize');return previous;});
  await writeFile(path.join(root,'.workgraph.json'),JSON.stringify({version:1,works:[work]}));
  const before=await workFingerprint(root);
  assert.equal((await service.start(root)).state,'running');
  assert.equal((await service.wait(root)).state,'idle');
  const data=await readWorkGraph(root);assert.equal(data.initialized,true);assert.equal(data.works[0].id,work.id);
  const record=JSON.parse(await readFile(path.join(root,'.workgraph/state.json'),'utf8'));
  assert.equal(record.automation.enabled,true);assert.equal(record.analysis.fingerprint,before.fingerprint);
  assert.equal((await workFingerprint(root)).fingerprint,before.fingerprint);
  await service.status(root);assert.equal(calls,1);
});

test('automatic maintenance debounces changes including untracked content and survives reopen',async t=>{
  let time=100000,calls=0;
  const runner=async()=>{calls++;return {version:1,works:[work]};};
  const {root,service}=await fixture(t,runner,{now:()=>time,settleMs:30,scanIntervalMs:0});
  await service.start(root);await service.wait(root);
  await writeFile(path.join(root,'code.txt'),'changed');
  await service.status(root);await service.wait(root);assert.equal(calls,1);
  time+=31;await service.status(root);await service.wait(root);assert.equal(calls,2);
  await service.close();
  const reopened=createWorkAnalysis({runner,now:()=>time,settleMs:30,scanIntervalMs:0,intervalMs:1e8});t.after(()=>reopened.close());
  await writeFile(path.join(root,'code.txt'),'changed again');
  await reopened.status(root);await reopened.wait(root);time+=31;await reopened.status(root);await reopened.wait(root);assert.equal(calls,3);
});

test('failed, invalid and stale analyses preserve the last valid record',async t=>{
  let run=async()=>({version:1,works:[work]});
  const {root,service}=await fixture(t,args=>run(args));
  await service.start(root);await service.wait(root);
  const filename=path.join(root,'.workgraph/state.json'),old=await readFile(filename,'utf8');
  for(const fail of [async()=>{throw Error('offline');},async()=>({version:1,works:[]}),async()=>{await writeFile(path.join(root,'code.txt'),'during analysis');return {version:1,works:[work]};}]) {
    run=fail;await service.start(root,'update');assert.equal((await service.wait(root)).state,'failed');
    assert.equal(await readFile(filename,'utf8'),old);
  }
});

test('multiple transports cannot run analysis concurrently in the same working directory',async t=>{
  let release,started;const began=new Promise(r=>started=r);
  const {root,service}=await fixture(t,async()=>{started();await new Promise(r=>release=r);return {version:1,works:[work]};});
  const other=createWorkAnalysis({runner:async()=>{throw Error('must not run');},intervalMs:1e8});t.after(()=>other.close());
  await service.start(root);await began;
  await other.start(root);assert.match((await other.wait(root)).error,/另一个 WorkGraph/);
  release();assert.equal((await service.wait(root)).state,'idle');
});

test('unchanged failure is retried with backoff and stops after three attempts',async t=>{
  let time=1e6,calls=0,fail=false;
  const {root,service}=await fixture(t,async()=>{calls++;if(fail)throw Error('offline');return {version:1,works:[work]};},{now:()=>time,settleMs:0,scanIntervalMs:0});
  await service.start(root);await service.wait(root);fail=true;
  await writeFile(path.join(root,'code.txt'),'new');
  for(let i=0;i<5;i++){await service.status(root);await service.wait(root);time+=60001;}
  assert.equal(calls,4);
});

test('fingerprint notices branch switches, staged edits and tracked changes',async t=>{
  const {root}=await fixture(t,async()=>({version:1,works:[]}));
  await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.test']);
  await git(root,['add','code.txt']);await git(root,['commit','-m','base']);
  const first=await workFingerprint(root);
  await git(root,['checkout','-b','next']);assert.notEqual((await workFingerprint(root)).fingerprint,first.fingerprint);
  await writeFile(path.join(root,'code.txt'),'after');const second=await workFingerprint(root);
  await git(root,['add','code.txt']);assert.notEqual((await workFingerprint(root)).fingerprint,second.fingerprint);
});

test('analysis exposes measured phases and persists only bounded timing metadata across reopen',async t=>{
  let time=1000,reads=0,release,began;
  const started=new Promise(resolve=>{began=resolve;});
  const {root,service}=await fixture(t,async()=>{began();await new Promise(resolve=>{release=resolve;});time+=500;return {version:1,works:[{...work,summary:'private source contents'}]};},{
    now:()=>time,fingerprint:async()=>{time+=++reads===1?10:20;return {fingerprint:'same'};}
  });
  const initial=await service.start(root);assert.equal(initial.phase,'prepare');
  await started;
  const running=await service.status(root);
  assert.equal(running.phase,'analysis');assert.equal(running.phaseStartedAt,new Date(1010).toISOString());assert.equal(running.elapsedMs,10);
  running.durationsMs.fingerprint=99999;
  release();const done=await service.wait(root);
  assert.equal(done.state,'idle');assert.equal(done.phase,null);assert.equal(done.phaseStartedAt,null);assert.equal(done.elapsedMs,530);
  assert.deepEqual(done.durationsMs,{prepare:0,fingerprint:10,collect:0,analysis:500,validate:0,recheck:20,save:0});
  const filename=path.join(root,'.workgraph/runtime/last-analysis.json'),raw=await readFile(filename,'utf8'),saved=JSON.parse(raw);
  assert.deepEqual(saved,done.lastRun);assert.ok(Buffer.byteLength(raw)<4096);
  assert.doesNotMatch(raw,/private source contents|WG-A|existing work|fingerprint":"same/);
  done.lastRun.durationsMs.analysis=99999;
  assert.equal((await service.wait(root)).lastRun.durationsMs.analysis,500);
  await service.close();
  const reopened=createWorkAnalysis({intervalMs:1e8});t.after(()=>reopened.close());
  assert.deepEqual((await reopened.wait(root)).lastRun,saved);
});

test('failure diagnostics record only failed phase and timings while preserving valid work',async t=>{
  let fail=false,time=1000;
  const {root,service}=await fixture(t,async()=>{time+=75;if(fail)throw Error('stderr token=secret-value source-private');return {version:1,works:[work]};},{now:()=>time});
  await service.start(root);await service.wait(root);
  const filename=path.join(root,'.workgraph/state.json'),before=await readFile(filename,'utf8');
  fail=true;await service.start(root,'update');const status=await service.wait(root);
  assert.equal(status.state,'failed');assert.equal(status.lastRun.failedPhase,'analysis');assert.equal(status.lastRun.durationsMs.analysis,75);
  assert.equal(await readFile(filename,'utf8'),before);
  const raw=await readFile(path.join(root,'.workgraph/runtime/last-analysis.json'),'utf8');
  assert.equal(JSON.parse(raw).state,'failed');assert.doesNotMatch(raw,/stderr|secret-value|source-private|error/);
});

test('diagnostic write failure does not turn a successfully saved analysis into a failure',async t=>{
  const {root,service}=await fixture(t,async()=>({version:1,works:[work]}));
  await mkdir(path.join(root,'.workgraph/runtime/last-analysis.json'),{recursive:true});
  await service.start(root);assert.equal((await service.wait(root)).state,'idle');
  assert.equal((await readWorkGraph(root)).initialized,true);
});

test('missing Codex executable fails promptly without retaining its ten minute timer',async t=>{
  const {root}=await fixture(t,async()=>({version:1,works:[]}));
  const original=process.env.WORKGRAPH_CODEX_PATH;
  process.env.WORKGRAPH_CODEX_PATH=path.join(root,'missing-codex-executable');
  t.after(()=>{if(original===undefined)delete process.env.WORKGRAPH_CODEX_PATH;else process.env.WORKGRAPH_CODEX_PATH=original;});
  await assert.rejects(()=>runCodexAnalysis({root,mode:'initialize',previous:{version:1,works:[]},baseline:{}}),/ENOENT/);
});
