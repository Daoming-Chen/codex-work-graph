import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkGraph } from '../src/ui/work-live.js';

function mount(t, initialCall,options={}) {
  const nodes=new Map();
  function node(id='') {
    const attributes={};
    const n={id,innerHTML:'',textContent:'',scrollTop:0,style:{setProperty(){}},setAttribute(key,value){attributes[key]=value;},attributes,getBoundingClientRect(){return {height:600};},before(x){nodes.set(x.id,x)},after(x){nodes.set(x.id,x)},classList:{toggle(){},contains(){return true}}};
    nodes.set(id,n);return n;
  }
  const old=globalThis.document;
  globalThis.document={getElementById:id=>nodes.get(id)||node(id),createElement:()=>node(),documentElement:{dataset:{}}};
  t.after(()=>{globalThis.document=old;});
  let call=initialCall;
  const ui=installWorkGraph({call:(...args)=>call(...args),...options}),$=id=>nodes.get(id);
  const click=(kind,value)=>$('work-prototype').onclick({target:{id:kind==='id'?value:'',closest:selector=>kind==='tab'&&selector==='[role="tab"]'?{id:value}:selector===`[data-${kind}]`?{dataset:{[kind]:value}}:null}});
  return {$,ui,click,setCall:fn=>{call=fn;}};
}
const sample=()=>({repository:{name:'REPO'},works:[
  {id:'A',title:'接口工作',summary:'父级完整摘要',next:'父级下一步',status:'进行中'},
  {id:'A1',parentId:'A',title:'读取接口',summary:'已支持历史读取',next:'补充边界验证',status:'进行中',issues:['验证尚未结束']},
  {id:'A2',parentId:'A',kind:'outcome',title:'旧请求隔离',summary:'已隔离旧请求',status:'已完成',outcomes:['旧响应不能覆盖新工作']},
  {id:'B',title:'使用文档',summary:'说明已整理',next:'持续维护',status:'已完成',updatedAt:'2026-10-28T08:00:00.000Z'}
],records:[
  {hash:'a1234567890',workId:'A1',title:'fix: stale request',time:'2026-10-28T08:00:00Z'},
  {hash:'a2345678901',workId:'A',title:'feat: work records',time:'2026-10-27T08:00:00Z'},
  {hash:'b1234567890',workId:'B',title:'docs: usage',time:'2026-10-26T08:00:00Z'}
],dirty:[]});

test('initialization and update buttons route analysis and show failures without losing records',async t=>{
  let data=sample(),calls=[];
  const {ui,$}=mount(t,async(route,args)=>{calls.push({route,args});return route==='work_analyze'?{state:'running'}:data;});
  await ui.update();assert.equal($('work-analyze').textContent,'更新工作地图');
  await $('work-analyze').onclick();assert.equal(calls.at(-1).args.mode,'auto');
  assert.equal($('work-analyze').disabled,true);assert.match($('work-analysis-status').textContent,/正在分析/);
  data={...sample(),initialized:true,analysis:{state:'failed',error:'offline'}};
  await ui.update();assert.match($('work-analysis-status').textContent,/offline/);
  assert.match($('work-rows').innerHTML,/data-record="A"/);
  await $('work-analyze').onclick();assert.equal(calls.at(-1).args.mode,'auto');
});

test('analysis status shows measured phase and elapsed time, then the successful duration',async t=>{
  let data={...sample(),initialized:true,analysis:{state:'running',phase:'recheck',elapsedMs:42500}};
  const {ui,$}=mount(t,async()=>data);await ui.update();
  assert.match($('work-analysis-status').textContent,/复核项目变化 · 已用 42.5 秒/);
  assert.doesNotMatch($('work-analysis-status').textContent,/%/);
  data={...sample(),initialized:true,analysis:{state:'idle',lastRun:{state:'idle',elapsedMs:47230}}};
  await ui.update();assert.match($('work-analysis-status').textContent,/上次分析完成，用时 47.2 秒/);
  data.analysis={state:'running',phase:'collect',elapsedMs:300};await ui.update();
  assert.match($('work-analysis-status').textContent,/收集分析材料 · 已用 0.3 秒/);
});

test('Agent-maintained maps label CLI duration as saving rather than model analysis',async t=>{
  const data={...sample(),initialized:true,analysis:{state:'idle',lastRun:{state:'idle',execution:'agent-save',elapsedMs:500}}};
  const {ui,$}=mount(t,async()=>data);await ui.update();
  assert.match($('work-analysis-status').textContent,/上次保存完成（不含 Agent 分析）/);
  assert.doesNotMatch($('work-analysis-status').textContent,/上次分析完成/);
});

