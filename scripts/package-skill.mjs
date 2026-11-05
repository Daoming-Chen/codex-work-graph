import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source=fileURLToPath(new URL('../skills/workgraph',import.meta.url));
export async function packageSkill(destination) {
  const target=path.resolve(destination);
  if(target===source||target.startsWith(source+path.sep))throw new Error('输出目录必须位于源码 skill 目录之外。');
  await readFile(path.join(source,'scripts/workgraph.mjs'));
  await readFile(path.join(source,'scripts/graph.html'));
  await mkdir(target,{recursive:false});
  for(const item of ['SKILL.md','references','scripts'])await cp(path.join(source,item),path.join(target,item),{recursive:true,errorOnExist:true,force:false});
  return target;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2])throw new Error('Usage: node scripts/package-skill.mjs <new-directory> (run npm run build first)');
  console.log(await packageSkill(process.argv[2]));
}
