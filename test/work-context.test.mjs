import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,unlink,symlink} from 'node:fs/promises';
import path from 'node:path';
import {git} from '../src/git.mjs';
import {collectWorkContext,readContextDocument,contextGit,workContextLimits} from '../src/work-context.mjs';
import {createWorkAnalysis,analysisPrompt} from '../src/work-analysis.mjs';

async function fixture() {
  await mkdir('.test-output',{recursive:true});
  const root=await mkdtemp(path.resolve('.test-output/context-'));
  await git(root,['init','-b','main']);
  await git(root,['config','user.name','Context Test']);
  await git(root,['config','user.email','context@example.test']);
  return root;
}
async function put(root,name,text) {
  const filename=path.join(root,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,text);
}
async function head(root) {return (await git(root,['rev-parse','HEAD'])).trim();}

test('initial map precollects relevant facts and documents without reading source or archive contents',async()=>{
  const root=await fixture();
  for(const [name,text] of Object.entries({'README.md':'# Project\nMain map','AGENTS.md':'Read applicable instructions','CONTRIBUTING.md':'Project conventions',
    'collaboration/development-plan.md':'Plan and responsibility','modules/runtime.md':'# Runtime\nPlanned integration',
    'src/app.js':'SOURCE_MUST_NOT_BE_EAGERLY_READ','old.txt':'delete me','assets/archive/old.md':'ARCHIVE_MUST_NOT_BE_READ','assets/report.zip':'ZIP_MUST_NOT_BE_READ','.env':'SECRET_MUST_NOT_BE_READ'}))await put(root,name,text);
  await git(root,['add','.']);await git(root,['commit','-m','Initial project','-m','Scope evidence and limitations']);
  const baseline={head:await head(root)};
  await unlink(path.join(root,'old.txt'));
  await put(root,'src/app.js','staged source change');await git(root,['add','src/app.js']);
  await put(root,'notes/new.md','New untracked notes');await put(root,'assets/new.png','binary artifact');
  const context=await collectWorkContext({root,baseline});
  assert.equal(context.scope,'initial-map');assert.equal(context.codegraph,false);
  assert.deepEqual(context.documents.items.slice(0,3).map(d=>d.path),['AGENTS.md','README.md','CONTRIBUTING.md']);
  assert.ok(context.documents.items.some(d=>d.path==='collaboration/development-plan.md'));
  assert.match(context.history.items[0].body,/Scope evidence/);assert.equal(context.history.items[0].hash,baseline.head);
  assert.ok(context.changes.items.some(f=>f.path==='old.txt'&&f.working==='D'));
  assert.ok(context.changes.items.some(f=>f.path==='src/app.js'&&f.index==='M'));
  assert.ok(context.changes.items.some(f=>f.path==='notes/new.md'&&f.index==='?'));
  assert.ok(context.changes.stats.items.some(f=>f.path==='src/app.js'&&f.area==='staged'&&f.added==='1'));
  assert.ok(context.changes.stats.items.some(f=>f.path==='old.txt'&&f.area==='unstaged'&&f.deleted==='1'));
  assert.equal(context.changes.excluded,1);
  assert.ok(context.inventory.excluded>=3);
  assert.equal(context.coverage.sourceContents,'not-read');
  assert.doesNotMatch(JSON.stringify(context),/SOURCE_MUST_NOT_BE_EAGERLY_READ|ARCHIVE_MUST_NOT_BE_READ|ZIP_MUST_NOT_BE_READ|SECRET_MUST_NOT_BE_READ/);
});

test('large multilingual documents and many paths obey one serialized UTF-8 byte bound with explicit omissions',async()=>{
  const root=await fixture();
  await put(root,'AGENTS.md','Follow applicable conventions');
  await put(root,'README.md','中文文档'.repeat(100000));
  for(let i=0;i<130;i++)await put(root,`docs/document-${String(i).padStart(3,'0')}.md`,'Long document '.repeat(1000));
  const context=await collectWorkContext({root,limits:{maxBytes:4096,fileBytes:1025,maxFiles:10,maxDocuments:3}});
  assert.ok(Buffer.byteLength(JSON.stringify(context))<=4096);
  assert.ok(context.documents.omitted>0);assert.ok(context.inventory.omitted>0);
  const readme=context.documents.items.find(d=>d.path==='README.md');
  assert.equal(readme.truncated,true);assert.ok(Buffer.byteLength(readme.text)<=1025);assert.doesNotMatch(readme.text,/\ufffd/);
  const direct=await readContextDocument(root,'README.md',1025);
  assert.equal(direct.omitted,undefined);assert.equal(Buffer.byteLength(direct.text),1023);assert.doesNotMatch(direct.text,/\ufffd/);
  assert.equal(workContextLimits.maxBytes,65536);
});

