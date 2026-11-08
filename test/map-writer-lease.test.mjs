import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, unlink, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/git.mjs';
import { createWorkAnalysis } from '../src/work-analysis.mjs';
import { prepareWorkMap, saveWorkMap, runCli } from '../src/workgraph-cli.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { withFileLock } from '../src/file-lock.mjs';

const execute=promisify(execFile);
const work={id:'WG-A',title:'existing',status:'进行中',commits:[]};
async function fixture() {
  await mkdir('.test-output',{recursive:true});
  const base=await mkdtemp(path.resolve('.test-output/map-lease-')),root=path.join(base,'repository');
  await mkdir(root);await git(root,['init','-b','main']);
  const runtime=path.join(root,'.workgraph/runtime');await mkdir(runtime,{recursive:true});
  await writeFile(path.join(root,'.workgraph/state.json'),JSON.stringify({version:1,works:[work]}));
  return {base,root,runtime,lock:path.join(runtime,'analysis.lock'),record:path.join(root,'.workgraph/state.json'),diagnostic:path.join(runtime,'last-analysis.json')};
}
async function worker(t,root) {
  const child=fork(new URL('./helpers/map-writer-worker.mjs',import.meta.url),[root],{stdio:['ignore','ignore','pipe','ipc']});
  const messages=[],waiters=[];let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  child.on('message',message=>{messages.push(message);for(const waiter of [...waiters])if(waiter.predicate(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}});
  const exited=once(child,'exit');
  const wait=predicate=>{const found=messages.find(predicate);return found?Promise.resolve(found):new Promise(resolve=>waiters.push({predicate,resolve}));};
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  await wait(message=>message.state==='ready');
  return {child,exited,wait,messages,stderr:()=>stderr};
}
async function failedContender(t,f) {
  let called=false;
  const service=createWorkAnalysis({runner:async()=>{called=true;throw Error('must not run');}});t.after(()=>service.close());
  await service.start(f.root);const result=await service.wait(f.root);
  assert.equal(result.state,'failed');assert.match(result.error,/工作地图保存锁/);assert.equal(called,false);
  return result;
}

test('two real analysis processes cannot enter the same map writer lease', {timeout:15000},async t=>{
  const f=await fixture(),[a,b]=await Promise.all([worker(t,f.root),worker(t,f.root)]);
  const sentinel='owner diagnostic is not replaced by contention';await writeFile(f.diagnostic,sentinel);
  a.child.send('start');b.child.send('start');
  const first=await Promise.race([a.wait(m=>m.state==='entered').then(()=>a),b.wait(m=>m.state==='entered').then(()=>b)]);
  const second=first===a?b:a;
  const rejected=await second.wait(m=>m.state==='done');
  assert.equal(rejected.result.state,'failed');assert.match(rejected.result.error,/工作地图保存锁/);
  assert.equal(second.messages.some(m=>m.state==='entered'),false);
  assert.equal(await readFile(f.diagnostic,'utf8'),sentinel);
  assert.deepEqual(JSON.parse(await readFile(f.record,'utf8')).works,[work]);
  first.child.send('release');
  assert.equal((await first.wait(m=>m.state==='done')).result.state,'idle');
  for(const current of [a,b])assert.equal((await current.exited)[0],0,current.stderr());
  assert.equal((await readdir(f.runtime)).some(name=>name.startsWith('analysis.lock')),false);
});

test('real CLI save and analysis share the lease, including old live timestamps', {timeout:15000},async t=>{
  const f=await fixture(),packet=await prepareWorkMap(f.root);
  const context=path.join(f.base,'context.json'),candidate=path.join(f.base,'candidate.json');
  await writeFile(context,JSON.stringify(packet));await writeFile(candidate,JSON.stringify({version:1,works:[work]}));
  const holder=await worker(t,f.root);holder.child.send('start');await holder.wait(m=>m.state==='entered');
  await utimes(f.lock,new Date(0),new Date(0));
  const owner=await readFile(f.lock,'utf8'),before=await readFile(f.record,'utf8');
  const sentinel='unchanged diagnostic';await writeFile(f.diagnostic,sentinel);
  await assert.rejects(execute(process.execPath,[fileURLToPath(new URL('../src/workgraph-cli.mjs',import.meta.url)),'save','--repo',f.root,'--context',context,'--input',candidate]),error=>{
    assert.match(error.stderr,/工作地图保存锁/);return true;
  });
  assert.equal(await readFile(f.lock,'utf8'),owner);assert.equal(await readFile(f.record,'utf8'),before);
  assert.equal(await readFile(f.diagnostic,'utf8'),sentinel);
  holder.child.send('release');assert.equal((await holder.wait(m=>m.state==='done')).result.state,'idle');
});

test('a killed analysis process leaves a lease that fails closed until offline recovery', {timeout:15000},async t=>{
  const f=await fixture(),holder=await worker(t,f.root);holder.child.send('start');await holder.wait(m=>m.state==='entered');
  const owner=await readFile(f.lock,'utf8'),before=await readFile(f.record,'utf8');
  holder.child.kill('SIGKILL');await holder.exited;
  await failedContender(t,f);assert.equal(await readFile(f.lock,'utf8'),owner);assert.equal(await readFile(f.record,'utf8'),before);
  // Operator recovery is allowed only after every writer has stopped.
  await unlink(f.lock);
  const service=createWorkAnalysis({runner:async({previous})=>previous});t.after(()=>service.close());
  await service.start(f.root);assert.equal((await service.wait(f.root)).state,'idle');
});

test('legacy PID, empty and malformed locks are never reclaimed or replaced',async t=>{
  const f=await fixture(),sentinel='leave owner timing alone';await writeFile(f.diagnostic,sentinel);
  for(const lock of ['',JSON.stringify({pid:2147483647}),'{broken']) {
    await writeFile(f.lock,lock);await failedContender(t,f);
    assert.equal(await readFile(f.lock,'utf8'),lock);assert.equal(await readFile(f.diagnostic,'utf8'),sentinel);await unlink(f.lock);
  }
  const external=path.join(f.base,'external');await writeFile(external,'untouched');
  try{await symlink(external,f.lock,'file');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('Host does not permit symlink creation.');return;}throw error;}
  await failedContender(t,f);assert.equal(await readFile(external,'utf8'),'untouched');
});