test('idle polling uses lightweight status and reloads external work records every fifteen seconds',async t=>{
  let time=0,graphs=0,statuses=0;
  const {ui,$}=mount(t,async route=>{
    if(route==='work_status'){statuses++;return {state:'idle'};}
    graphs++;const data=sample();data.analysis={state:'idle'};data.works[0].title=graphs===1?'接口工作':'外部更新的工作';return data;
  },{now:()=>time});
  await ui.update();
  for(time=5000;time<=10000;time+=5000)await ui.poll();
  assert.equal(graphs,1);assert.equal(statuses,2);
  time=15000;await ui.poll();assert.equal(graphs,2);assert.match($('work-rows').innerHTML,/外部更新的工作/);
  globalThis.document.hidden=true;time=30000;await ui.poll();assert.equal(statuses,3);assert.equal(graphs,2);
});

test('running polls fetch only progress and completion reloads newly saved work',async t=>{
  let time=0,graphs=0,complete=false;
  const {ui,$}=mount(t,async route=>{
    const status=complete?{state:'idle',completedAt:'2026-11-04T05:00:00Z'}:{state:'running',phase:'analysis',elapsedMs:time};
    if(route==='work_status')return status;
    graphs++;return {...sample(),initialized:true,analysis:status};
  },{now:()=>time});
  await ui.update();
  for(time=5000;time<=30000;time+=5000)await ui.poll();
  assert.equal(graphs,1);assert.match($('work-analysis-status').textContent,/已用 30.0 秒/);
  complete=true;await ui.poll();assert.equal(graphs,2);assert.equal($('work-analyze').disabled,false);
});

test('old lightweight status cannot overwrite newer manual analysis or refresh in the same repository',async t=>{
  let resolve;
  const {ui,$,setCall}=mount(t,async()=>({...sample(),analysis:{state:'idle'}}));await ui.update();
  setCall(route=>route==='work_status'?new Promise(r=>{resolve=r;}):Promise.resolve({state:'running',phase:'collect',elapsedMs:100}));
  const oldPoll=ui.poll();await $('work-analyze').onclick();
  resolve({state:'idle'});await oldPoll;
  assert.equal($('work-analyze').disabled,true);assert.match($('work-analysis-status').textContent,/收集分析材料/);
  const secondPoll=ui.poll();
  setCall(async()=>({...sample(),initialized:true,analysis:{state:'running',phase:'save',elapsedMs:1000}}));await ui.update();
  resolve({state:'failed',error:'old status'});await secondPoll;
  assert.match($('work-analysis-status').textContent,/保存工作记录/);assert.doesNotMatch($('work-analysis-status').textContent,/old status/);
});

test('pending manual analysis suppresses status polling and old repository polls cannot restore prior data',async t=>{
  let resolve,statusCalls=0;
  const {ui,$,setCall}=mount(t,async()=>({...sample(),analysis:{state:'idle'}}));await ui.update();
  setCall(route=>{if(route==='work_analyze')return new Promise(r=>{resolve=r;});statusCalls++;return Promise.resolve({state:'idle'});});
  const pending=$('work-analyze').onclick();await ui.poll();assert.equal(statusCalls,0);
  resolve({state:'running'});await pending;
  setCall(()=>new Promise(r=>{resolve=r;}));const oldPoll=ui.poll();
  ui.reset();setCall(async()=>({...sample(),initialized:true,analysis:{state:'idle'}}));await ui.update();
  resolve({state:'running',phase:'analysis'});await oldPoll;
  assert.equal($('work-analyze').disabled,false);assert.equal($('work-analyze').textContent,'更新工作地图');
});

test('an old analysis response cannot alter the newly selected repository',async t=>{
  let resolve;
  const {ui,$,setCall}=mount(t,async()=>sample());await ui.update();
  setCall(()=>new Promise(r=>resolve=r));const pending=$('work-analyze').onclick();
  ui.reset();setCall(async()=>({...sample(),initialized:true}));await ui.update();
  resolve({state:'running'});await pending;
  assert.equal($('work-analyze').textContent,'更新工作地图');assert.equal($('work-analyze').disabled,false);
});

