import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {git} from '../src/git.mjs';
import {collectWorkContext,normalizeWorktreeSnapshot} from '../src/work-context.mjs';
import {createWorkAnalysis,workFingerprint} from '../src/work-analysis.mjs';

const work={id:'WG-A',title:'Existing work',status:'进行中',commits:[],summary:'Original summary'};
async function put(root,name,text) {const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
async function fixture() {
  await mkdir('.test-output',{recursive:true});const root=await mkdtemp(path.resolve('.test-output/incremental-'));
  await git(root,['init','-b','main']);await git(root,['config','user.name','Incremental Test']);await git(root,['config','user.email','incremental@example.test']);
  await put(root,'README.md','Project entry');await put(root,'docs/changed.md','Original document');await put(root,'docs/unrelated.md','UNRELATED_DOCUMENT_NOT_NEEDED');
  await git(root,['add','.']);await git(root,['commit','-m','Original project']);return root;
}
async function initial(root) {
  const baseline=await workFingerprint(root),context=await collectWorkContext({root,baseline});
  return {version:1,works:[work],analysis:{...baseline,worktree:context.worktree}};
}

test('incremental evidence contains only new commits and relevant document paths',async()=>{
  const root=await fixture(),previous=await initial(root);
  await put(root,'docs/changed.md','Updated document');await git(root,['add','docs/changed.md']);await git(root,['commit','-m','Change one document']);
  const baseline=await workFingerprint(root),context=await collectWorkContext({root,mode:'update',previous,baseline});
  assert.equal(context.scope,'incremental');assert.equal(context.delta.kind,'incremental');
  assert.equal(context.history.range,`${previous.analysis.head}..${baseline.head}`);
  assert.deepEqual(context.history.items.map(item=>item.hash),[baseline.head]);assert.equal(context.coverage.history,'new-commits');
  assert.deepEqual(context.delta.paths.items,['docs/changed.md']);
  assert.match(context.documents.items.find(item=>item.path==='docs/changed.md').text,/Updated document/);
  assert.ok(!context.documents.items.some(item=>item.path==='docs/unrelated.md'));
  assert.doesNotMatch(JSON.stringify(context),/UNRELATED_DOCUMENT_NOT_NEEDED|dirtyPaths/);
  assert.ok(Buffer.byteLength(JSON.stringify(context))<=65536);
});

test('same-HEAD updates retain reverted dirty and removed untracked paths plus current edits',async()=>{
  const root=await fixture();await put(root,'docs/changed.md','Uncommitted earlier work');await put(root,'notes/removed.md','Earlier untracked note');
  const previous=await initial(root);
  await git(root,['restore','docs/changed.md']);await unlink(path.join(root,'notes/removed.md'));await put(root,'notes/current.md','Current untracked note');
  const baseline=await workFingerprint(root),context=await collectWorkContext({root,mode:'update',previous,baseline});
  assert.equal(context.scope,'incremental');assert.equal(context.history.items.length,0);
  assert.deepEqual(new Set(context.delta.paths.items),new Set(['docs/changed.md','notes/removed.md','notes/current.md']));
  assert.deepEqual(new Set(context.delta.previousDirtyPaths.items),new Set(['docs/changed.md','notes/removed.md']));
  assert.equal(context.documents.items.find(item=>item.path==='notes/removed.md').omitted,'missing');
  assert.equal(context.documents.items.find(item=>item.path==='docs/changed.md').text,'Original document');
  assert.deepEqual(context.worktree.dirtyPaths,['notes/current.md']);
});

test('staged rename evidence includes both names and nested applicable instructions',async()=>{
  const root=await fixture();await put(root,'docs/AGENTS.md','Apply document conventions');await git(root,['add','.']);await git(root,['commit','-m','Document instructions']);
  const previous=await initial(root);await git(root,['mv','docs/changed.md','docs/renamed.md']);
  const context=await collectWorkContext({root,mode:'update',previous,baseline:await workFingerprint(root)});
  assert.deepEqual(new Set(context.delta.paths.items),new Set(['docs/changed.md','docs/renamed.md']));
  assert.ok(context.documents.items.some(item=>item.path==='docs/AGENTS.md'));
  assert.ok(context.worktree.dirtyPaths.includes('docs/changed.md'));assert.ok(context.worktree.dirtyPaths.includes('docs/renamed.md'));
});

test('missing, incomplete, invalid and nonancestor baselines explicitly fall back to a bounded map',async()=>{
  const root=await fixture(),previous=await initial(root),baseline=await workFingerprint(root);
  for(const [old,reason] of [
    [{version:1,works:[]},'baseline-head-unavailable'],
    [{...previous,analysis:{...previous.analysis,head:'--all'}},'baseline-head-unavailable'],
    [{...previous,analysis:{...previous.analysis,worktree:undefined}},'worktree-baseline-unavailable'],
    [{...previous,analysis:{...previous.analysis,worktree:{version:1,dirtyPaths:[],complete:false}}},'worktree-baseline-incomplete'],
    [{...previous,analysis:{...previous.analysis,head:'a'.repeat(40)}},'baseline-commit-unavailable'],
  ]) {
    const context=await collectWorkContext({root,mode:'update',previous:old,baseline});
    assert.equal(context.scope,'initial-map');assert.equal(context.delta.kind,'fallback');assert.equal(context.delta.reason,reason);
    assert.ok(context.documents.items.some(item=>item.path==='docs/unrelated.md'));assert.ok(Buffer.byteLength(JSON.stringify(context))<=65536);
  }
  await git(root,['switch','--orphan','replacement']);await put(root,'replacement.md','Replacement history');await git(root,['add','.']);await git(root,['commit','-m','Replacement root']);
  const context=await collectWorkContext({root,mode:'update',previous,baseline:await workFingerprint(root)});
  assert.equal(context.delta.kind,'fallback');assert.equal(context.delta.reason,'history-not-descendant');
  assert.equal(normalizeWorktreeSnapshot({version:1,dirtyPaths:['../escape'],complete:true}),null);
});

test('dirty-path snapshots are bounded and incomplete snapshots force a safe later fallback',async()=>{
  const root=await fixture();for(let i=0;i<270;i++)await put(root,`notes/${i}.md`,'New note');
  const previous=await initial(root);assert.equal(previous.analysis.worktree.complete,false);assert.ok(previous.analysis.worktree.dirtyPaths.length<=256);
  assert.ok(Buffer.byteLength(JSON.stringify(previous.analysis.worktree))<=8192);
  const context=await collectWorkContext({root,mode:'update',previous,baseline:await workFingerprint(root),limits:{maxBytes:4096}});
  assert.equal(context.delta.reason,'worktree-baseline-incomplete');assert.ok(Buffer.byteLength(JSON.stringify(context))<=4096);
});

test('atomic saved dirty metadata survives reopen, while failed and stale updates preserve the old baseline',async t=>{
  const root=await fixture();await put(root,'notes/removed.md','Earlier note');let fail=false,stale=false,received;
  const runner=async args=>{received=args.context;if(fail)throw Error('model failed');if(stale)await put(root,'during.md','Concurrent edit');return {version:1,works:[work]};};
  const service=createWorkAnalysis({runner,intervalMs:1e8});t.after(()=>service.close());
  await service.start(root);assert.equal((await service.wait(root)).state,'idle');await service.close();
  const filename=path.join(root,'.workgraph/state.json'),before=await readFile(filename,'utf8');
  assert.ok(JSON.parse(before).analysis.worktree.dirtyPaths.includes('notes/removed.md'));
  await unlink(path.join(root,'notes/removed.md'));
  const reopened=createWorkAnalysis({runner,intervalMs:1e8});t.after(()=>reopened.close());
  fail=true;await reopened.start(root,'update');assert.equal((await reopened.wait(root)).state,'failed');assert.ok(received.delta.paths.items.includes('notes/removed.md'));
  assert.equal(await readFile(filename,'utf8'),before);
  fail=false;stale=true;await reopened.start(root,'update');assert.equal((await reopened.wait(root)).state,'failed');assert.equal(await readFile(filename,'utf8'),before);
  stale=false;await reopened.start(root,'update');assert.equal((await reopened.wait(root)).state,'idle');
  assert.ok(!JSON.parse(await readFile(filename,'utf8')).analysis.worktree.dirtyPaths.includes('notes/removed.md'));
});

test('compact updates explicitly preserve unchanged work and reject missing, overlapping or unknown IDs',async t=>{
  const root=await fixture();let response={version:1,works:[work]},clock=1000;
  const service=createWorkAnalysis({runner:async()=>response,now:()=>clock,intervalMs:1e8});t.after(()=>service.close());
  await service.start(root);assert.equal((await service.wait(root)).state,'idle');
  const filename=path.join(root,'.workgraph/state.json');let before=JSON.parse(await readFile(filename,'utf8'));const timestamp=before.works[0].updatedAt;
  clock+=1000;response={version:1,works:[{id:'WG-NEW',title:'New child',parentId:'WG-A',status:'待开始',commits:[]}],unchangedIds:['WG-A']};
  await service.start(root,'update');assert.equal((await service.wait(root)).state,'idle');
  before=JSON.parse(await readFile(filename,'utf8'));assert.equal(before.works.length,2);assert.equal(before.works[0].updatedAt,timestamp);assert.equal(before.works[0].summary,work.summary);
  const valid=await readFile(filename,'utf8');
  for(const invalid of [
    {version:1,works:[],unchangedIds:['WG-A']},
    {version:1,works:[work],unchangedIds:['WG-A','WG-NEW']},
    {version:1,works:[],unchangedIds:['WG-A','WG-NEW','UNKNOWN']},
    {version:1,works:[],unchangedIds:['WG-A','WG-A','WG-NEW']},
    {version:1,works:[]},
  ]) {response=invalid;await service.start(root,'update');assert.equal((await service.wait(root)).state,'failed');assert.equal(await readFile(filename,'utf8'),valid);}
  response={version:1,works:[],unchangedIds:['WG-A','WG-NEW']};await service.start(root,'update');assert.equal((await service.wait(root)).state,'idle');
});

test('optional dirty metadata cannot make an otherwise valid near-limit work record fail',async t=>{
  const root=await fixture(),works=Array.from({length:13},(_,i)=>({id:`WG-${i}`,title:'Large record',status:'进行中',commits:[],issues:Array.from({length:i===12?16:20},()=> 'x'.repeat(1000))}));
  const snapshot={version:1,dirtyPaths:Array.from({length:200},(_,i)=>`notes/${i}-${'a'.repeat(20)}.md`),complete:true};assert.ok(normalizeWorktreeSnapshot(snapshot));
  const service=createWorkAnalysis({runner:async()=>({version:1,works}),collector:async()=>({worktree:snapshot}),intervalMs:1e8});t.after(()=>service.close());
  await service.start(root);const status=await service.wait(root);assert.equal(status.state,'idle',status.error);
  const raw=await readFile(path.join(root,'.workgraph/state.json'),'utf8');assert.ok(Buffer.byteLength(raw)<=262144);
  const record=JSON.parse(raw);assert.equal(record.works.length,13);assert.equal(record.analysis.worktree?.complete??false,false);
});