test('owner release never removes a substituted successor map lease',async()=>{
  const f=await fixture();
  await withFileLock(f.lock,async()=>{await unlink(f.lock);await writeFile(f.lock,'successor');},{timeoutMs:0,label:'工作地图保存锁'});
  assert.equal(await readFile(f.lock,'utf8'),'successor');
});

test('release cleanup failure reports an already saved map and clears pending',async t=>{
  const f=await fixture();let temporary,calls=0;
  const service=createWorkAnalysis({runner:async({previous})=>{
    calls++;
    if(calls===1) {
      const owner=JSON.parse(await readFile(f.lock,'utf8'));
      temporary=`${f.lock}.${owner.token}.tmp`;
      // Inject a real cleanup syscall error without relying on root permission bits.
      await mkdir(temporary);
    }
    return {version:1,works:previous.works.map(item=>({...item,next:'saved despite cleanup error'}))};
  }});t.after(()=>service.close());
  await service.start(f.root);const result=await service.wait(f.root);
  assert.equal(result.state,'failed');assert.match(result.error,/工作记录已保存，但保存锁释放失败.*先查询状态/);
  assert.equal(JSON.parse(await readFile(f.record,'utf8')).works[0].next,'saved despite cleanup error');
  // Disk diagnostics describe the completed business save; after a release
  // failure the caller reports failed, without rewriting diagnostics off-lease.
  assert.equal(JSON.parse(await readFile(f.diagnostic,'utf8')).state,'idle');
  await rm(temporary,{recursive:true});
  await service.start(f.root);assert.equal((await service.wait(f.root)).state,'idle');
  assert.equal(calls,2); // A new invocation, not an old settled pending promise.
  assert.equal(JSON.parse(await readFile(f.record,'utf8')).works[0].next,'saved despite cleanup error');
});


test('a stale initialize request cannot overwrite an existing map after mode resolution',async t=>{
  const f=await fixture(),before=await readFile(f.record,'utf8');let called=false;
  const service=createWorkAnalysis({runner:async()=>{called=true;return {version:1,works:[]};}});t.after(()=>service.close());
  await service.start(f.root,'initialize');const result=await service.wait(f.root);
  assert.equal(result.state,'failed');assert.match(result.error,/模式已变化/);assert.equal(called,false);
  assert.equal(await readFile(f.record,'utf8'),before);
});


test('status queries on a fresh repository never create runtime or acquire a lease',async t=>{
  await mkdir('.test-output',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-output/map-status-readonly-'));await git(root,['init','-b','main']);
  const service=createWorkAnalysis({runner:async()=>assert.fail('status must not analyze')});t.after(()=>service.close());
  assert.equal((await service.status(root)).state,'idle');
  assert.equal((await runCli(['status','--repo',root])).available,true);
  assert.equal((await readdir(root)).includes('.workgraph'),false);
});

test('the CLI save API preserves the already-saved cleanup failure message',async()=>{
  const f=await fixture(),packet=await prepareWorkMap(f.root);let temporary;
  const candidate={version:1,get works(){
    const owner=JSON.parse(readFileSync(f.lock,'utf8'));
    temporary=`${f.lock}.${owner.token}.tmp`;mkdirSync(temporary);
    return [{...work,next:'CLI save completed'}];
  }};
  await assert.rejects(saveWorkMap(f.root,packet,candidate),/工作记录已保存，但保存锁释放失败.*先查询状态/);
  assert.equal(JSON.parse(await readFile(f.record,'utf8')).works[0].next,'CLI save completed');
  assert.equal(JSON.parse(await readFile(f.diagnostic,'utf8')).execution,'agent-save');
  await rm(temporary,{recursive:true});
});
