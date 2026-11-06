import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packageSkill } from './package-skill.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'plugins/workgraph');
// An allowlist keeps local absolute-path wiring and development files out of
// distributions. Every runtime dependency is bundled into dist/server.mjs.
export async function packagePlugin(destination) {
  const target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw new Error('Package destination must be outside the source plugin directory.');
  await readFile(path.join(source, 'dist/server.mjs'));
  await readFile(path.join(source, 'dist/graph.html'));
  await mkdir(target, { recursive: false });
  for (const item of ['LICENSE', 'plugin.json', 'mcp.json', 'THIRD-PARTY-LICENSES.txt', 'CODICONS-LICENSE.txt', 'THIRD-PARTY-NOTICES.md']) {
    await cp(path.join(source, item), path.join(target, item), { recursive: true, errorOnExist: true, force: false });
  }
  await mkdir(path.join(target, 'dist'));
  for (const item of ['server.mjs', 'graph.html']) await cp(path.join(source, 'dist', item), path.join(target, 'dist', item), { errorOnExist: true, force: false });
  await mkdir(path.join(target, 'skills'));
  await packageSkill(path.join(target, 'skills/workgraph'));
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/package.mjs <new-directory> (run npm run build first)');
  console.log(`Packaged WorkGraph: ${await packagePlugin(destination)}`);
}