test('old repository responses and failed refreshes cannot retain previous evidence',async t=>{
  let resolve;const {ui,$,setCall}=mount(t,()=>new Promise(r=>{resolve=r}));
  const first=ui.update();ui.reset();resolve(sample());await first;assert.equal($('work-project').textContent,'');
  setCall(async()=>sample());await ui.update();assert.equal($('work-project').textContent,'REPO');
  $('work-detail').innerHTML='old evidence';setCall(async()=>{throw Error('invalid records')});await ui.update();
  assert.equal($('work-detail').innerHTML,'');assert.equal($('work-count').textContent,'工作记录读取失败');assert.equal($('work-detail').hidden,true);
});

test('compact rows contain only work metadata and expand child work, never commits',async t=>{
  const {ui,$,click}=mount(t,async()=>sample());await ui.update();
  const html=$('work-rows').innerHTML;
  assert.match(html,/data-record="A"/);assert.match(html,/data-record="B"/);
  assert.doesNotMatch(html,/父级完整摘要|父级下一步|data-record="A1"|stale request|work-node/);
  assert.match(html,/尚未记录更新时间/);assert.match(html,/2026-10-28T08:00:00.000Z/);
  assert.equal($('work-detail').hidden,true);
  await click('expand','A');assert.match($('work-rows').innerHTML,/data-record="A1"/);assert.match($('work-rows').innerHTML,/data-record="A2"/);
  assert.doesNotMatch($('work-rows').innerHTML,/stale request|a1234567890/);
  await ui.update();assert.match($('work-rows').innerHTML,/data-record="A1"/);
  await click('expand','A');assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"/);
});

test('selecting titles updates one bottom pane without changing list scroll or expansion',async t=>{
  const {ui,$,click}=mount(t,async()=>sample());await ui.update();await click('expand','A');
  $('work-list').scrollTop=147;await click('record','A1');
  assert.equal($('work-list').scrollTop,147);assert.equal($('work-detail').hidden,false);assert.equal($('work-resize').hidden,false);
  assert.match($('work-detail').innerHTML,/已支持历史读取|验证尚未结束/);
  await click('record','B');assert.match($('work-detail').innerHTML,/说明已整理/);assert.equal($('work-list').scrollTop,147);
  assert.match($('work-rows').innerHTML,/data-record="A1"/);
  const oldDetail=$('work-detail').innerHTML;await click('expand','A');assert.equal($('work-detail').innerHTML,oldDetail);
  await click('id','work-close');assert.equal($('work-detail').hidden,true);assert.equal($('work-resize').hidden,true);
});

test('search reveals matching children with ancestor context; filtering during refresh keeps latest data',async t=>{
  const {ui,$,click,setCall}=mount(t,async()=>sample());await ui.update();
  $('work-search').oninput({target:{value:'stale request'}});
  assert.match($('work-rows').innerHTML,/data-record="A"/);assert.match($('work-rows').innerHTML,/data-record="A1"/);
  assert.doesNotMatch($('work-rows').innerHTML,/data-record="A2"|data-record="B"|stale request/);
  await click('expand','A');assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"/);
  $('work-search').oninput({target:{value:''}});assert.match($('work-rows').innerHTML,/data-record="B"/);
  let resolve;setCall(()=>new Promise(r=>{resolve=r}));const refresh=ui.update();$('work-filter').onchange({target:{value:'已完成'}});
  const next=sample();next.repository.name='REFRESHED';resolve(next);await refresh;
  assert.equal($('work-project').textContent,'REFRESHED');assert.match($('work-rows').innerHTML,/data-record="A2"|data-record="B"/);assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"/);
});

test('parent evidence aggregates labeled children, while children never inherit parent commits',async t=>{
  const {ui,$,click}=mount(t,async()=>sample());await ui.update();await click('record','A');await click('tab','work-tab-evidence');
  assert.match($('work-detail').innerHTML,/data-patch="a1234567890"/);assert.match($('work-detail').innerHTML,/来自子项：读取接口/);
  assert.match($('work-detail').innerHTML,/data-patch="a2345678901"/);
  await click('expand','A');await click('record','A1');assert.match($('work-detail').innerHTML,/data-patch="a1234567890"/);assert.doesNotMatch($('work-detail').innerHTML,/data-patch="a2345678901"/);
  await click('record','A2');assert.match($('work-detail').innerHTML,/暂无明确关联的提交/);
});

