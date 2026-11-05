import { readFile, writeFile, lstat, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWorkAnalysis, resolveAnalysisMode, workFingerprint } from './work-analysis.mjs';
import { collectWorkContext } from './work-context.mjs';
import { loadWorkRecord } from './work-graph.mjs';
import { resolveRepository } from './git.mjs';
import { startHttp } from './http.mjs';

export async function prepareWorkMap(repositoryPath) {
  const {root,bare}=await resolveRepository(repositoryPath);
  if(bare)throw new Error('裸仓库不能建立工作地图。');
  const mode=await resolveAnalysisMode(root);
  const {manifest:previous}=await loadWorkRecord(root);
  const baseline=await workFingerprint(root);
  const context=await collectWorkContext({root,mode,previous,baseline});
  return {version:1,root,mode,previous,baseline,context};
}

export async function saveWorkMap(repositoryPath, packet, result) {
  const {root}=await resolveRepository(repositoryPath);
  if(packet?.version!==1||packet.root!==root||!packet.baseline?.fingerprint||!packet.previous||!packet.context)throw new Error('分析材料与目标仓库不匹配。');
  const service=createWorkAnalysis({
    execution:'agent-save',
    collector:async({mode,previous,baseline})=>{
      if(mode!==packet.mode||JSON.stringify(previous)!==JSON.stringify(packet.previous)||baseline.fingerprint!==packet.baseline.fingerprint)throw new Error('收集材料后仓库或工作记录已变化，请重新收集并分析。');
      return packet.context;
    },
    runner:async()=>result,
  });
  try {
    await service.start(root);
    const status=await service.wait(root);
    if(status.state!=='idle')throw new Error(status.error||'工作地图保存失败。');
    const {manifest}=await loadWorkRecord(root);
    return {state:'saved',repositoryPath:root,mode:packet.mode,recordPath:path.join(root,'.workgraph/state.json'),workCount:manifest.works.length};
  } finally {await service.close();}
}

async function jsonFile(filename) {
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)throw new Error('输入必须是小于 4 MiB 的普通 JSON 文件。');
  return JSON.parse((await readFile(filename,'utf8')).replace(/^\uFEFF/,''));
}

async function requestPath(repositoryPath) {
  const {root,bare}=await resolveRepository(repositoryPath);
  if(bare)throw new Error('裸仓库不能建立工作地图。');
  for(const name of ['.workgraph','.workgraph/runtime']) {
    const directory=path.join(root,name);
    await mkdir(directory).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('WorkGraph 运行路径必须是普通目录。');
  }
  await writeFile(path.join(root,'.workgraph/.gitignore'),'runtime/\nstate-*.tmp\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  return path.join(await mkdtemp(path.join(root,'.workgraph/runtime/request-')),'context.json');
}

export async function runCli(argv) {
  const [command,...args]=argv;
  if(!command||command==='--help'||command==='help')return {
    commands:['doctor','status --repo <path>','context --repo <path>','save --repo <path> --context <context.json> --input <candidate.json>','open --repo <path>'],
    usage:'Only context + save update the work map when the user requests it. status/open never start analysis. open stays running until Ctrl+C.',
  };
  const options={};
  for(let i=0;i<args.length;i+=2){if(!['--repo','--context','--input'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options[args[i]])throw new Error('参数无效，请运行 --help。');options[args[i]]=args[i+1];}
  if(command==='doctor') {
    for(const asset of ['./graph.html','../references/initialize.md','../references/update.md'])await readFile(new URL(asset,import.meta.url));
    return {node:process.version,git:execFileSync('git',['--version'],{encoding:'utf8',windowsHide:true}).trim(),ready:Number(process.versions.node.split('.')[0])>=22};
  }
  if(!options['--repo'])throw new Error('请用 --repo 显式传入当前仓库路径。');
  const repo=options['--repo'];
  if(command==='status') {
    const {root,bare}=await resolveRepository(repo);
    return {repositoryPath:root,available:!bare,...await loadWorkRecord(root)};
  }
  if(command==='context') {
    const packet=await prepareWorkMap(repo);
    const output=await requestPath(repo);
    await writeFile(output,JSON.stringify(packet,null,2)+'\n',{flag:'wx'});
    return {state:'prepared',mode:packet.mode,contextPath:path.resolve(output),candidatePath:path.join(path.dirname(path.resolve(output)),'candidate.json'),reference:`references/${packet.mode}.md`};
  }
  if(command==='save') {
    if(!options['--context']||!options['--input'])throw new Error('save 需要 --context 和 --input。');
    return saveWorkMap(repo,await jsonFile(options['--context']),await jsonFile(options['--input']));
  }
  if(command==='open') {
    const html=await readFile(new URL('./graph.html',import.meta.url),'utf8');
    const panel=await startHttp({repositoryPath:repo,html,workMapOnly:true});
    const shutdown=async()=>{await panel.close();};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
    return {panelUrl:panel.url,repositoryPath:(await resolveRepository(repo)).root,lifecycle:'Keep this process running; Ctrl+C closes the panel.'};
  }
  throw new Error('未知命令，请运行 --help。');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await runCli(process.argv.slice(2))));}
  catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
}
