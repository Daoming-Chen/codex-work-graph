import { spawn } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseStatus } from './git.mjs';

export const workContextLimits = Object.freeze({ maxBytes:65536, fileBytes:8192, maxDocuments:12, maxFiles:500, historyLimit:300, gitBytes:262144 });
const excluded = /(^|\/)(?:\.git|\.workgraph|\.codegraph|node_modules|vendor|dist|build|coverage|\.next|\.nuxt|bin|obj|archive|archives)(?:\/|$)|(^|\/)\.workgraph\.json$/i;
const binary = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|png|jpe?g|gif|webp|ico|pdf|docx?|xlsx?|pptx?|mp[34]|wav|webm|dll|exe|so|dylib|woff2?|ttf|eot|sqlite|db|lock)$/i;
const privateFile = /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials|.*\.(?:pem|key|p12|pfx))$/i;
const size = value => Buffer.byteLength(JSON.stringify(value));
const safeName = name => typeof name==='string' && name.length>0 && !path.isAbsolute(name) && !name.includes('\0') && !name.split(/[\\/]/).some(part=>part==='..'||part===''||part==='.');
const visible = name => safeName(name) && !excluded.test(name) && !binary.test(name) && !privateFile.test(name);
const prefix = (encoded, bytes) => {
  if(encoded.length<=bytes)return encoded.toString('utf8');
  // Decode only complete UTF-8 characters; a clipped excerpt never invents U+FFFD.
  let end=bytes;
  while(end>0&&(encoded[end]&0xc0)===0x80)end--;
  return encoded.subarray(0,end).toString('utf8');
};
const clipped = (value, bytes) => prefix(Buffer.from(value),bytes);
const sha = value => typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value);
const snapshotBytes=8192,snapshotPaths=256;
const internalPath=name=>/(^|\/)(?:\.git|\.workgraph|\.codegraph)(?:\/|$)|(^|\/)\.workgraph\.json$/i.test(name);

// Only paths are retained between analyses: no source, diff, or model output.
export function normalizeWorktreeSnapshot(value) {
  if(!value||value.version!==1||typeof value.complete!=='boolean'||!Array.isArray(value.dirtyPaths)||value.dirtyPaths.length>snapshotPaths||value.dirtyPaths.some(name=>!safeName(name)||internalPath(name)))return null;
  const result={version:1,dirtyPaths:[...new Set(value.dirtyPaths)],complete:value.complete};
  return size(result)<=snapshotBytes?result:null;
}

function worktreeSnapshot(changes,truncated) {
  const result={version:1,dirtyPaths:[],complete:!truncated};
  for(const name of new Set(changes.flatMap(file=>[file.path,file.originalPath].filter(Boolean)))) {
    if(!safeName(name)||internalPath(name)){result.complete=false;continue;}
    result.dirtyPaths.push(name);
    if(result.dirtyPaths.length>snapshotPaths||size(result)>snapshotBytes){result.dirtyPaths.pop();result.complete=false;}
  }
  return result;
}

// Drain only bounded output into memory. A killed read-only query is explicitly
// marked incomplete; a real Git failure is never represented as an empty repo.
export async function contextGit(root,args,{maxBytes=workContextLimits.gitBytes,signal}={}) {
  return await new Promise((resolve,reject)=>{
    const child=spawn('git',['--no-optional-locks','-c','core.quotepath=false','-C',root,...args],{
      windowsHide:true,shell:false,signal,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat',GIT_OPTIONAL_LOCKS:'0'},
    });
    const chunks=[];let bytes=0,truncated=false,error='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill();},20000);
    child.stdout.on('data',chunk=>{
      const remaining=Math.max(0,maxBytes-bytes);
      if(remaining)chunks.push(chunk.subarray(0,remaining));
      bytes+=Math.min(chunk.length,remaining);
      if(chunk.length>remaining){truncated=true;child.kill();}
    });
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-2000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(timedOut)return reject(new Error('收集 Git 分析材料超时。'));
      if(code!==0&&!truncated){const failure=new Error(error.trim()||'收集 Git 分析材料失败。');failure.exitCode=code;return reject(failure);}
      let output=Buffer.concat(chunks).toString('utf8');
      if(truncated)output=output.slice(0,output.lastIndexOf('\0')+1);
      resolve({output,truncated});
    });
  });
}

