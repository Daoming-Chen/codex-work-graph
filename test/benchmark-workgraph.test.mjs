import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {eventAccumulator,shuffled,partitionContext,runCodexTask,executeScenario,runManifest,sanitizedError} from '../scripts/benchmark-workgraph.mjs';

const work={id:'WG-TEST',title:'Benchmark result',status:'进行中',commits:[],summary:'Design only',next:'Implement',parentId:null,kind:'work',outcomes:[],issues:['Not validated']};
async function directory(){await mkdir('.test-output',{recursive:true});return await mkdtemp(path.resolve('.test-output/bench-harness-'));}

test('JSONL parser handles chunk boundaries, reports actual usage and omits sensitive event content',()=>{
  let time=0;const parser=eventAccumulator({clock:()=>++time});
  const stream=[{type:'thread.started',thread_id:'thread'},
    {type:'item.started',item:{id:'cmd',type:'command_execution',command:'SECRET command'}},
    {type:'item.completed',item:{id:'cmd',type:'command_execution',aggregated_output:'PRIVATE SOURCE',status:'completed'}},
    {type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"ok":true}'}},
    {type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20,reasoning_output_tokens:5}}].map(event=>JSON.stringify(event)).join('\n');
  parser.push(stream.slice(0,31));parser.push(stream.slice(31));const result=parser.finish();
  assert.deepEqual(result.usage,{input_tokens:100,cached_input_tokens:40,output_tokens:20,reasoning_output_tokens:5});
  assert.equal(result.counts.command_execution,1);assert.equal(result.toolDurationsMs.command_execution,1);
  assert.equal(result.lastMessage,'{"ok":true}');assert.equal(result.malformed,0);
  assert.doesNotMatch(JSON.stringify(result.events),/SECRET|PRIVATE SOURCE/);
  assert.equal(eventAccumulator().finish().usage,null);
  assert.throws(()=>eventAccumulator({maxBytes:4}).push('12345'),/limit/);
});

test('shuffle is reproducible and role partition explicitly separates history and unrelated docs',()=>{
  assert.deepEqual(shuffled([1,2,3,4,5],42),shuffled([1,2,3,4,5],42));
  const context={documents:{items:[{path:'README.md'},{path:'modules/runtime.md'},{path:'verification/plan.md'}]},inventory:{items:['README.md','modules/runtime.md','verification/plan.md']},history:{items:[{hash:'abc'}]}};
  const result=partitionContext(context,{name:'architecture',matches:/^README|^modules/});
  assert.deepEqual(result.documents.items.map(item=>item.path),['README.md','modules/runtime.md']);
  assert.equal(result.history.items.length,0);assert.equal(result.history.delegatedTo,'history-verification');
  assert.equal(context.history.items.length,1);assert.equal(result.benchmarkScope.partial,true);
});

test('real child invocation supplies explicit settings, parses final schema output and never persists raw stderr',async()=>{
  const root=await directory(),script=path.join(root,'fake-cli.mjs');
  await writeFile(script,`import {writeFile} from 'node:fs/promises';
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const args=process.argv.slice(2);const target=args[args.indexOf('--output-last-message')+1];
const result={ok:true};await writeFile(target,JSON.stringify(result));
console.error('token=secret-value https://user:pass@example.test');
console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(result)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,cached_input_tokens:2,output_tokens:3}}));
`);
  const output=await runCodexTask({root,directory:path.join(root,'run'),model:'test-model',effort:'low',command:process.execPath,prefixArgs:[script],prompt:'A fixed prompt',schema:{type:'object'}});
  assert.equal(output.metrics.ok,true);assert.deepEqual(output.result,{ok:true});
  assert.equal(output.metrics.exitEventCode,0);
  assert.ok(output.metrics.processExitMs>=output.metrics.responseReadyMs);
  assert.ok(output.metrics.streamsClosedMs>=output.metrics.processExitMs);
  assert.deepEqual(output.metrics.usage,{input_tokens:7,cached_input_tokens:2,output_tokens:3});
  assert.ok(output.metrics.invocation.args.includes('model_reasoning_effort="low"'));
  assert.ok(output.metrics.invocation.args.includes('service_tier="priority"'));
  assert.ok(output.metrics.invocation.args.includes('agents.enabled=false'));
  assert.doesNotMatch(await readFile(path.join(root,'run/metrics.json'),'utf8'),/secret-value|user:pass/);
  assert.doesNotMatch(sanitizedError('token=abc https://user:pass@example.test sk-abcdef'),/abc|user:pass|sk-abcdef/);
});

