import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { readWorkGraph } from '../src/work-graph.mjs';

test('real work ownership follows hashes and trailers without inventing validation or hiding dirty files', async()=>{
  await mkdir('.test-output',{recursive:true});const root=await mkdtemp(path.resolve('.test-output/work-live-'));
  await git(root,['init','-b','main']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.test']);
  await writeFile(path.join(root,'a.txt'),'one');await git(root,['add','.']);await git(root,['commit','-m','base']);
  const first=(await git(root,['rev-parse','HEAD'])).trim();
  await writeFile(path.join(root,'.workgraph.json'),JSON.stringify({version:1,works:[{id:'WG-A',title:'实际工作',status:'进行中',commits:[first]}]}));
  await git(root,['add','.']);await git(root,['commit','-m','work records','-m','Work-Item: WG-A']);
  await writeFile(path.join(root,'pending.txt'),'not committed');
  const result=await readWorkGraph(root);
  assert.equal(result.records.length,2);assert.ok(result.records.every(r=>r.workId==='WG-A'));assert.equal(result.works[0].status,'进行中');assert.ok(result.dirty.some(f=>f.path==='pending.txt'));
  await writeFile(path.join(root,'.workgraph.json'),JSON.stringify({version:1,works:[]}));
  const unassigned=await readWorkGraph(root);assert.ok(unassigned.records.every(r=>r.workId==='UNASSIGNED'));
  assert.equal(unassigned.works.find(w=>w.id==='UNASSIGNED').title,'未关联的提交');
  assert.equal(unassigned.works.find(w=>w.id==='UNASSIGNED').status,'待开始');
  await writeFile(path.join(root,'.workgraph.json'),'{broken');await assert.rejects(()=>readWorkGraph(root));
});

test('version 1 hierarchy preserves direct ownership, recorded timestamps and bounded structured detail',async()=>{
  await mkdir('.test-output',{recursive:true});const root=await mkdtemp(path.resolve('.test-output/work-model-'));
  await git(root,['init','-b','main']);await git(root,['config','user.name','Test']);await git(root,['config','user.email','test@example.test']);
  await writeFile(path.join(root,'a.txt'),'one');await git(root,['add','.']);await git(root,['commit','-m','base']);
  const first=(await git(root,['rev-parse','HEAD'])).trim();
  const work=(id,extra={})=>({id,title:id,status:'进行中',commits:[],...extra});
  const save=works=>writeFile(path.join(root,'.workgraph.json'),JSON.stringify({version:1,works}));
  await save([work('PARENT',{commits:[first]}),work('CHILD',{parentId:'PARENT',kind:'outcome',updatedAt:'2026-10-28T08:00:00Z',outcomes:['读取实际差异'],issues:['尚未验收']})]);
  const data=await readWorkGraph(root);
  assert.equal(data.works[0].updatedAt,null);assert.equal(data.works[1].parentId,'PARENT');assert.equal(data.works[1].updatedAt,'2026-10-28T08:00:00Z');
  assert.deepEqual(data.works[1].commits,[]);assert.equal(data.records[0].workId,'PARENT');assert.deepEqual(data.works[1].issues,['尚未验收']);
  const invalid=[
    [null],
    [work('UNASSIGNED')],
    [work('DUP'),work('DUP')],
    [work('CHILD',{parentId:'MISSING'})],
    [work('A',{parentId:'B'}),work('B',{parentId:'A'})],
    [work('A'),work('B',{parentId:'A'}),work('C',{parentId:'B'}),work('D',{parentId:'C'})],
    [work('A',{kind:'invented'})],
    [work('A',{updatedAt:'2026-02-30T08:00:00Z'})],
    [work('A',{updatedAt:'yesterday'})],
    [work('A',{outcomes:['']})],
    [work('A',{issues:Array(21).fill('问题')})],
    [work('A',{outcomes:['x'.repeat(1001)]})],
    [work('A',{unknown:'ignored'})]
  ];
  for(const works of invalid){await save(works);await assert.rejects(()=>readWorkGraph(root));}
  await writeFile(path.join(root,'.workgraph.json'),' '.repeat(262145));await assert.rejects(()=>readWorkGraph(root),/256 KiB/);
});
