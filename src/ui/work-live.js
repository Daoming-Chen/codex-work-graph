import { icons } from './icons.js';
// Read-only work projection. Agent-maintained records provide intent; Git provides evidence.
export function installWorkGraph({call,now=Date.now}) {
  const $=id=>document.getElementById(id);
  const icon=name=>icons[name].replace('<svg ', '<svg class="icon" aria-hidden="true" focusable="false" ');
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data,selected=null,query='',filter='全部',generation=0,request=0,patchRequest=0,detail=false,tab='progress',detailRatio=.34,drag=null;
  let refreshedAt=0,analysisPending=0;
  const expanded=new Set(),searchCollapsed=new Set();
  const toggle=document.createElement('button');toggle.id='work-mode';toggle.textContent='Git 历史';$('repo-name').after(toggle);
  const brand=document.createElement('strong');brand.className='work-brand';brand.textContent='WorkGraph';toggle.before(brand);
  const root=document.createElement('section');root.id='work-prototype';root.setAttribute('aria-label','仓库工作进展');
  root.innerHTML=`<div class="work-overview"><div class="work-heading"><h1>工作进展</h1><span id="work-project"></span></div><div id="work-lanes" class="work-lanes" aria-label="工作状态总览"></div></div>
    <div class="work-toolbar"><select id="work-filter" aria-label="工作状态筛选"><option>全部</option><option>进行中</option><option>已完成</option><option>已搁置</option><option>待开始</option></select><input id="work-search" type="search" placeholder="搜索工作与依据" aria-label="搜索工作与依据"><span class="grow"></span><button id="work-analyze">更新工作地图</button><button id="work-reload">刷新</button><button id="work-theme" aria-label="切换明暗主题">主题</button></div>
    <div id="work-analysis-status" class="work-analysis-status" role="status"></div><div class="work-layout" id="work-layout"><section class="work-list" id="work-list" aria-label="工作动线"><div class="work-list-heading"><span>工作动线 / 子工作与成果</span><span>状态</span><span>最近更新</span></div><div id="work-rows"></div></section><div id="work-resize" role="separator" aria-label="调整工作详情高度" aria-orientation="horizontal" aria-valuemin="20" aria-valuemax="60" aria-valuenow="34" tabindex="0" hidden></div><aside id="work-detail" aria-label="工作详情" hidden></aside></div>
    <div class="work-footer muted"><span id="work-count" role="status"></span><span>本地工作记录与 Git</span></div>`;
  $('workspace').before(root);
  $('work-reload').innerHTML=icon('refresh')+'<span>刷新</span>';
  $('work-theme').innerHTML=icon('color-mode');
  $('work-theme').title='切换明暗主题';
  const mode=on=>{$('app').classList.toggle('work-mode',on);toggle.textContent=on?'Git 历史':'工作进展';};
  toggle.onclick=()=>mode(!$('app').classList.contains('work-mode'));mode(true);
  const statusClass=status=>status==='已完成'?'done':status==='进行中'?'active':'other';
  const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
  const children=id=>data.works.filter(w=>(w.parentId||null)===id);
  function descendants(id) {return [id,...children(id).flatMap(w=>descendants(w.id))];}
  function matchingIds() {
    const ids=new Set(),matches=new Set(),queryMatches=new Set();
    for(const w of data.works) {
      const records=data.records.filter(r=>r.workId===w.id);
      const text=[w.id,w.title,w.summary,w.next,...(w.outcomes||[]),...(w.issues||[]),...records.map(r=>`${r.title} ${r.hash}`)].join(' ').toLowerCase();
      if(!query||text.includes(query))queryMatches.add(w.id);
    }
    for(const w of data.works) {
      let ancestor=w,queryMatch=false;
      while(ancestor&&!queryMatch){queryMatch=queryMatches.has(ancestor.id);ancestor=data.works.find(x=>x.id===ancestor.parentId);}
      if((filter==='全部'||(w.id!=='UNASSIGNED'&&filter===w.status))&&queryMatch) {
        matches.add(w.id);let current=w;
        while(current&&!ids.has(current.id)){ids.add(current.id);current=data.works.find(x=>x.id===current.parentId);}
      }
    }
    return {ids,matches};
  }
  function applySize() {
    const layoutHeight=$('work-layout').getBoundingClientRect?.().height||600;
    // Never let the detail pane take more than 60%; retain at least 120px of list.
    const max=Math.max(0,Math.min(layoutHeight*.6,layoutHeight-126));
    const height=Math.min(max,Math.max(Math.min(140,max),layoutHeight*detailRatio));
    $('work-detail').style.height=height+'px';
    $('work-resize').setAttribute('aria-valuenow',String(Math.round(detailRatio*100)));
  }
  function showDetail(on) {$('work-detail').hidden=!on;$('work-resize').hidden=!on;if(on)applySize();}
  function reset() {
    generation++;request++;patchRequest++;data=null;selected=null;detail=false;tab='progress';query='';filter='全部';expanded.clear();searchCollapsed.clear();analysisPending=0;refreshedAt=0;
    $('work-search').value='';$('work-filter').value='全部';$('work-rows').innerHTML='';$('work-detail').innerHTML='';showDetail(false);
    $('work-analysis-status').textContent='';$('work-analyze').disabled=true;$('work-lanes').textContent='';$('work-project').textContent='';$('work-count').textContent='读取工作记录…';$('work-list').scrollTop=0;
  }
  function renderDetail() {
    const w=data.works.find(w=>w.id===selected);
    if(!w||!detail){showDetail(false);return;}
    const ids=new Set(descendants(w.id)),records=data.records.filter(r=>ids.has(r.workId));
    const parent=data.works.find(x=>x.id===w.parentId);
    const outcomeGroups=[w,...data.works.filter(x=>x.id!==w.id&&ids.has(x.id))].map(owner=>({owner,values:[...new Set(owner.outcomes||[])]})).filter(group=>group.values.length);
    const outcomes=outcomeGroups.length?outcomeGroups.map(({owner,values})=>`<p class="muted">${owner.id===w.id?'本层成果':`来自子项：${esc(owner.title)}（${esc(owner.id)}）`}</p><ul>${values.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`).join(''):'<p class="muted">本工作及子项尚未记录具体成果。</p>';
    const list=(values,empty)=>values?.length?`<ul>${values.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:`<p class="muted">${empty}</p>`;
    $('work-detail').innerHTML=`<div class="detail-bar"><div class="work-detail-title">${parent?`<span>${esc(parent.title)} / </span>`:''}<strong>${esc(w.title)}</strong></div><span class="work-status ${statusClass(w.status)}">${esc(w.id==='UNASSIGNED'?'待归类':w.status)}</span><button id="work-close" aria-label="关闭工作详情">收起</button></div>
      <div class="work-detail-tabs" role="tablist" aria-label="工作详情内容"><button id="work-tab-progress" role="tab" aria-selected="${tab==='progress'}" aria-controls="work-detail-content">进展</button><button id="work-tab-evidence" role="tab" aria-selected="${tab==='evidence'}" aria-controls="work-detail-content">代码依据 <span>${records.length}</span></button><span class="grow"></span><span class="work-updated">记录更新 ${time(w.updatedAt)}</span></div>
      <div class="work-detail-body" id="work-detail-content" role="tabpanel" aria-labelledby="work-tab-${tab}">${tab==='progress'?w.id==='UNASSIGNED'?`<div class="work-progress-content"><section><h3>归类说明</h3><p>当前加载范围内有 ${records.length} 个提交尚未记录工作归属${data.hasMore?'，历史已截断':''}。此入口不表示工作进度。</p></section><section><h3>下一步</h3><p>在仓库聊天中请 Agent 核对提交归属后更新工作记录。</p><p class="muted">提交不代表验证、完成或用户验收。</p></section></div>`:`<div class="work-progress-content"><section><h3>当前进展</h3><p>${esc(w.summary||'尚未填写进展摘要。')}</p><h3>下一步</h3><p>${esc(w.next||'尚未填写下一步。')}</p></section><section><h3>成果</h3>${outcomes}<h3>问题与边界</h3>${list(w.issues,'尚未记录问题；不代表已完成验证或用户验收。')}</section></div>`:`<div class="work-evidence-content"><p class="work-evidence-note">${w.id==='UNASSIGNED'?'这些提交尚未记录工作归属。':w.parentId?'仅列本工作及子项的关联，不继承父动线的提交。':'包含本动线及子项的明确关联提交，子项来源单独标注。'}提交不代表验证或用户验收。</p>${records.length?`<div class="work-evidence-records">${records.map(r=>{const owner=data.works.find(x=>x.id===r.workId);return `<button class="work-evidence-record" data-patch="${esc(r.hash)}"><code>${esc(r.hash.slice(0,7))}</code><span>${esc(r.title)}${r.workId!==w.id?`<small>来自子项：${esc(owner?.title||r.workId)}</small>`:''}</span><time>${time(r.time)}</time></button>`;}).join('')}</div>`:'<p class="muted">暂无明确关联的提交。</p>'}<pre id="work-real-patch" hidden></pre><details class="work-dirty"><summary>仓库未提交文件 · ${data.dirty.length}</summary><p class="muted">以下文件属于仓库现场，未自动分配给本工作。</p><p class="mono">${data.dirty.map(f=>esc(f.path)).join('<br>')||'工作区干净'}</p></details></div>`}</div>`;
    showDetail(true);
  }
  function render({detailOnly=false,preserveDetail=false}={}) {
    if(!data)return;
    if(detailOnly){renderDetail();return;}
    const scrollTop=$('work-list').scrollTop||0,focus=document.activeElement?.dataset;
    const {ids:allowed,matches}=matchingIds(),roots=children(null),normalRoots=roots.filter(w=>w.id!=='UNASSIGNED'),visible=[];
    const walk=(work,depth)=>{
      if(!allowed.has(work.id))return;
      const nested=children(work.id),autoOpen=(query||filter!=='全部')&&nested.some(c=>allowed.has(c.id));
      const open=expanded.has(work.id)||(autoOpen&&!searchCollapsed.has(work.id));
      visible.push({work,depth,open,hasChildren:nested.some(child=>allowed.has(child.id))});if(open)nested.forEach(child=>walk(child,depth+1));
    };
    roots.forEach(w=>walk(w,0));
    if(selected&&!allowed.has(selected)){selected=null;detail=false;}
    $('work-project').textContent=data.repository.name;
    $('work-lanes').innerHTML=`<span class="work-total"><strong>${normalRoots.length}</strong> 条动线（仓库总计）</span>`+['进行中','已完成','已搁置','待开始'].map(status=>{const count=normalRoots.filter(w=>w.status===status).length;return count?`<span class="work-stat ${statusClass(status)}"><i></i><strong>${count}</strong> ${status}</span>`:'';}).join('');
    $('work-count').textContent=`${query||filter!=='全部'?`匹配 ${normalRoots.filter(w=>matches.has(w.id)).length} 条动线 · ${data.works.filter(w=>w.parentId&&matches.has(w.id)).length} 项子工作与成果 · ${matches.has('UNASSIGNED')?'1 个待归类入口 · ':''}`:''}仓库总计 ${normalRoots.length} 条动线 · ${data.works.filter(w=>w.parentId).length} 项子工作与成果 · ${data.records.length} 个提交${data.hasMore?' · 历史已截断':''}`;
    $('work-rows').innerHTML=visible.map(({work:w,depth,open,hasChildren})=>`<div class="work-row ${depth?'work-child':'work-root'} ${w.id===selected?'selected':''} ${matches.has(w.id)?'':'work-context'}" style="--work-depth:${depth}"><div class="work-row-title">${hasChildren?`<button class="work-expand" data-expand="${esc(w.id)}" aria-expanded="${open}" aria-label="${open?'收起':'展开'} ${esc(w.title)} 的子工作与成果">${icon('chevron-right')}</button>`:'<span class="work-expand-placeholder" aria-hidden="true"></span>'}<button class="work-title" data-record="${esc(w.id)}" aria-pressed="${w.id===selected}" title="${esc(w.title)}"><span>${esc(w.title)}${w.kind==='outcome'?' <small class="work-kind">成果</small>':''}${matches.has(w.id)?'':' <small>所属工作</small>'}</span></button></div><span class="work-status ${statusClass(w.status)}">${esc(w.id==='UNASSIGNED'?'待归类':w.status)}</span><time title="${esc(w.updatedAt||'尚未记录更新时间')}">${time(w.updatedAt)}</time></div>`).join('')||'<div class="work-empty"><strong>没有匹配的工作</strong><p>试试其他关键词或工作状态。</p></div>';
    if(focus?.record||focus?.expand){Array.from(root.querySelectorAll?.('[data-record], [data-expand]')||[]).find(control=>focus.record?control.dataset.record===focus.record:control.dataset.expand===focus.expand)?.focus({preventScroll:true});}
    $('work-list').scrollTop=scrollTop;if(!preserveDetail)renderDetail();
  }
  function renderAnalysis() {
    const status=data?.analysis;
    const running=status?.state==='running';
    const seconds=value=>`${(Math.max(0,value)/1000).toFixed(1)} 秒`;
    const labels={prepare:'准备分析',fingerprint:'检查项目变化',collect:'收集分析材料',analysis:'本机 Codex 正在分析项目',validate:'校验工作项',recheck:'复核项目变化',save:'保存工作记录'};
    const elapsed=Number.isFinite(status?.elapsedMs)?` · 已用 ${seconds(status.elapsedMs)}`:'';
    const last=status?.lastRun;
    const summary=last?.state==='idle'&&Number.isFinite(last.elapsedMs)?`${last.execution==='agent-save'?'上次保存完成（不含 Agent 分析）':'上次分析完成'}，用时 ${seconds(last.elapsedMs)} · `:'';
    $('work-analyze').disabled=running||status?.state==='unavailable';
    $('work-analyze').textContent=running?'正在分析…':'更新工作地图';
    $('work-analysis-status').textContent=running?`${labels[status.phase]||labels.analysis}${elapsed}，完成后将自动显示。`:status?.state==='unavailable'?status.error:status?.error?`分析未完成：${status.error} 原有记录已保留，可点击重试。`:`${summary}${data?.initialized?'仅在你要求时更新工作地图。':'尚未建立工作地图，请在聊天中要求 Agent 更新。'}`;
  }
  async function analyze() {
    const epoch=generation,seq=++request;analysisPending=seq;
    $('work-analyze').disabled=true;
    try {
      const status=await call('work_analyze',{mode:'auto'});
      if(epoch!==generation||seq!==request)return;
      if(data){data.analysis=status;renderAnalysis();}
    } catch(error){if(epoch===generation&&seq===request){$('work-analysis-status').textContent=error.message;$('work-analyze').disabled=false;}}
    finally{if(epoch===generation&&analysisPending===seq)analysisPending=0;}
  }
  async function update() {
    const epoch=generation,seq=++request;
    try{const result=await call('work_graph');if(epoch!==generation||seq!==request)return;const changed=JSON.stringify([data?.repository,data?.works,data?.records,data?.dirty])!==JSON.stringify([result.repository,result.works,result.records,result.dirty]);data=result;refreshedAt=now();renderAnalysis();if(changed){patchRequest++;render();}}
    catch(error){if(epoch===generation&&seq===request){patchRequest++;data=null;selected=null;detail=false;$('work-detail').innerHTML='';showDetail(false);$('work-lanes').textContent='';$('work-rows').textContent=error.message;$('work-count').textContent='工作记录读取失败';}}
  }
  async function poll() {
    if(!data||analysisPending||document.hidden)return;
    const epoch=generation,seq=request,previous=data.analysis;
    try {
      const status=await call('work_status');
      if(epoch!==generation||seq!==request||!data||data.analysis!==previous)return;
      const changed=(previous?.state||'idle')!==status.state||(previous?.completedAt??null)!==(status.completedAt??null)||(previous?.lastRun?.completedAt??null)!==(status.lastRun?.completedAt??null);
      data.analysis=status;renderAnalysis();
      // During analysis only progress is needed. Idle refreshes still observe
      // Git activity and records changed by another process at least every 15s.
      if(changed||(status.state!=='running'&&now()-refreshedAt>=15000))await update();
    } catch(error){if(epoch===generation&&seq===request&&data?.analysis===previous)$('work-analysis-status').textContent=`分析状态读取失败：${error.message}`;}
  }
  root.onclick=async event=>{
    const expander=event.target.closest('[data-expand]');
    if(expander){const id=expander.dataset.expand;const autoOpen=(query||filter!=='全部')&&!searchCollapsed.has(id);if(expanded.has(id)||autoOpen){expanded.delete(id);searchCollapsed.add(id);}else{expanded.add(id);searchCollapsed.delete(id);}render({preserveDetail:true});return;}
    const row=event.target.closest('[data-record]');
    if(row){patchRequest++;selected=row.dataset.record;detail=true;render();return;}
    if(event.target.id==='work-close'){patchRequest++;detail=false;showDetail(false);return;}
    const tabButton=event.target.closest('[role="tab"]');
    if(tabButton){patchRequest++;tab=tabButton.id==='work-tab-evidence'?'evidence':'progress';render({detailOnly:true});return;}
    const commit=event.target.closest('[data-patch]');
    if(commit){
      const id=selected,hash=commit.dataset.patch,epoch=generation,seq=++patchRequest,pane=$('work-real-patch');
      pane.hidden=false;pane.textContent='读取差异…';
      try{const result=await call('commit',{hash});if(epoch===generation&&seq===patchRequest&&selected===id)pane.textContent=result.patch+(result.truncated?'\n[差异已截断]':'');}
      catch(error){if(epoch===generation&&seq===patchRequest&&selected===id)pane.textContent=error.message;}
    }
  };
  const resize=$('work-resize');
  resize.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();drag={y:event.clientY,ratio:detailRatio,height:$('work-layout').getBoundingClientRect().height};resize.setPointerCapture?.(event.pointerId);};
  resize.onpointermove=event=>{if(!drag)return;detailRatio=Math.max(.2,Math.min(.6,drag.ratio+(drag.y-event.clientY)/drag.height));applySize();};
  resize.onpointerup=resize.onpointercancel=()=>{drag=null;};
  resize.onkeydown=event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();detailRatio=event.key==='Home'?.2:event.key==='End'?.6:Math.max(.2,Math.min(.6,detailRatio+(event.key==='ArrowUp'?.05:-.05)));applySize();};
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(detail)applySize();}).observe($('work-layout'));
  $('work-filter').onchange=event=>{patchRequest++;filter=event.target.value;searchCollapsed.clear();render();};
  $('work-search').oninput=event=>{patchRequest++;query=event.target.value.trim().toLowerCase();searchCollapsed.clear();render();};
  $('work-analyze').onclick=()=>analyze();
  $('work-reload').onclick=()=>update();$('work-theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';};
  if(typeof window!=='undefined'){let polling=false;const timer=setInterval(async()=>{if(polling)return;polling=true;try{await poll();}finally{polling=false;}},5000);window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});}
  reset();return {reset,update,poll};
}