test('parallel readers execute concurrently before merger; every call contributes usage and final validation',async()=>{
  const root=await directory();let readersActive=0,maxReaders=0,merged=false;
  const invoke=async args=>{
    const reader=args.schema!==undefined&&args.schema.properties?.findings;
    if(reader){readersActive++;maxReaders=Math.max(maxReaders,readersActive);await new Promise(resolve=>setTimeout(resolve,20));readersActive--;}
    else {assert.equal(readersActive,0);merged=true;assert.match(args.prompt,/子代理摘要/);assert.match(args.prompt,/"works":\[\]/);}
    return {result:reader?{version:1,role:path.basename(args.directory),findings:[],warnings:[]}:{version:1,works:[work]},metrics:{startedAt:new Date().toISOString(),ok:true,elapsedMs:20,usage:{input_tokens:100,cached_input_tokens:20,output_tokens:10}}};
  };
  const result=await executeScenario({root,context:{documents:{items:[]},inventory:{items:[]}},baseline:{head:'a'.repeat(40)},config:{id:'parallel',model:'test-model',effort:'low',readers:3},directory:path.join(root,'experiment'),invoke});
  assert.equal(maxReaders,3);assert.equal(merged,true);assert.equal(result.agentCount,4);assert.equal(result.taskCount,4);
  assert.deepEqual(result.usage,{input_tokens:400,cached_input_tokens:80,output_tokens:40});assert.equal(result.ok,true);assert.equal(result.validation.workCount,1);
  assert.equal(result.sumTaskMs,80);
});

test('reader failure prevents merger and missing usage remains unknown instead of zero',async()=>{
  const root=await directory();let calls=0;
  const result=await executeScenario({root,context:{},baseline:{},config:{id:'failed',model:'test-model',effort:'low',readers:2},directory:path.join(root,'experiment'),invoke:async()=>{calls++;return {result:null,metrics:{ok:false,elapsedMs:3,usage:null}};}});
  assert.equal(calls,2);assert.equal(result.ok,false);assert.equal(result.taskCount,2);assert.equal(result.usage,null);assert.equal(result.usageComplete,false);
});

test('a timed-out native child terminates and records unknown usage without a model substitution',async()=>{
  const root=await directory(),script=path.join(root,'slow-cli.mjs');
  await writeFile(script,'setTimeout(()=>{},5000);');
  const output=await runCodexTask({root,directory:path.join(root,'run'),model:'unavailable-test-model',effort:'low',command:process.execPath,prefixArgs:[script],prompt:'Probe',schema:{type:'object'},timeoutMs:50});
  assert.equal(output.metrics.ok,false);assert.equal(output.metrics.timedOut,true);assert.equal(output.metrics.error,'timeout');
  assert.equal(output.metrics.usage,null);assert.equal(output.metrics.requested.model,'unavailable-test-model');
});

test('a completed valid response stays available when CLI shutdown subsequently times out',async()=>{
  const root=await directory(),script=path.join(root,'completed-slow-exit.mjs');
  await writeFile(script,`let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
console.log(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:'{"ok":true}'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:0,output_tokens:3}}));
setTimeout(()=>{},5000);`);
  const output=await runCodexTask({root,directory:path.join(root,'run'),model:'test-model',effort:'low',command:process.execPath,prefixArgs:[script],prompt:'Probe',schema:{type:'object'},timeoutMs:350});
  assert.equal(output.metrics.ok,false);assert.equal(output.metrics.processOk,false);assert.equal(output.metrics.timedOut,true);
  assert.equal(output.metrics.responseUsable,true);assert.deepEqual(output.result,{ok:true});
  assert.ok(output.metrics.processExitMs>=output.metrics.responseReadyMs);
  assert.ok(output.metrics.streamsClosedMs>=output.metrics.processExitMs);
  assert.ok(output.metrics.responseReadyMs<output.metrics.elapsedMs);assert.ok(output.metrics.postResponseTailMs>0);
  assert.equal(output.metrics.postResponseTailCensored,true);assert.equal(output.metrics.usage.input_tokens,11);
});

test('parallel manifest completion persists every result and refuses to overwrite an existing experiment',async()=>{
  const root=await directory(),contextPath=path.join(root,'context.json'),baselinePath=path.join(root,'baseline.json');
  await writeFile(contextPath,'{}');await writeFile(baselinePath,'{}');
  const manifest={root,contextPath,baselinePath,outputDirectory:path.join(root,'experiments'),configs:[{id:'a',model:'test',effort:'low',readers:0},{id:'b',model:'test',effort:'low',readers:0}]};
  let active=0,maxActive=0;
  const invoke=async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return {result:{ok:true},metrics:{ok:true,elapsedMs:10,usage:{input_tokens:1,input_tokens_details:{cache_write_tokens:2}}}};};
  const output=await runManifest(manifest,{probe:true,repeat:2,maxConfigs:2,outputSuffix:'fixed',seed:9,invoke});
  const stored=JSON.parse(await readFile(path.join(output.directory,'results.json'),'utf8'));
  assert.equal(stored.length,4);assert.ok(stored.every(result=>result.ok));assert.equal(maxActive,2);
  assert.deepEqual(stored[0].usage.input_tokens_details,{cache_write_tokens:2});
  await assert.rejects(()=>runManifest(manifest,{outputSuffix:'fixed',invoke}),{code:'EEXIST'});
});
