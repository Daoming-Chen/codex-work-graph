import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, access, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { prepareWorkMap, saveWorkMap } from '../src/workgraph-cli.mjs';
import { packageSkill } from '../scripts/package-skill.mjs';
import { startHttp } from '../src/http.mjs';
const exec=promisify(execFile);
const work={id:'GOAL',title:'用户能理解项目进展',status:'进行中',commits:[],summary:'建立目标与工作的联系',next:'体验后调整',parentId:null,kind:'work',outcomes:[],issues:[]};
async function fixture(){await mkdir('.test-output',{recursive:true});const root=await mkdtemp(path.resolve('.test-output/skill-'));await git(root,['init','-b','main']);return root;}

test('standalone map exposes evidence but no Git mutation or separate model analysis endpoint',async t=>{
  const root=await fixture(),panel=await startHttp({repositoryPath:root,html:'map',workMapOnly:true});
  t.after(()=>panel.close());
  const headers={Authorization:`Bearer ${panel.token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(panel.origin+'/api/work_graph',{headers})).status,200);
  for(const route of ['prepare','execute','work_analyze','save_preferences'])assert.equal((await fetch(panel.origin+'/api/'+route,{method:'POST',headers,body:'{}'})).status,404);
});

test('one entry routes first use, legacy migration and conversation-only updates',async()=>{
  const root=await fixture();
  let packet=await prepareWorkMap(root);assert.equal(packet.mode,'initialize');
  await assert.rejects(access(path.join(root,'.workgraph/state.json')),{code:'ENOENT'});
  await writeFile(path.join(root,'.workgraph.json'),JSON.stringify({version:1,works:[{...work,parentId:undefined}]}));
  packet=await prepareWorkMap(root);assert.equal(packet.mode,'initialize');
  await saveWorkMap(root,packet,{version:1,works:[work]});
  assert.ok(await readFile(path.join(root,'.workgraph.json'),'utf8'));
  packet=await prepareWorkMap(root);assert.equal(packet.mode,'update');
  await saveWorkMap(root,packet,{version:1,works:[{...work,next:'用户决定先完善工作地图'}],unchangedIds:[]});
  const result=JSON.parse(await readFile(path.join(root,'.workgraph/state.json'),'utf8'));
  assert.equal(result.works[0].next,'用户决定先完善工作地图');assert.equal(result.automation.enabled,false);
  const {createWorkAnalysis}=await import('../src/work-analysis.mjs');
  const reopened=createWorkAnalysis();
  try {assert.equal((await reopened.status(root)).lastRun.execution,'agent-save');}
  finally {await reopened.close();}
});

test('stale code, concurrent record changes and invalid candidates preserve the last good map',async()=>{
  const root=await fixture();
  await saveWorkMap(root,await prepareWorkMap(root),{version:1,works:[work]});
  const filename=path.join(root,'.workgraph/state.json'),before=await readFile(filename,'utf8');
  let packet=await prepareWorkMap(root);
  await writeFile(path.join(root,'new.txt'),'new code');
  await assert.rejects(saveWorkMap(root,packet,{version:1,works:[work]}),/已变化/);
  assert.equal(await readFile(filename,'utf8'),before);
  packet=await prepareWorkMap(root);
  await assert.rejects(saveWorkMap(root,packet,{version:1,works:[],unchangedIds:[]}),/丢失/);
  assert.equal(await readFile(filename,'utf8'),before);
  const changed=JSON.parse(before);changed.works[0].next='another agent';await writeFile(filename,JSON.stringify(changed));
  await assert.rejects(saveWorkMap(root,packet,{version:1,works:[work]}),/已变化/);
  assert.equal(JSON.parse(await readFile(filename,'utf8')).works[0].next,'another agent');
});

test('corrupt records fail closed instead of routing to an empty first-use map',async()=>{
  const root=await fixture();await mkdir(path.join(root,'.workgraph'));await writeFile(path.join(root,'.workgraph/state.json'),'broken');
  await assert.rejects(prepareWorkMap(root));
  assert.equal(await readFile(path.join(root,'.workgraph/state.json'),'utf8'),'broken');
});

test('standalone skill works after relocation without MCP or source dependencies',async()=>{
  const root=await fixture(),target=path.join(root,'installed skill 中文');
  await writeFile(path.join(root,'code.txt'),'baseline');
  await git(root,['add','code.txt']);
  await git(root,['-c','user.name=Test','-c','user.email=test@example.test','commit','-m','baseline']);
  await packageSkill(target);const moved=target+' moved';await rename(target,moved);
  const cli=path.join(moved,'scripts/workgraph.mjs');
  const {stdout}=await exec(process.execPath,[cli,'doctor']);assert.equal(JSON.parse(stdout).ready,true);
  const {stdout:status}=await exec(process.execPath,[cli,'status','--repo',root]);assert.equal(JSON.parse(status).source,'Git');
  const {stdout:prepared}=await exec(process.execPath,[cli,'context','--repo',root]);
  const packet=JSON.parse(prepared);assert.equal(packet.mode,'initialize');
  assert.ok(packet.contextPath.startsWith(path.join(root,'.workgraph/runtime/request-')));
  await writeFile(packet.candidatePath,JSON.stringify({version:1,works:[work]}));
  const {stdout:saved}=await exec(process.execPath,[cli,'save','--repo',root,'--context',packet.contextPath,'--input',packet.candidatePath]);
  assert.equal(JSON.parse(saved).state,'saved');
  const record=JSON.parse(await readFile(path.join(root,'.workgraph/state.json'),'utf8'));
  assert.equal(record.analysis.worktree.complete,true,'serialized CLI requests retain the dirty-path baseline');
  await writeFile(path.join(root,'code.txt'),'changed since last save');
  const next=JSON.parse((await exec(process.execPath,[cli,'context','--repo',root])).stdout);
  const nextPacket=JSON.parse(await readFile(next.contextPath,'utf8'));
  assert.equal(nextPacket.context.scope,'incremental');
  assert.ok(nextPacket.context.delta.paths.items.includes('code.txt'));
  assert.match(await readFile(path.join(moved,'scripts/graph.html'),'utf8'),/work-mode,#work-analyze\{display:none/);
});