async function regularFile(root,name) {
  if(!safeName(name))return null;
  let file=root;
  const parts=name.split(/[\\/]/);
  for(let i=0;i<parts.length;i++) {
    file=path.join(file,parts[i]);
    const info=await lstat(file);
    if(info.isSymbolicLink() || (i<parts.length-1&&!info.isDirectory()))return null;
    if(i===parts.length-1) {
      if(!info.isFile())return null;
      const resolved=await realpath(file),relative=path.relative(root,resolved);
      if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))return null;
      return {file,info};
    }
  }
  return null;
}

export async function readContextDocument(root,name,maxBytes=workContextLimits.fileBytes) {
  try {
    const target=await regularFile(root,name);
    if(!target)return {path:name,omitted:'unsafe-or-nonregular'};
    const handle=await open(target.file,'r');
    try {
      const buffer=Buffer.alloc(Math.min(target.info.size,maxBytes+4));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      const content=buffer.subarray(0,bytesRead);
      if(content.includes(0))return {path:name,omitted:'binary'};
      const text=prefix(content,maxBytes);
      if(text.includes('\ufffd'))return {path:name,omitted:'non-utf8'};
      return {path:name,bytes:target.info.size,startLine:1,endLine:text.split('\n').length,truncated:target.info.size>Buffer.byteLength(text),text};
    } finally {await handle.close();}
  } catch(error) {
    if(['ENOENT','ENOTDIR','EACCES','EPERM','ELOOP'].includes(error.code))return {path:name,omitted:error.code==='ENOENT'?'missing':'unreadable'};
    throw error;
  }
}

