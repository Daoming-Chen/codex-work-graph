import { createWorkspaceSession, resetRepositoryState, isStaleWorkspace } from './workspace.js';
import { installFeatures } from './features.js';
import { icons } from './icons.js';
import { App } from '@modelcontextprotocol/ext-apps';
import { layoutGraph } from '../graph.mjs';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const token = new URLSearchParams(location.hash.slice(1)).get('token');
const state = { data:null, repositoryPath:null, active:null, selected:null, limit:300, scope:'', rows:[], detailInput:null, detail:null, file:null, detailRequest:0, diffRequest:0, refreshRequest:0, matches:[], match:-1, compare:null, message:'', pending:false, checked:new Set() };
let workGraph;
let app, bridgeReady, lastFocus, actionSpec, prepared, graphOffset=0, features, contextBinding=false, contextRequest=0, contextSignature, contextInFlight=false, contextQueued=false, contextDisposed=false;
const workspace=createWorkspaceSession();
const groups = {staged:'已暂存',unstaged:'未暂存',untracked:'未跟踪',conflict:'冲突',commit:'变更文件',comparison:'历史 → 工作目录'};
const notify = text => { $('error').textContent = text || ''; $('error').hidden = !text; };
async function call(route, args = {}) {
  const session=workspace.capture(), repositoryPath=state.repositoryPath;
  try {
  if (token) {
    const write = ['prepare','execute','save_preferences','work_analyze'].includes(route), q = new URLSearchParams();
    if (!write) for (const [key,value] of Object.entries(args)) if (value !== undefined) q.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const response = await fetch(`/api/${route}?${q}`, {method:write?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(write?{'Content-Type':'application/json'}:{})},...(write?{body:JSON.stringify(args)}:{}),signal:AbortSignal.any([session.signal,AbortSignal.timeout(write?75000:60000)])});
    const data = await response.json(); session.assert(); if (!response.ok) throw new Error(data.error || '本地服务请求失败。'); return data;
  }
  await bridgeReady; session.assert();
  const result = await app.callServerTool({name:route==='snapshot'?'workgraph_open':`workgraph_${route}`,arguments:{...args,...(route==='context'?{}:{repositoryPath:repositoryPath || undefined})}});
  session.assert();
  if (result.isError) throw new Error(result.content?.find(c=>c.type==='text')?.text || '请求失败。'); return result.structuredContent;
  } catch(error) { session.assert(); if(token&&error instanceof TypeError)throw new Error('连接已断开，请重新打开 WorkGraph 获取新链接。写操作结果不确定时请先刷新核对。');throw error; }
}
function active() { return state.data?.worktrees.find(w=>w.path===state.active); }
function wtName(w) {return w.branch?.replace('refs/heads/','') || (w.bare?'裸仓库':!w.head||/^0+$/.test(w.head)?'尚无提交':'detached HEAD');}
function wtStatus(w) {return w.prunable?`目录失效：${w.prunable}`:w.error?`无法读取：${w.error}`:w.bare?'裸仓库':`${w.status?.total || 0} 个改动${w.locked?' · 已锁定：'+(w.locked===true?'未提供原因':w.locked):''}`;}
function menu(html) {lastFocus=document.activeElement;$('menu-content').innerHTML=html;$('menu').showModal();}
function closeMenu() {$('menu').close();lastFocus?.focus();}
function navRender() {
  if (!state.data) return;
  $('nav').innerHTML = `<h3>WORKTREE · ${state.data.worktrees.length}</h3>` + state.data.worktrees.map((w,i)=>`<button data-wt="${i}" title="${esc(w.path+' · '+wtStatus(w))}">${esc(w.path===state.active?'操作 · ':'')}${esc(wtName(w))} · ${w.status?.total ?? '—'}</button>`).join('') + ['branch','remote','tag'].map(type=>`<h3>${{branch:'本地分支',remote:'远程分支',tag:'标签'}[type]}</h3>`+state.data.refs.filter(r=>r.type===type&&!r.symbolic).map(r=>`<button data-ref="${esc(r.name)}" title="跳到 ${esc(r.name)}">${esc(r.shortName)}</button>`).join('')).join('')+(features?.nav()||'');
}
function customScope(){const d=state.data;return !!(d?.scopes?.length||d?.branchGlob||d?.firstParent||d?.includeReflogs||d?.showRemotes===false||d?.showTags===false||d?.showStashes===false);}
function scopeLabel(){const d=state.data;if(!customScope())return state.scope?state.scope.replace(/^refs\/(heads|remotes|tags)\//,''):'全部历史';return [d.scopes?.length?d.scopes.length+' 个引用':'',d.branchGlob,d.firstParent?'第一父提交':'',d.includeReflogs?'含 reflog':'','自定义筛选'].filter(Boolean).join(' · ');}
function scopeRender() {
  const a=active(), current=a?.branch;
  $('scope').innerHTML = '<option value="">全部历史</option>' + (customScope()?'<option value="__filtered">自定义筛选</option>':'') + (current?`<option value="${esc(current)}">当前分支历史</option>`:'') + state.data.refs.filter(r=>!r.symbolic).map(r=>`<option value="${esc(r.name)}">${esc(r.shortName)}</option>`).join('');
  $('scope').value=customScope()?'__filtered':state.scope;
}
function switchRepository(repositoryPath) {
  if(state.repositoryPath===repositoryPath)return false;
  workGraph?.reset();workspace.invalidate();resetRepositoryState(state);state.repositoryPath=repositoryPath;
  features?.resetRepository();prepared=null;actionSpec=null;lastFocus=null;graphOffset=0;searching=false;
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  for(const id of ['menu-content','action-fields','action-error','action-preview','detail-meta','detail-tabs','files','diff','diff-title','commit-pane','history','nav','summary','matches'])$(id).textContent='';
  $('search').value='';$('repo-input').value=repositoryPath||'';$('scope').innerHTML='<option value="">全部历史</option>';
  $('repo-name').textContent='WorkGraph';$('repo-name').title='';$('branch').textContent='';$('worktree-menu').textContent='Worktree';$('worktree-menu').title='';
  $('detail').hidden=true;$('commit-pane').hidden=true;$('load-more').hidden=true;$('empty').hidden=true;$('prev').hidden=$('next').hidden=true;$('refresh').disabled=false;
  $('app').classList.remove('full-detail');$('expand-detail').textContent='展开详情';$('history-scroll').scrollTop=0;
  if($('file-tools'))$('file-tools').hidden=true;notify('');
  return true;
}
function receive(data) {
  if (data?.needsRepository) {$('repo-form').hidden=false;return;}
  if (!data?.repository) return;
  switchRepository(data.repository.path);
  state.data=data; state.repositoryPath=data.repository.path;
  if (!active()) state.active=data.worktrees.find(w=>w.current&&!w.bare)?.path || data.worktrees.find(w=>!w.bare)?.path;
  $('repo-form').hidden=true;$('repo-name').textContent=data.repository.name;$('repo-name').title=data.repository.path;
  const a=active();$('worktree-menu').textContent=a?wtName(a):'裸仓库';$('worktree-menu').title=a?`操作工作区：${a.path}`:data.repository.path;
  $('branch').textContent=a?`${a.status?.total || 0} 个改动 · ${a.head?.slice(0,7)||'unborn'}`:'裸仓库';
  $('head').textContent=a?.head&&!/^0+$/.test(a.head)?'HEAD':'工作区';
  navRender();scopeRender();renderHistory();void workGraph?.update();
  $('summary').textContent=`已加载 ${data.commits.length} 条 · ${scopeLabel()} · ${data.worktrees.length} 个 Worktree${data.hasMore?' · 可继续加载':''}`;
}
const ROW_HEIGHT=32, LANE_WIDTH=20;
document.documentElement.style.setProperty('--history-row-height', `${ROW_HEIGHT}px`);
const icon = name => (icons[name] || icons['git-branch']).replace('<svg ', '<svg aria-hidden="true" class="icon" ');
const x = n => 14+n*LANE_WIDTH;
function svg(row,width) {
 const mid=ROW_HEIGHT/2, working=row.kind==='working';
 const line=(e,t,b)=>`<path d="M${x(e.from)} ${t} C${x(e.from)} ${(t+b)/2} ${x(e.to)} ${(t+b)/2} ${x(e.to)} ${b}" stroke="var(--c${e.color})" fill="none" stroke-width="1.5" ${e.boundary?'stroke-dasharray="2 2"':''}/>`;
 return `<div class="graph-cell" title="${esc(working?'工作区改动':row.author)}${row.parents.length>1?' · 合并提交':''}"><svg width="${width}" height="${ROW_HEIGHT}" aria-hidden="true">${row.passing.map(e=>line(e,0,ROW_HEIGHT)).join('')}${row.incoming.map(e=>line(e,0,mid)).join('')}${row.outgoing.map(e=>line(e,mid,ROW_HEIGHT)).join('')}<circle cx="${x(row.column)}" cy="${mid}" r="${working?6:row.parents.length>1?4.5:3.5}" stroke="var(--c${row.color})" stroke-width="1.5" fill="${working||row.parents.length>1?'var(--bg)':`var(--c${row.color})`}" ${working?'stroke-dasharray="2 2"':''}/></svg></div>`;
}
function highlight(text,q) {if(!q)return esc(text);const at=text.toLowerCase().indexOf(q);return at<0?esc(text):esc(text.slice(0,at))+'<mark>'+esc(text.slice(at,at+q.length))+'</mark>'+esc(text.slice(at+q.length));}
function renderHistory() {
  if (!state.data) return;
  const data=state.data, loaded=new Set(data.commits.map(c=>c.hash));
  const wts=data.worktrees.filter(w=>!state.scope||loaded.has(w.head));
  const graph=layoutGraph(data.commits,wts);state.rows=graph.rows;
  const width=Math.max(64,graph.width*LANE_WIDTH+24);
  // The graph owns its horizontal scroll; metadata columns do not grow with lane count.
  document.documentElement.style.setProperty('--graph-width',`${Math.min(width,160)}px`);
  const query=$('search').value.trim().toLowerCase();state.matches=[];
  const refMap=new Map();data.refs.filter(r=>!r.symbolic).forEach(r=>{const list=refMap.get(r.hash)||[];list.push(r);refMap.set(r.hash,list);});
  $('history').innerHTML=graph.rows.map((row,i)=>{
    const working=row.kind==='working', refs=working?[]:refMap.get(row.hash)||[], wt=row.worktree;
    const subject=working?`${!wt.head||/^0+$/.test(wt.head)?'工作区 · 尚无提交':'工作区改动'}`:row.subject;
    const matched=query&&`${subject} ${working?wtName(wt):''} ${row.hash||''} ${row.author||''} ${row.date||''} ${refs.map(r=>r.name).join(' ')}`.toLowerCase().includes(query);
    if(matched)state.matches.push(i);
    const paired=new Set();
    const displayRefs=refs.filter(r=>r.type!=='remote').map(r=>{const remote=r.upstream&&refs.find(f=>f.type==='remote'&&f.shortName===r.upstream);if(remote)paired.add(remote.name);return {...r,remote};}).concat(refs.filter(r=>r.type==='remote'&&!paired.has(r.name)));
    const badge=r=>`<button class="tag ${r.type==='tag'?'tagref':r.type} ${r.type==='branch'&&r.name===active()?.branch?'current-ref':''}" style="--ref-color:var(--c${row.color})" data-ref="${esc(r.name)}" title="${esc(r.name+(r.upstream?' → '+r.upstream:'')+(r.tracking?' '+r.tracking:''))}">${icon(r.type==='tag'?'tag':r.type==='remote'?'cloud':'git-branch')}<span>${esc(r.shortName)}</span>${r.tracking?`<span class="tracking">${esc(r.tracking.replaceAll('[','').replaceAll(']',''))}</span>`:''}${r.remote?`<span class="remote-part">${icon('cloud')}${esc(r.remote.shortName.split('/')[0])}</span>`:''}</button>`;
    const badges=working?[badge({name:wt.branch||wt.head||'',shortName:wtName(wt),type:'branch'}).replace('data-ref=', 'data-wip-ref=')]:displayRefs.slice(0,3).map(badge);
    const trees=data.worktrees.filter(w=>w.head===row.hash&&!w.bare);
    return `<div role="row" tabindex="-1" class="row commit-row ${working?'working':''} ${state.selected===row.id?'selected':''} ${matched?'match':''}" data-row="${i}" style="--row-color:var(--c${row.color})" aria-label="${esc(subject+(working?' · '+wtName(wt)+' · '+wt.status.total+' 个文件':' · '+row.author))}">${svg(row,width)}<div class="summary"><span class="refs">${badges.join('')}${displayRefs.length>3?`<button class="tag ref-overflow" data-refs="${i}">+${displayRefs.length-3}</button>`:''}${displayRefs.length>1?`<button class="tag ref-compact-count" data-refs="${i}">+${displayRefs.length-1}</button>`:''}</span><span class="subject">${highlight(subject,query)}</span>${working?`<span class="wip-count" title="已暂存 ${wt.status.staged} · 未暂存 ${wt.status.unstaged} · 未跟踪 ${wt.status.untracked} · 冲突 ${wt.status.conflicts}">${wt.status.total}</span>`:''}${trees.length?`<button class="tag" data-headtrees="${i}" title="${esc(trees.map(w=>w.path).join('\n'))}">WT ${trees.length}</button>`:''}${row.outgoing.some(e=>e.boundary)?'<span class="boundary-note" title="父提交被筛选、未载入或处于浅克隆边界">边界</span>':''}</div><span class="author">${esc(working?'未提交':row.author)}</span><span class="date">${working?'现在':(features?.dateText(row.date)||new Date(row.date).toLocaleDateString('zh-CN'))}</span><span class="sha">${row.hash?.slice(0,7)||'—'}</span><button class="row-more" data-row-menu="${i}" aria-label="${esc(subject)}，更多操作">${icon('ellipsis')}</button></div>`;
  }).join('');
  $('empty').hidden=graph.rows.length>0;$('load-more').hidden=!data.hasMore;
  if(state.match>=state.matches.length)state.match=state.matches.length-1;
  matchLabel();
  $('history').querySelectorAll('.graph-cell').forEach(el=>el.scrollLeft=graphOffset);
}
function matchLabel() {const q=$('search').value.trim();$('prev').hidden=$('next').hidden=!q;$('matches').textContent=q?(state.matches.length?`${state.match<0?0:state.match+1}/${state.matches.length} · 已加载 ${state.data?.commits.length||0} 条`:'已加载范围内无匹配'):'';}
function scrollRow(i) {const row=$('history').querySelector(`[data-row="${i}"]`);row?.scrollIntoView({block:'nearest'});}
function moveMatch(delta) {if(!state.matches.length)return;state.match=(state.match+delta+state.matches.length)%state.matches.length;matchLabel();const i=state.matches[state.match];scrollRow(i);void selectRow(state.rows[i]);}
function anchor() {const box=$('history-scroll'),i=Math.floor(box.scrollTop/ROW_HEIGHT);return {id:state.rows[i]?.id,offset:box.scrollTop-i*ROW_HEIGHT};}
async function refresh({reloadDetail=true}={}) {
  const session=workspace.capture(),request=++state.refreshRequest, saved=anchor();$('refresh').disabled=true;
  try {
    let data,commits=[];
    for(let offset=0;offset<state.limit;){
      data=await call('snapshot',{limit:Math.min(2000,state.limit-offset),offset,scope:state.scope,...features?.snapshotOptions()});
      if(request!==state.refreshRequest)return;if(data?.needsRepository){receive(data);return;}if(!data?.repository||!Array.isArray(data.commits))throw new Error('仓库数据无效，请重新打开 WorkGraph。');commits.push(...data.commits);
      if(!data.hasMore||!data.commits.length)break;offset+=data.commits.length;
    }
    data={...data,commits:[...new Map(commits.map(c=>[c.hash,c])).values()]};
    receive(data);const received=workspace.capture(),receivedRequest=state.refreshRequest;await features?.loadPreferences();received.assert();if(receivedRequest!==state.refreshRequest)return;const index=state.rows.findIndex(r=>r.id===saved.id);if(index>=0)$('history-scroll').scrollTop=index*ROW_HEIGHT+saved.offset;
    if(state.selected&&!state.rows.some(r=>r.id===state.selected)&&!state.compare){state.selected=null;closeDetail();notify('原选择已离开当前范围或工作区已变干净。');}
    if(!state.selected&&!state.compare){const a=active(),row=state.rows.find(r=>r.id===`worktree:${a?.path}`)||state.rows.find(r=>r.hash===a?.head);if(row){state.selected=row.id;state.detailInput=row.kind==='working'?{worktreePath:row.worktree.path}:{hash:row.hash};renderHistory();}}
    else if(reloadDetail&&state.detailInput&&!$('detail').hidden)await showDetail(state.detailInput);
  } catch(e){if(request===state.refreshRequest)notify(`刷新失败，保留上次数据。${e.message}`);} finally {if(request===state.refreshRequest)$('refresh').disabled=false;}
}
function closeDetail(){state.detailRequest++;state.diffRequest++;$('detail').hidden=true;$('app').classList.remove('full-detail');}
async function selectRow(row){if(!row)return;state.selected=row.id;state.compare=null;renderHistory();await showDetail(row.kind==='working'?{worktreePath:row.worktree.path}:{hash:row.hash});scrollRow(state.rows.findIndex(r=>r.id===row.id));}
async function showDetail(input) {
  const wasHidden=$('detail').hidden;const same=JSON.stringify(input)===JSON.stringify(state.detailInput), commitTab=same&&!$('commit-pane').hidden;
  const fileScroll=$('files').scrollTop,diffScroll=$('diff').scrollTop,commitScroll=$('commit-pane').scrollTop;
  const editing=same&&document.activeElement.id==='commit-message',selection=editing?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
  const request=++state.detailRequest;state.diffRequest++;state.detailInput={...input};if(!same)state.checked.clear();$('detail').hidden=false;
  if($('file-tools'))$('file-tools').hidden=true;$('detail-label').textContent='读取详情…';$('detail-meta').textContent='';$('files').textContent='正在读取文件…';$('diff').textContent='';$('diff-title').textContent='';$('commit-pane').hidden=true;$('detail-content').hidden=false;$('detail-tabs').innerHTML='';
  try {
    const data=await call('files',{input});if(request!==state.detailRequest)return;
    state.detail=data;
    if(data.kind==='worktree') {
      $('detail-label').textContent=data.comparison?`历史 ${data.a.slice(0,10)} → 工作目录`:`工作区 · ${data.branch||(!data.head?'尚无提交':'detached HEAD')}`;
      $('detail-meta').innerHTML=`<div class="path">${esc(data.path)}</div><p class="muted">已暂存 ${data.status.staged} · 未暂存 ${data.status.unstaged} · 未跟踪 ${data.status.untracked} · 冲突 ${data.status.conflicts}</p>`;
      $('detail-tabs').innerHTML='<button id="tab-files">文件</button><button id="tab-commit">提交</button><button id="batch-stage" disabled>暂存选中</button><button id="batch-unstage" disabled>取消暂存选中</button>';
      if(data.comparison){$('detail-tabs').innerHTML='';}else commitRender();
    } else {
      const c=data.commit;$('detail-label').textContent=state.compare?'两端点比较':c.subject;
      $('detail-meta').innerHTML=`<div class="mono">${esc(data.a?.slice(0,10)||'空树')} → ${data.b.slice(0,10)}${state.compare?' · 树差异':` · 父 ${data.parent+1}`}</div><div class="muted">${esc(c.author)} · ${esc(new Date(c.date).toLocaleString('zh-CN'))}</div><button id="copy-sha">复制 SHA</button>${c.parents.length>1&&!state.compare?`<label>比较父 <select id="parent">${c.parents.map((p,i)=>`<option value="${i}" ${i===data.parent?'selected':''}>${i+1} · ${p.slice(0,10)}</option>`).join('')}</select></label>`:''}${state.compare?'<button id="swap-compare">交换端点</button><button id="exit-compare">退出比较</button>':'<button id="detail-more">提交操作</button>'}${c.body?`<p>${esc(c.body)}</p>`:''}`;
    }
    filesRender();features?.afterDetail(data);ensureSelectedFileVisible();const found=data.files.find(f=>f.id===state.file)||data.files[0];if(found)await selectFile(found.id);else{$('diff').innerHTML='<p class="notice">没有文件差异。</p>';state.file=null;}
    if(same&&request===state.detailRequest){$('files').scrollTop=fileScroll;$('diff').scrollTop=diffScroll;$('commit-pane').scrollTop=commitScroll;if(commitTab&&data.kind==='worktree'){$('detail-content').hidden=true;$('commit-pane').hidden=false;}if(editing&&$('commit-message')){$('commit-message').focus({preventScroll:true});$('commit-message').setSelectionRange(...selection);}}
    if(wasHidden&&request===state.detailRequest)scrollRow(state.rows.findIndex(r=>r.id===state.selected));
  }catch(e){if(request===state.detailRequest){$('detail-label').textContent='读取失败';$('files').innerHTML=`<p class="notice">${esc(e.message)}</p><button id="retry-detail">重试</button>`;}}
}
function filesRender(){
  const d=state.detail;if(!d)return;
  const tree=features?.fileTree();
  const row=f=>`<div class="file-row ${state.file===f.id?'selected':''}">${d.kind==='worktree'&&!d.comparison&&f.group!=='conflict'?`<input type="checkbox" data-check="${esc(f.id)}" aria-label="选择 ${esc(f.path)}" ${state.checked.has(f.id)?'checked':''}>`:''}<button class="file-name" data-file="${esc(f.id)}" title="${esc(f.originalPath?f.originalPath+' → '+f.path:f.path)}"><span class="status">${esc(f.status)}</span> <span class="file-path">${esc(tree?f.path.split('/').at(-1):f.path)}</span></button>${!d.comparison&&['staged','unstaged','untracked'].includes(f.group)?`<button class="file-action" data-action="${f.group==='staged'?'unstage':'stage'}" data-path="${esc(f.path)}" ${state.pending?'disabled':''}>${f.group==='staged'?'取消暂存':'暂存'}</button>`:''}</div>`;
  $('files').innerHTML=Object.entries(groups).map(([group,label])=>{
    const files=d.files.filter(f=>f.group===group);if(!files.length)return '';
    let html=`<div class="file-group">${label} · ${files.length}</div>`;
    if(!tree)return html+files.map(row).join('');
    const dirs=new Map();for(const f of files){const dir=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'.';if(!dirs.has(dir))dirs.set(dir,[]);dirs.get(dir).push(f);}
    return html+[...dirs].sort(([a],[b])=>a.localeCompare(b)).map(([dir,list])=>dir==='.'?list.map(row).join(''):`<details open class="file-directory"><summary>${esc(dir)} · ${list.length}</summary>${list.map(row).join('')}</details>`).join('');
  }).join('')||'<p class="notice">没有文件差异。</p>';
  features?.decorateFiles();
}
function patchHtml(data){if(data.binary)return '<p class="notice">二进制文件，无法显示文本差异。</p>';let old=0,now=0;return (data.truncated?'<p class="notice">仅显示前 256 KiB。</p>':'')+(data.submodule?'<p class="notice">子模块指针变化</p>':'')+(data.patch?data.patch.split('\n').filter(line=>!(/^(diff --git |index |--- |\+\+\+ )/.test(line))).map(line=>{let a='',b='',kind='';const m=/^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);if(m){old=Number(m[1]);now=Number(m[2]);kind='hunk';}else if(line.startsWith('+')&&!line.startsWith('+++')){b=now++;kind='add';}else if(line.startsWith('-')&&!line.startsWith('---')){a=old++;kind='del';}else if(line.startsWith(' ')){a=old++;b=now++;}return `<div class="diff-line ${kind}"><span class="num">${a}</span><span class="num">${b}</span><span class="code">${esc(line)||' '}</span></div>`;}).join(''):'<p class="notice">没有文本差异。</p>');}
async function selectFile(id){const request=++state.diffRequest;state.file=id;filesRender();ensureSelectedFileVisible();const d=state.detail,f=d.files.find(f=>f.id===id);$('diff-title').textContent=`${f.originalPath?f.originalPath+' → ':''}${f.path} · ${d.comparison?d.a.slice(0,10)+' → 工作目录':d.kind==='worktree'?{staged:'HEAD → index',unstaged:'index → 工作目录',untracked:'空 → 未跟踪文件',conflict:'冲突文件'}[f.group]:`${d.a?.slice(0,10)||'空树'} → ${d.b.slice(0,10)} · 父 ${d.parent+1}`}`;$('diff').innerHTML='<p class="notice">正在读取差异…</p>';try{const data=await call('diff',{input:{...state.detailInput,fileId:id,version:d.version}});if(request===state.diffRequest){$('diff').innerHTML=patchHtml(data);features?.afterFile(id);}}catch(e){if(request===state.diffRequest)$('diff').innerHTML=`<p class="notice">${esc(e.message)}</p><button id="retry-diff">重试</button>`;}}
function commitRender(){const d=state.detail;if(d?.kind!=='worktree')return;const staged=d.files.filter(f=>f.group==='staged');const reason=!d.branch?'detached HEAD 请先创建并切换分支。':d.status.conflicts||d.ongoing.length?'存在冲突或进行中的 Git 操作。':!d.identity?'缺少 Git 作者身份。':!staged.length?'没有已暂存文件。':'';$('commit-pane').innerHTML=`<div class="path">${esc(d.path)}</div><p>分支 ${esc(d.branch||'detached HEAD')} · ${esc(d.identity||'尚未配置身份')}</p><p>本次 index · ${staged.length} 个文件</p><ul>${staged.map(f=>`<li>${esc(f.path)}</li>`).join('')}</ul><p class="muted">${d.status.unstaged+d.status.untracked} 个未暂存 / 未跟踪条目不会包含在本次提交。</p><label for="commit-message">提交消息</label><textarea id="commit-message" placeholder="说明本次修改">${esc(state.message)}</textarea><p class="muted" id="commit-reason">${esc(reason||(!state.message.trim()?'填写提交消息后可提交。':''))}</p><button class="primary" id="commit-submit" ${reason||!state.message.trim()||state.pending?'disabled':''}>提交已暂存的 ${staged.length} 个文件</button>`;}
function ensureSelectedFileVisible(){const box=$('files'),row=box.querySelector('.file-row.selected');if(!row||box.clientHeight===0)return;const a=row.getBoundingClientRect(),b=box.getBoundingClientRect();if(a.top<b.top+24)box.scrollTop-=b.top+24-a.top;else if(a.bottom>b.bottom)box.scrollTop+=a.bottom-b.bottom;}
async function runAction(action,payload,preparation){const session=workspace.capture();if(state.pending)return;state.pending=true;filesRender();ensureSelectedFileVisible();try{const preview=preparation||await call('prepare',{action,payload,expectedVersion:state.detail?.path===payload.worktreePath?state.detail.version:undefined});session.assert();const result=await call('execute',{actionId:preview.actionId,operationId:crypto.randomUUID()});session.assert();menu(`<h2>操作${{completed:'完成',failed:'失败',unknown:'结果未知'}[result.state]}</h2><p class="path">${esc(result.target)}</p><p>${esc(result.hash||result.path||'')}</p><details><summary>操作输出 · ${esc(result.operationId)}</summary><pre class="path">${esc(JSON.stringify(result,null,2))}</pre></details>`);if(result.state==='completed'&&action==='commit'){state.message='';state.selected=result.hash;state.detailInput={hash:result.hash};}if(result.state!=='completed')notify(result.error||'操作结果未知，请刷新核实，勿重复执行。');await refresh();return result;}catch(e){if(isStaleWorkspace(e))return;notify(`操作未能确认完成：${e.message} 请刷新核实后再决定下一步。`);await refresh();}finally{if(!session.current())return;state.pending=false;filesRender();ensureSelectedFileVisible();if(state.detail?.kind==='worktree'){const b=$("commit-submit"),d=state.detail;if(b)b.disabled=!state.message.trim()||!d.branch||!d.identity||!d.status.staged||!!d.status.conflicts||!!d.ongoing.length;}}}
async function jump(ref){const session=workspace.capture();try{features?.resetFilters();const {hash}=await call('resolve',{ref});let row=state.rows.find(r=>r.hash===hash);if(!row){state.scope='';state.limit=2000;await refresh({reloadDetail:false});session.assert();row=state.rows.find(r=>r.hash===hash);}if(!row){const known=state.data.refs.find(r=>r.hash===hash);if(known){state.scope=known.name;state.limit=300;await refresh({reloadDetail:false});session.assert();row=state.rows.find(r=>r.hash===hash);}}if(row){await selectRow(row);scrollRow(state.rows.findIndex(r=>r.id===row.id));}else{state.selected=hash;state.compare=null;await showDetail({hash});notify('此提交不在已加载的 2000 条范围内；详情已打开，可在引用菜单缩小历史范围。');}}catch(e){if(!isStaleWorkspace(e))notify(e.message);}}
function rowMenu(row){if(!row)return;if(row.kind==='working'){const i=state.data.worktrees.indexOf(row.worktree);worktreeMenu(i);return;}state.menuRow=row;menu(`<h2>${esc(row.subject)}</h2><p class="mono">${row.hash}</p><button data-menu-action="copy">复制 SHA</button><button data-menu-action="compare-start">设为比较起点</button>${state.compareStart?`<button data-menu-action="compare-end">与 ${state.compareStart.slice(0,7)} 比较</button>`:''}<button data-menu-action="compare-refs">选择引用比较</button><button data-menu-action="branch">创建分支</button><button data-menu-action="worktree">创建 Worktree</button>${features?.rowActions(row)||''}`);}
function worktreeMenu(index){const list=index===undefined?state.data.worktrees:[state.data.worktrees[index]];menu('<h2>Worktree</h2>'+list.map(w=>{const i=state.data.worktrees.indexOf(w);return `<div class="menu-row"><strong>${esc(wtName(w))}</strong><p class="path">${esc(w.path)}</p><p>${esc(wtStatus(w))}</p>${!w.bare&&!w.prunable&&!w.error?`<button data-browse-wt="${i}">浏览文件</button><button data-active-wt="${i}">${w.path===state.active?'当前操作工作区':'设为操作工作区'}</button><button data-switch-wt="${i}">切换分支</button>${features?.wtActions(w)||''}`:''}</div>`;}).join(''));}
async function openAction(action,options={}){if($('menu').open)closeMenu();lastFocus=document.activeElement;prepared=null;actionSpec={action,...options};if(action==='switch'){try{actionSpec.expectedVersion=(await call('files',{input:{worktreePath:options.worktreePath}})).version;}catch(e){if(!isStaleWorkspace(e))notify(e.message);return;}}const title={branch:'创建分支',switch:'切换分支',worktree:'创建 Worktree',compare:'比较引用'}[action];$('action-title').textContent=title;$('action-error').textContent='';$('action-preview').hidden=true;$('action-submit').textContent=action==='compare'?'比较':'检查操作';const refs=state.data.refs.filter(r=>!r.symbolic);$('action-fields').innerHTML=action==='compare'?`<label>起点 A<select name="a">${refs.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</select></label><label>终点 B<select name="b">${refs.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</select></label>`:`${options.worktreePath?`<p class="path">操作工作区：${esc(options.worktreePath)}</p><p>当前分支：${esc(state.data.worktrees.find(w=>w.path===options.worktreePath)?.branch||'detached HEAD')}</p>`:`<p class="mono path">起点：${esc(options.start)}</p>`}${action==='switch'?`<label>目标本地分支<select name="name">${refs.filter(r=>r.type==='branch').map(r=>`<option value="${esc(r.shortName)}">${esc(r.shortName)}</option>`).join('')}</select></label>`:'<label>新分支名<input name="name" value="codex/" required></label>'}${action==='worktree'?'<label>新 Worktree 绝对路径<input name="target" required placeholder="D:\\worktrees\\my-feature"></label>':''}`;$('action-dialog').showModal();$('action-fields').querySelector('input,select')?.focus();}
async function compare(a,b){const session=workspace.capture();const [ra,rb]=await Promise.all([call('resolve',{ref:a}),call('resolve',{ref:b})]);session.assert();state.compare={a:ra.hash,b:rb.hash};state.selected=rb.hash;renderHistory();await showDetail(state.compare);}
$('refresh').onclick=()=>void refresh();$('load-more').onclick=()=>{state.limit+=300;void refresh();};
$('nav-toggle').onclick=()=>{$('app').classList.toggle('nav-closed');saveLayout();};$('worktree-menu').onclick=()=>state.data&&worktreeMenu();
$('scope').onchange=()=>{if($('scope').value==='__filtered')return;features?.resetFilters();state.scope=$('scope').value;state.limit=300;state.compare=null;void refresh();};
let searching=false;$('search').oninput=()=>{const q=$('search').value.trim();renderHistory();if(q&&!searching){state.match=-1;moveMatch(1);}searching=!!q;};$('search').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();moveMatch(e.shiftKey?-1:1);}if(e.key==='Escape'){e.stopPropagation();$('search').value='';searching=false;renderHistory();}};$('prev').onclick=()=>moveMatch(-1);$('next').onclick=()=>moveMatch(1);
$('head').onclick=async()=>{const a=active();if(!a)return;if(!a.head||/^0+$/.test(a.head)){await selectRow(state.rows.find(r=>r.id===`worktree:${a.path}`));return;}if(state.scope&&!state.rows.some(r=>r.hash===a.head)){state.scope='';features?.resetFilters();await refresh({reloadDetail:false});notify('已恢复全部历史，以定位操作工作区 HEAD。');}await jump(a.head);};
$('detail-toggle').onclick=()=>{if($('detail').hidden&&state.detailInput)void showDetail(state.detailInput);else closeDetail();};$('close-detail').onclick=()=>{closeDetail();$('history-scroll').focus();};$('expand-detail').onclick=()=>{$('app').classList.toggle('full-detail');$('expand-detail').textContent=$('app').classList.contains('full-detail')?'返回历史':'展开详情';};$('dock-detail').onclick=()=>{$('app').classList.toggle('bottom-detail');$('dock-detail').textContent=$('app').classList.contains('bottom-detail')?'右侧':'底部';saveLayout();};
$('more').onclick=()=>{menu('<h2>面板设置</h2><button id="theme-dark">深色主题</button><button id="theme-light">浅色主题</button><button id="theme-system">跟随系统主题</button><button id="compare-refs">比较两个引用</button><div class="column-settings"><span>历史列</span><button data-column="author">作者</button><button data-column="date">日期</button><button data-column="sha">SHA</button></div><p class="muted">查找：Ctrl/Cmd+F 或 /；命中导航：Enter / Shift+Enter；历史：上下键；Esc：返回上一层。</p>');for(const b of $('menu-content').querySelectorAll('[data-column]'))b.setAttribute('aria-pressed',String(layout.columns?.[b.dataset.column]!==false));};
$('close-menu').onclick=closeMenu;$('cancel-action').onclick=()=>{$('action-dialog').close();lastFocus?.focus();};
$('action-fields').oninput=()=>{prepared=null;$('action-preview').hidden=true;$('action-submit').textContent=actionSpec.action==='compare'?'比较':'检查操作';};
$('action-form').onsubmit=async e=>{e.preventDefault();if(state.pending)return;$('action-error').textContent='';const fields=Object.fromEntries(new FormData(e.target));try{if(actionSpec.action==='compare'){await compare(fields.a,fields.b);$('action-dialog').close();return;}const payload={...fields,...(actionSpec.start?{start:actionSpec.start}:{}),...(actionSpec.worktreePath?{worktreePath:actionSpec.worktreePath}:{})};if(!prepared){prepared=await call('prepare',{action:actionSpec.action,payload,expectedVersion:actionSpec.expectedVersion});$('action-preview').hidden=false;$('action-preview').textContent=JSON.stringify(prepared.summary,null,2)+'\n\n'+prepared.command.join(' ');$('action-submit').textContent={branch:'创建分支',switch:'切换分支',worktree:'创建 Worktree'}[actionSpec.action];}else{$('action-dialog').close();await runAction(actionSpec.action,payload,prepared);}}catch(e){if(isStaleWorkspace(e))return;$('action-error').textContent=e.message;prepared=null;$('action-submit').textContent='检查操作';}};
$('menu-content').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{if(b.dataset.column){const key=b.dataset.column;layout.columns||={};layout.columns[key]=layout.columns[key]===false;applyColumns();saveLayout();b.setAttribute('aria-pressed',String(layout.columns[key]!==false));return;}if(b.id.startsWith('theme-')){const t=b.id.slice(6);layout.theme=t;applyTheme();saveLayout();closeMenu();return;}if(b.id==='compare-refs'){openAction('compare');return;}if(b.dataset.browseWt!==undefined){const w=state.data.worktrees[Number(b.dataset.browseWt)];closeMenu();await showDetail({worktreePath:w.path});state.selected=`worktree:${w.path}`;renderHistory();return;}if(b.dataset.activeWt!==undefined){state.active=state.data.worktrees[Number(b.dataset.activeWt)].path;closeMenu();receive(state.data);notify(`操作工作区：${state.active}`);return;}if(b.dataset.switchWt!==undefined){openAction('switch',{worktreePath:state.data.worktrees[Number(b.dataset.switchWt)].path});return;}if(b.dataset.ref){closeMenu();await jump(b.dataset.ref);return;}if(b.dataset.scope){features?.resetFilters();state.scope=b.dataset.scope;state.limit=300;closeMenu();await refresh();return;}const action=b.dataset.menuAction,r=state.menuRow;if(action==='copy'){await navigator.clipboard.writeText(r.hash);b.textContent='已复制';}if(action==='compare-start'){state.compareStart=r.hash;closeMenu();notify(`比较起点：${r.hash.slice(0,10)}。选择另一提交，再从更多菜单比较。`);}if(action==='compare-end'){closeMenu();await compare(state.compareStart,r.hash);}if(action==='compare-refs')openAction('compare');if(action==='branch'||action==='worktree')openAction(action,{start:r.hash});}catch(e){if(!isStaleWorkspace(e))notify(e.message);}};
function refMenu(ref){const r=state.data.refs.find(r=>r.name===ref);menu(`<h2>${esc(ref)}</h2><button data-ref="${esc(ref)}">跳到 ${r?.hash.slice(0,10)||'tip'}</button><button data-scope="${esc(ref)}">只看此历史</button>${features?.refActions(ref)||''}`);}
$('nav').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.wt!==undefined)worktreeMenu(Number(b.dataset.wt));if(b.dataset.ref)refMenu(b.dataset.ref);};
$('history').onclick=e=>{const b=e.target.closest('button');const row=e.target.closest('[data-row]');if(!row)return;const r=state.rows[Number(row.dataset.row)];if(b?.dataset.wipRef!==undefined){void selectRow(r);return;}if(b?.dataset.ref){void jump(b.dataset.ref);return;}if(b?.dataset.refs!==undefined){const refs=state.data.refs.filter(f=>f.hash===r.hash);menu('<h2>此提交的引用</h2>'+refs.map(f=>`<div class="menu-row"><button data-ref="${esc(f.name)}">${esc(f.name)}</button><button data-scope="${esc(f.name)}">只看此历史</button></div>`).join(''));return;}if(b?.dataset.headtrees!==undefined){worktreeMenu();return;}if(b?.dataset.rowMenu!==undefined){rowMenu(r);return;}if((e.ctrlKey||e.metaKey)&&state.detail?.b){void compare(state.detail.b,r.hash);return;}void selectRow(r);};$('history').oncontextmenu=e=>{const row=e.target.closest('[data-row]');if(row){e.preventDefault();const ref=e.target.closest('[data-ref]');if(ref)refMenu(ref.dataset.ref);else rowMenu(state.rows[Number(row.dataset.row)]);}};
$('history-scroll').onkeydown=e=>{if(e.target.closest('button'))return;if(!e.ctrlKey&&!e.metaKey&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();let i=state.rows.findIndex(r=>r.id===state.selected);i=Math.max(0,Math.min(state.rows.length-1,i+(e.key==='ArrowDown'?1:-1)));void selectRow(state.rows[i]);scrollRow(i);}if(e.key==='Enter'&&state.detailInput){e.preventDefault();void showDetail(state.detailInput);$('close-detail').focus();}};
$('files').onclick=e=>{const file=e.target.closest('[data-file]'),action=e.target.closest('[data-action]');if(file)void selectFile(file.dataset.file);if(action)void runAction(action.dataset.action,{worktreePath:state.detail.path,paths:[action.dataset.path]});if(e.target.id==='retry-detail')void showDetail(state.detailInput);};$('files').onchange=e=>{const id=e.target.dataset.check;if(!id)return;e.target.checked?state.checked.add(id):state.checked.delete(id);for(const action of ['stage','unstage']){$(`batch-${action}`).disabled=state.pending||!state.detail.files.some(f=>state.checked.has(f.id)&&(action==='stage'?['unstaged','untracked'].includes(f.group):f.group==='staged'));}};
$('detail-tabs').onclick=e=>{if(e.target.id==='tab-files'){$('detail-content').hidden=false;$('commit-pane').hidden=true;}if(e.target.id==='tab-commit'){$('detail-content').hidden=true;$('commit-pane').hidden=false;}if(e.target.id.startsWith('batch-')){const action=e.target.id.slice(6);const paths=state.detail.files.filter(f=>state.checked.has(f.id)&&(action==='stage'?['unstaged','untracked'].includes(f.group):f.group==='staged')).map(f=>f.path);void runAction(action,{worktreePath:state.detail.path,paths});}};
$('detail-meta').onclick=async e=>{try{if(e.target.id==='copy-sha'){await navigator.clipboard.writeText(state.detail.b);e.target.textContent='已复制';}if(e.target.id==='detail-more')rowMenu(state.rows.find(r=>r.hash===state.detail.b)||{hash:state.detail.b,subject:state.detail.commit.subject,kind:'commit'});if(e.target.id==='swap-compare')await compare(state.compare.b,state.compare.a);if(e.target.id==='exit-compare'){state.compare=null;await showDetail({hash:state.detail.b});}}catch(e){if(!isStaleWorkspace(e))notify(e.message);}};$('detail-meta').onchange=e=>{if(e.target.id==='parent')void showDetail({hash:state.detail.b,parent:Number(e.target.value)});};$('diff').onclick=e=>{if(e.target.id==='retry-diff')void selectFile(state.file);};
$('commit-pane').oninput=e=>{if(e.target.id==='commit-message'){state.message=e.target.value;const d=state.detail;$('commit-submit').disabled=state.pending||!state.message.trim()||!d.branch||!d.identity||!d.status.staged||!!d.status.conflicts||!!d.ongoing.length;}};$('commit-pane').onclick=e=>{if(e.target.id==='commit-submit')void runAction('commit',{worktreePath:state.detail.path,message:state.message});};
$('repo-form').onsubmit=e=>{e.preventDefault();contextBinding=false;contextRequest++;switchRepository($('repo-input').value.trim());void refresh();};
document.addEventListener('keydown',e=>{if($('app').classList.contains('work-mode'))return;const input=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);if((e.key==='/'&&!input)||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f')){e.preventDefault();$('search').focus();}if(e.key==='Escape'&&!input&&!$('menu').open&&!$('action-dialog').open){e.preventDefault();if($('app').classList.contains('full-detail')){$('app').classList.remove('full-detail');$('expand-detail').textContent='展开详情';}else closeDetail();}});
let layout={};try{layout=JSON.parse(localStorage.getItem('workgraph-layout-v3')||'{}');}catch{}
$('app').classList.toggle('nav-closed',layout.navClosed!==false);$('app').classList.toggle('bottom-detail',layout.bottomDetail!==false);$('dock-detail').textContent=layout.bottomDetail!==false?'右侧':'底部';
function applyTheme(){const t=layout.theme||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;}
applyTheme();matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{if(layout.theme==='system')applyTheme();});
function applyColumns(){for(const key of ['author','date','sha'])$('app').classList.toggle('hide-'+key,layout.columns?.[key]===false);}
applyColumns();
function saveLayout(){try{localStorage.setItem('workgraph-layout-v3',JSON.stringify({navClosed:$('app').classList.contains('nav-closed'),bottomDetail:$('app').classList.contains('bottom-detail'),theme:layout.theme||'dark',columns:layout.columns||{}}));}catch{}}
new ResizeObserver(entries=>$('app').classList.toggle('wide',entries[0].contentRect.width>=1100)).observe($('app'));
for(const [id,name,label] of [['refresh','refresh','刷新'],['more','ellipsis','面板设置'],['nav-toggle','list-tree','引用导航'],['prev','chevron-up','上一命中'],['next','chevron-down','下一命中'],['detail-toggle','layout-panel','详情']]){$(id).innerHTML=icon(name);$(id).classList.add('icon-button');$(id).title=label;$(id).setAttribute('aria-label',label);}
$('history').addEventListener('scroll',e=>{if(!e.target.classList.contains('graph-cell')||e.target.scrollLeft===graphOffset)return;graphOffset=e.target.scrollLeft;$('history').querySelectorAll('.graph-cell').forEach(el=>{if(el!==e.target)el.scrollLeft=graphOffset;});},true);
new ResizeObserver(()=>ensureSelectedFileVisible()).observe($('files'));
features=installFeatures({state,$,esc,call,workspace,isStaleWorkspace,menu,closeMenu,refresh,showDetail,selectFile,notify,active,renderHistory,jump,filesRender,commitRender});
async function syncHostRepository({queue=true}={}) {
  if(contextDisposed)return;
  if(contextInFlight){if(queue){contextQueued=true;contextRequest++;}return;}
  contextInFlight=true;
  const request=++contextRequest;
  try {
    const context=await call('context');if(request!==contextRequest)return;
    const signature=JSON.stringify([context.repositoryPath||null,context.context?.status,context.context?.candidates?.map(c=>c.path)]),previous=contextSignature;contextSignature=signature;
    if(!contextBinding&&state.repositoryPath&&(previous===undefined||previous===signature))return;
    if(context.repositoryPath){contextBinding=true;if(switchRepository(context.repositoryPath)||!state.data)await refresh();}
    else if(contextBinding||!state.repositoryPath){contextBinding=false;switchRepository(null);$('repo-form').hidden=false;notify(context.context?.reason||'宿主未提供唯一仓库，请选择仓库。');}
  }catch(error){if(!isStaleWorkspace(error)&&request===contextRequest&&!contextDisposed)notify(error.message);}
  finally{contextInFlight=false;if(contextQueued&&!contextDisposed){contextQueued=false;void syncHostRepository();}}
}
if(token)void refresh();else if(window.parent!==window){
  app=new App({name:'WorkGraph',version:'0.3.0'},{});
  app.ontoolinput=r=>{contextRequest++;if(r.arguments?.repositoryPath){contextBinding=false;switchRepository(r.arguments.repositoryPath);}else{contextBinding=true;switchRepository(null);}};
  app.ontoolresult=r=>{const data=r.structuredContent;if(!state.repositoryPath)void syncHostRepository();else if(data?.repository)void refresh();};
  app.onhostcontextchanged=ctx=>{if(ctx.theme)document.documentElement.dataset.theme=ctx.theme;void syncHostRepository();};
  const contextTimer=setInterval(()=>{if(!document.hidden)void syncHostRepository({queue:false});},5000);
  const onContextFocus=()=>void syncHostRepository();
  window.addEventListener('focus',onContextFocus);
  app.onteardown=()=>{contextDisposed=true;contextQueued=false;clearInterval(contextTimer);window.removeEventListener('focus',onContextFocus);contextRequest++;workspace.invalidate();return {};};
  bridgeReady=app.connect();bridgeReady.then(()=>syncHostRepository()).catch(e=>notify(e.message));
}else notify('请使用本地服务输出的完整链接，或从 Codex 插件打开面板。');
import { installWorkGraph } from './work-live.js';
workGraph=installWorkGraph({call});