test('matching a parent reveals its children and status filtering still excludes nonmatching descendants',async t=>{
  const {ui,$,click}=mount(t,async()=>sample());await ui.update();
  $('work-search').oninput({target:{value:'接口工作'}});
  assert.match($('work-rows').innerHTML,/data-record="A1"/);assert.match($('work-rows').innerHTML,/data-record="A2"/);
  await click('expand','A');assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"/);
  await click('expand','A');assert.match($('work-rows').innerHTML,/data-record="A1"/);
  $('work-filter').onchange({target:{value:'已完成'}});
  assert.match($('work-rows').innerHTML,/data-record="A"/);assert.match($('work-rows').innerHTML,/data-record="A2"/);
  assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"|data-record="B"/);
});

test('closing, changing tabs or repository invalidates pending diff responses',async t=>{
  let resolve;const {ui,$,click}=mount(t,route=>route==='work_graph'?Promise.resolve(sample()):new Promise(r=>{resolve=r}));
  await ui.update();await click('record','A');await click('tab','work-tab-evidence');
  const first=click('patch','a1234567890');await click('id','work-close');resolve({patch:'OLD PATCH'});await first;assert.notEqual($('work-real-patch').textContent,'OLD PATCH');
  await click('record','A');const second=click('patch','a1234567890');await click('tab','work-tab-progress');resolve({patch:'OTHER PATCH'});await second;assert.notEqual($('work-real-patch').textContent,'OTHER PATCH');
  ui.reset();await ui.update();assert.equal($('work-search').value,'');assert.equal($('work-filter').value,'全部');assert.equal($('work-detail').hidden,true);assert.doesNotMatch($('work-rows').innerHTML,/data-record="A1"/);
});

test('detail resizing is bounded and supports pointer and keyboard adjustments',async t=>{
  const {ui,$,click}=mount(t,async()=>sample());await ui.update();await click('record','A');
  const handle=$('work-resize');assert.ok(Math.abs(parseFloat($('work-detail').style.height)-204)<1);
  handle.onkeydown({key:'End',preventDefault(){}});assert.equal($('work-detail').style.height,'360px');
  handle.onkeydown({key:'Home',preventDefault(){}});assert.equal($('work-detail').style.height,'140px');
  handle.onpointerdown({button:0,clientY:400,preventDefault(){}});handle.onpointermove({clientY:-500});assert.equal($('work-detail').style.height,'360px');handle.onpointerup();
  handle.onpointermove({clientY:1000});assert.equal($('work-detail').style.height,'360px');
});

test('filter feedback separates ancestor context and excludes unassigned progress',async t=>{
  const data=sample();data.works.push({id:'UNASSIGNED',title:'待归类提交',status:'待开始'});
  const {ui,$}=mount(t,async()=>data);await ui.update();
  assert.match($('work-count').textContent,/仓库总计 2 条动线/);
  $('work-filter').onchange({target:{value:'已完成'}});
  assert.match($('work-count').textContent,/匹配 1 条动线 · 1 项/);
  assert.match($('work-rows').innerHTML,/work-context/);assert.match($('work-rows').innerHTML,/所属工作/);
  $('work-filter').onchange({target:{value:'待开始'}});
  assert.doesNotMatch($('work-rows').innerHTML,/data-record="UNASSIGNED"/);
});

test('parent outcomes include nested sources independently of filters and deduplicate within source',async t=>{
  const data=sample();data.works[0].outcomes=['本层成果'];
  data.works.push({id:'A3',parentId:'A2',title:'嵌套来源',status:'进行中',outcomes:['相同成果','相同成果']});
  data.works[2].outcomes.push('相同成果');
  const {ui,$,click}=mount(t,async()=>data);await ui.update();
  $('work-filter').onchange({target:{value:'已完成'}});await click('record','A');
  assert.match($('work-detail').innerHTML,/本层成果/);assert.match($('work-detail').innerHTML,/来自子项：嵌套来源/);
  assert.equal(($('work-detail').innerHTML.match(/<li>相同成果<\/li>/g)||[]).length,2);
});

test('unassigned progress explains classification without work outcome claims',async t=>{
  const data=sample();data.works.push({id:'UNASSIGNED',title:'待归类提交',status:'待归类'});
  data.records.push({workId:'UNASSIGNED',hash:'c1234567890',title:'unowned'});
  const {ui,$,click}=mount(t,async()=>data);await ui.update();await click('record','UNASSIGNED');
  const html=$('work-detail').innerHTML;
  assert.match(html,/归类说明/);assert.match(html,/当前加载范围内有 1 个提交/);assert.match(html,/请 Agent 核对提交归属后更新工作记录/);
  assert.doesNotMatch(html,/<h3>成果|尚未记录具体成果|问题与边界|当前进展/);
});