function documentPriority(name) {
  const lower=name.toLowerCase(),base=path.posix.basename(lower);
  if(base==='agents.md')return lower==='agents.md'?0:3;
  if(lower==='readme.md')return 1;
  if(lower==='contributing.md')return 2;
  if(/requirements|development-plan|roadmap|project-plan/.test(base))return 4;
  if(/system-design|architecture/.test(base))return 5;
  if(/(^|\/)(?:modules|architecture)\//.test(lower))return 6;
  if(base==='readme.md')return 7;
  if(/\.(?:md|rst|adoc)$/.test(base)&&base!=='changelog.md')return 8;
  return 9;
}

function appendWithin(section,item,budget) {
  if(size(section.items)+size(item)+2>budget){section.omitted++;return false;}
  section.items.push(item);return true;
}

function fitDocument(section,document,budget) {
  if(document.text===undefined||size(section.items)+size(document)+2<=budget)return document;
  let low=0,high=Buffer.byteLength(document.text),best;
  while(low<=high) {
    const bytes=Math.floor((low+high)/2),text=clipped(document.text,bytes);
    const candidate={...document,text,endLine:text.split('\n').length,truncated:true};
    if(size(section.items)+size(candidate)+2<=budget){best=candidate;low=bytes+1;}
    else high=bytes-1;
  }
  return best||document;
}

async function incrementalScope(root,previous,baseline,statusRaw,changes,limits,signal) {
  const old=previous?.analysis;
  const fallback=reason=>({kind:'fallback',reason,from:sha(old?.head)?old.head:null,to:sha(baseline.head)?baseline.head:null});
  if(!sha(old?.head))return fallback('baseline-head-unavailable');
  if(!sha(baseline.head))return fallback('current-head-unavailable');
  const snapshot=normalizeWorktreeSnapshot(old.worktree);
  if(!snapshot)return fallback('worktree-baseline-unavailable');
  if(!snapshot.complete)return fallback('worktree-baseline-incomplete');
  if(statusRaw.truncated)return fallback('current-status-incomplete');
  try {
    await contextGit(root,['merge-base','--is-ancestor',old.head,baseline.head],{maxBytes:1024,signal});
  } catch(error) {
    if(signal?.aborted||error.name==='AbortError')throw error;
    return fallback(error.exitCode===1?'history-not-descendant':'baseline-commit-unavailable');
  }
  const committed=old.head===baseline.head?{output:'',truncated:false}:await contextGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',old.head,baseline.head,'--','.',':(exclude).workgraph',':(exclude).workgraph.json',':(exclude).codegraph'],{maxBytes:limits.gitBytes,signal});
  if(committed.truncated)return fallback('committed-paths-incomplete');
  const paths=[...new Set([...committed.output.split('\0').filter(Boolean),...changes.flatMap(file=>[file.path,file.originalPath].filter(Boolean)),...snapshot.dirtyPaths])];
  if(paths.some(name=>!safeName(name)))return fallback('unsafe-changed-path');
  return {kind:'incremental',from:old.head,to:baseline.head,range:`${old.head}..${baseline.head}`,paths,previousDirtyPaths:snapshot.dirtyPaths,
    branchChanged:old.branch!==baseline.branch};
}

// Optional focusPaths/historyRange are intentionally separate from the current
// snapshot. Incremental callers can narrow evidence without changing the schema.
export async function collectWorkContext({root,mode='initialize',previous,baseline={},signal,limits:overrides={},focusPaths,historyRange}={}) {
  root=await realpath(root);
  const limits={...workContextLimits,...overrides};
  for(const [name,value] of Object.entries(limits))if(!Number.isInteger(value)||value<1)throw new Error(`分析材料限制无效：${name}`);
  if(limits.maxBytes<4096||limits.maxBytes>262144)throw new Error('分析材料大小必须在 4–256 KiB 之间。');
  if(historyRange!==undefined&&!/^[a-f0-9]{40,64}(?:\.\.[a-f0-9]{40,64})?$/.test(historyRange))throw new Error('分析提交范围必须是完整 SHA 或完整 SHA 范围。');
  const exclude=['.',':(exclude).workgraph',':(exclude).workgraph.json',':(exclude).codegraph'];
  const hasHead=sha(baseline.head);
  const [filesRaw,statusRaw,unstagedRaw,stagedRaw]=await Promise.all([
    contextGit(root,['ls-files','--cached','--others','--exclude-standard','-z','--',...exclude],{maxBytes:limits.gitBytes,signal}),
    contextGit(root,['status','--porcelain=v1','-z','--untracked-files=all','--',...exclude],{maxBytes:limits.gitBytes,signal}),
    contextGit(root,['diff','--no-ext-diff','--no-textconv','--no-renames','--numstat','-z','--',...exclude],{maxBytes:limits.gitBytes,signal}),
    contextGit(root,['diff','--cached','--no-ext-diff','--no-textconv','--no-renames','--numstat','-z','--',...exclude],{maxBytes:limits.gitBytes,signal}),
  ]);
  let codegraph=false;
  try {const info=await lstat(path.join(root,'.codegraph'));codegraph=info.isDirectory()&&!info.isSymbolicLink();}catch(error){if(error.code!=='ENOENT')throw error;}
  const allFiles=[...new Set(filesRaw.output.split('\0').filter(Boolean))];
  const eligible=allFiles.filter(visible),allChanges=parseStatus(statusRaw.output).files,changes=allChanges.filter(file=>visible(file.path));
  const delta=mode==='update'?await incrementalScope(root,previous,baseline,statusRaw,allChanges,limits,signal):null;
  if(delta?.kind==='incremental'){focusPaths=delta.paths;historyRange=delta.range;}
  else if(mode==='update'){focusPaths=undefined;historyRange=undefined;}
  const historyRaw=hasHead?await contextGit(root,['log',`--max-count=${limits.historyLimit+1}`,'--format=%H%x00%aI%x00%s%x00%b%x00',historyRange||baseline.head,'--'],{maxBytes:limits.gitBytes,signal}):{output:'',truncated:false};
  const context={version:1,mode,scope:delta?.kind==='incremental'?'incremental':focusPaths?'focused-map':'initial-map',codegraph,
    limits:{maxBytes:limits.maxBytes,fileBytes:limits.fileBytes,historyLimit:limits.historyLimit},
    documents:{items:[],omitted:0},changes:{items:[],omitted:0,excluded:allChanges.length-changes.length,totalKnown:allChanges.length,truncated:statusRaw.truncated,
      stats:{items:[],omitted:0,excluded:0,truncated:unstagedRaw.truncated||stagedRaw.truncated}},
    history:{items:[],omitted:0,truncated:historyRaw.truncated,range:historyRange||baseline.head||null},
    inventory:{items:[],omitted:0,totalKnown:allFiles.length,excluded:allFiles.length-eligible.length,truncated:filesRaw.truncated},
    coverage:{sourceContents:'not-read',documentExcerpts:true,history:historyRange?'new-commits':hasHead?'recent-commits':'head-unavailable',complete:false},
  };
  // The service persists this bounded snapshot atomically with the work record.
  // It is deliberately absent from JSON model evidence to avoid duplicate paths.
  Object.defineProperty(context,'worktree',{value:worktreeSnapshot(allChanges,statusRaw.truncated),enumerable:false});
  if(delta)context.delta={...delta,paths:{items:[],omitted:0,excluded:0},previousDirtyPaths:{items:[],omitted:0,excluded:0}};
  const compare=(a,b)=>documentPriority(a)-documentPriority(b)||a.localeCompare(b);
  const selected=focusPaths?new Set(focusPaths):null;
  const instruction=name=>path.posix.basename(name).toLowerCase()==='agents.md'&&(!selected||[...selected].some(file=>file.startsWith(path.posix.dirname(name)+'/')));
  const documents=[...new Set(['AGENTS.md',...eligible.filter(name=>/\.(?:md|rst|adoc)$/i.test(name)),...(selected?[...selected].filter(name=>visible(name)&&/\.(?:md|rst|adoc)$/i.test(name)):[])])].filter(name=>!selected||selected.has(name)||instruction(name)||['AGENTS.md','README.md','CONTRIBUTING.md'].includes(name)).sort(compare);
  const docBudget=Math.floor(limits.maxBytes*.50),historyBudget=Math.floor(limits.maxBytes*.20),inventoryBudget=Math.floor(limits.maxBytes*.10),changeBudget=Math.floor(limits.maxBytes*.08),deltaBudget=Math.floor(limits.maxBytes*.07);
  if(delta)for(const section of ['paths','previousDirtyPaths'])for(const name of delta[section]||[]) {
    if(!visible(name)){context.delta[section].excluded++;continue;}
    appendWithin(context.delta[section],name,Math.floor(deltaBudget/2));
  }
  for(const name of documents) {
    if(context.documents.items.length>=limits.maxDocuments){context.documents.omitted++;continue;}
    const remaining=docBudget-size(context.documents.items)-size({path:name,bytes:0,startLine:1,endLine:1,truncated:true,text:''})-100;
    if(remaining<256){context.documents.omitted++;continue;}
    const document=await readContextDocument(root,name,Math.min(limits.fileBytes,remaining));
    if(document.omitted==='missing'&&name==='AGENTS.md')continue;
    appendWithin(context.documents,fitDocument(context.documents,document,docBudget),docBudget);
  }
  for(const file of changes)appendWithin(context.changes,file,Math.floor(changeBudget*.6));
  for(const [area,raw] of [['unstaged',unstagedRaw],['staged',stagedRaw]])for(const record of raw.output.split('\0').filter(Boolean)) {
    const match=/^([^\t]+)\t([^\t]+)\t([\s\S]+)$/.exec(record);
    if(!match)continue;
    if(!visible(match[3])){context.changes.stats.excluded++;continue;}
    appendWithin(context.changes.stats,{area,path:match[3],added:match[1],deleted:match[2]},Math.floor(changeBudget*.4));
  }
  const fields=historyRaw.output.split('\0');
  for(let i=0;i+3<fields.length;i+=4) {
    const hash=fields[i].trim();if(!/^[a-f0-9]{40,64}$/.test(hash))continue;
    if(context.history.items.length>=limits.historyLimit){context.history.omitted++;continue;}
    const title=clipped(fields[i+2],512),body=clipped(fields[i+3],1024);
    const incompleteRecord=i+4>=fields.length;
    appendWithin(context.history,{hash,time:fields[i+1],title,body,truncated:incompleteRecord||title!==fields[i+2]||body!==fields[i+3]},historyBudget);
  }
  for(const name of eligible.filter(name=>!selected||selected.has(name)||['AGENTS.md','README.md','CONTRIBUTING.md'].includes(name)||instruction(name)).sort(compare)) {
    if(context.inventory.items.length>=limits.maxFiles){context.inventory.omitted++;continue;}
    appendWithin(context.inventory,name,inventoryBudget);
  }
  // Reserve space for metadata above; unusual path escaping must still obey the
  // one explicit serialized byte limit, not merely a character-count estimate.
  while(size(context)>limits.maxBytes) {
    const section=[context.inventory,context.history,context.documents,context.changes,context.delta?.paths,context.delta?.previousDirtyPaths].find(value=>value?.items.length);
    if(!section)throw new Error('分析材料元数据超过大小限制。');
    section.items.pop();section.omitted++;
  }
  return context;
}
