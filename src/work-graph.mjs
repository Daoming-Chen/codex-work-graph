import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { git, resolveRepository, parseStatus } from './git.mjs';

// Explicit work ownership; commit messages are evidence, never instructions.
export async function readWorkGraph(repositoryPath) {
  const { root, bare } = await resolveRepository(repositoryPath);
  let manifest = { version: 1, works: [] };
  let source = 'Git';
  if (!bare) { const record = await loadWorkRecord(root); manifest = record.manifest; source = record.source; }
  const works = validateWorkManifest(manifest);
  const head = (await git(root, ['rev-parse','--verify','--quiet','HEAD']).catch(() => '')).trim();
  const raw = head ? await git(root, ['log','--max-count=301','--format=%H%x00%aI%x00%s%x00%b%x00','HEAD','--']) : '';
  const fields = raw.split('\0'), records = [];
  for (let i=0;i+3<fields.length;i+=4) {
    const hash=fields[i].trim(); if (!hash) continue;
    const explicit=works.find(w=>w.commits.includes(hash));
    const trailers=[...fields[i+3].matchAll(/^Work-Item: ([A-Z][A-Z0-9-]{0,39})\s*$/gm)].map(m=>m[1]);
    const owner=explicit || (trailers.length===1 ? works.find(w=>w.id===trailers[0]) : null);
    records.push({hash,time:fields[i+1],title:fields[i+2],workId:owner?.id || 'UNASSIGNED'});
  }
  const hasMore=records.length>300; records.length=Math.min(records.length,300);
  if(records.some(r=>r.workId==='UNASSIGNED')) works.push({id:'UNASSIGNED',title:'未关联的提交',status:'待开始',next:'核对提交归属',summary:'尚未关联到工作项的历史。',commits:[]});
  const dirty=bare?[]:parseStatus(await git(root,['status','--porcelain=v1','-z','--untracked-files=all'])).files;
  return {repository:{path:root,name:path.basename(root)},head,works,records,dirty,hasMore,scope:'HEAD 最近 300 条提交',source,initialized:source === '.workgraph/state.json + Git'};
}

export function validateWorkManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.works) || manifest.works.length > 100) throw new Error('工作记录格式无效。');
  const ids = new Set(), hashes = new Set();
  const works = manifest.works.map(w => {
    if (!w || typeof w !== 'object' || Array.isArray(w) || !/^[A-Z][A-Z0-9-]{0,39}$/.test(w.id) || w.id === 'UNASSIGNED' || ids.has(w.id) || typeof w.title !== 'string' || !w.title.trim() || w.title.length > 160 || !['进行中','已完成','已搁置','待开始'].includes(w.status) || !Array.isArray(w.commits) || w.commits.length > 1000) throw new Error('工作项格式或标识无效。');
    if (Object.keys(w).some(key=>!['id','title','status','commits','next','summary','parentId','kind','updatedAt','outcomes','issues'].includes(key))) throw new Error('工作项包含未知字段。');
    ids.add(w.id);
    for (const h of w.commits) {
      if (!/^[a-f0-9]{40,64}$/.test(h) || hashes.has(h)) throw new Error('提交关联无效或重复。');
      hashes.add(h);
    }
    for (const key of ['next','summary']) if (w[key] !== undefined && (typeof w[key] !== 'string' || w[key].length > 1000)) throw new Error('工作摘要无效。');
    if (w.parentId !== undefined && (typeof w.parentId !== 'string' || !/^[A-Z][A-Z0-9-]{0,39}$/.test(w.parentId))) throw new Error('父工作项标识无效。');
    if (w.kind !== undefined && !['work','outcome'].includes(w.kind)) throw new Error('工作项类型无效。');
    // Require an actual, unambiguous timestamp; never derive a work update from Git activity.
    if (w.updatedAt !== undefined && (typeof w.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(w.updatedAt) || !Number.isFinite(Date.parse(w.updatedAt)) || new Date(w.updatedAt).toISOString() !== w.updatedAt.replace(/Z$/,w.updatedAt.includes('.')?'Z':'.000Z'))) throw new Error('工作更新时间必须是有效的 UTC ISO 时间。');
    for (const key of ['outcomes','issues']) if (w[key] !== undefined && (!Array.isArray(w[key]) || w[key].length > 20 || w[key].some(value=>typeof value !== 'string' || !value.trim() || value.length > 1000))) throw new Error('成果或问题记录无效。');
    return { id:w.id, title:w.title, status:w.status, next:w.next || '', summary:w.summary || '', commits:w.commits,
      parentId:w.parentId || null, kind:w.kind || 'work', updatedAt:w.updatedAt || null, outcomes:w.outcomes || [], issues:w.issues || [] };
  });
  const byId=new Map(works.map(work=>[work.id,work]));
  for (const work of works) {
    const visited=new Set([work.id]);let current=work,depth=0;
    while(current.parentId) {
      if (!byId.has(current.parentId) || visited.has(current.parentId)) throw new Error('工作层级包含缺失父项或循环引用。');
      visited.add(current.parentId);current=byId.get(current.parentId);
      if (++depth > 2) throw new Error('工作层级最多支持三层。');
    }
  }
  return works;
}

export async function loadWorkRecord(root) {
  try {
    const directory = await lstat(path.join(root, '.workgraph'));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('.workgraph 必须是普通目录。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of ['.workgraph/state.json', '.workgraph.json']) {
    try {
      const filename = path.join(root, name), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 262144) throw new Error('工作记录必须是小于 256 KiB 的普通文件。');
      const record = JSON.parse(await readFile(filename, 'utf8'));
      validateWorkManifest(record);
      return { manifest: record, source: name + ' + Git' };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { manifest: { version: 1, works: [] }, source: 'Git' };
}