test('document collection skips directory junctions and non-text files and reports CodeGraph without reading source',async t=>{
  const root=await fixture(),outside=await fixture();
  await put(outside,'private.md','OUTSIDE_CONTENT_MUST_NOT_BE_READ');
  await symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  const aliased=await readContextDocument(root,'linked/private.md');assert.equal(aliased.omitted,'unsafe-or-nonregular');
  await put(root,'binary.md',Buffer.from([65,0,66]));assert.equal((await readContextDocument(root,'binary.md')).omitted,'binary');
  await mkdir(path.join(root,'.codegraph'));await put(root,'src/code.js','SOURCE_WITH_INDEX_NOT_READ');
  await put(root,'README.md','Main project');
  const context=await collectWorkContext({root});
  assert.equal(context.codegraph,true);assert.doesNotMatch(JSON.stringify(context),/OUTSIDE_CONTENT_MUST_NOT_BE_READ|SOURCE_WITH_INDEX_NOT_READ/);
  assert.equal((await readContextDocument(root,'../private.md')).omitted,'unsafe-or-nonregular');
});

test('JSON escaping shrinks a high-priority excerpt instead of dropping it for a lower-priority document',async()=>{
  const root=await fixture();
  await put(root,'README.md','Project overview');
  await put(root,'collaboration/development-plan.md','"\\\n'.repeat(3000));
  await put(root,'modules/low-priority.md','Lower priority documentation');
  const context=await collectWorkContext({root,limits:{maxBytes:8192}});
  const plan=context.documents.items.find(d=>d.path==='collaboration/development-plan.md');
  assert.ok(plan);assert.equal(plan.truncated,true);assert.ok(plan.text.length>0);assert.equal(plan.endLine,plan.text.split('\n').length);
  assert.ok(Buffer.byteLength(JSON.stringify(context))<=8192);
});

test('bounded Git queries mark incomplete records and reject option-shaped history ranges',async()=>{
  const root=await fixture();await put(root,'a.txt','a');await git(root,['add','.']);await git(root,['commit','-m','a']);
  const result=await contextGit(root,['log','--format=%H%x00%s%x00'],{maxBytes:10});
  assert.equal(result.truncated,true);assert.ok(Buffer.byteLength(result.output)<=10);
  await assert.rejects(()=>collectWorkContext({root,baseline:{head:'a'.repeat(40)},historyRange:'--all'}),/完整 SHA/);
  await assert.rejects(()=>contextGit(root,['not-a-real-subcommand']),/git|Git/);
});

test('a history cap inside a commit body marks the retained partial record incomplete',async()=>{
  const root=await fixture();await put(root,'README.md','Project');
  await git(root,['add','.']);await git(root,['commit','-m','Short title','-m','Body evidence must not appear complete when clipped']);
  const baseline={head:await head(root)};
  const prefix=await git(root,['log','-1','--format=%H%x00%aI%x00%s%x00']);
  const cap=Buffer.byteLength(prefix)-1+5;
  const context=await collectWorkContext({root,baseline,limits:{gitBytes:cap}});
  assert.equal(context.history.truncated,true);
  assert.equal(context.history.items.length,1);
  assert.equal(context.history.items[0].hash,baseline.head);
  assert.equal(context.history.items[0].truncated,true);
});

test('service measures collection, passes evidence to runner, and excludes source data from timing diagnostics',async t=>{
  const root=await fixture();let time=1000,calls=0,received;
  const context={version:1,documents:{items:[{path:'README.md',text:'PRIVATE_EVIDENCE'}]}};
  const service=createWorkAnalysis({intervalMs:1e8,now:()=>time,fingerprint:async()=>({fingerprint:'fixed'}),
    collector:async args=>{calls++;assert.equal(args.root,root);assert.equal(args.mode,'initialize');time+=25;return context;},
    runner:async args=>{received=args.context;return {version:1,works:[]};},
  });t.after(()=>service.close());
  await service.start(root);const result=await service.wait(root);
  assert.equal(result.state,'idle');assert.equal(calls,1);assert.deepEqual(received,context);assert.equal(result.durationsMs.collect,25);
  assert.doesNotMatch(await readFile(path.join(root,'.workgraph/runtime/last-analysis.json'),'utf8'),/PRIVATE_EVIDENCE|README/);
  const prompt=await analysisPrompt({root,mode:'initialize',previous:{version:1,works:[],analysis:{snapshot:'EXTRA_METADATA_MUST_NOT_APPEAR'}},baseline:{head:'a'.repeat(40),snapshot:'EXTRA_BASELINE_MUST_NOT_APPEAR'},context});
  assert.match(prompt,/PRIVATE_EVIDENCE/);assert.match(prompt,/不可信数据/);assert.match(prompt,/仅针对结论缺口/);
  assert.doesNotMatch(prompt,/EXTRA_METADATA_MUST_NOT_APPEAR|EXTRA_BASELINE_MUST_NOT_APPEAR/);
});
