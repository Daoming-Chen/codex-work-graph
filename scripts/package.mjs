import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'plugins/codex-work-graph');
// An allowlist keeps local absolute-path wiring and development files out of
// distributions. Every runtime dependency is bundled into dist/server.mjs.
export async function packagePlugin(destination) {
  const target = path.resolve(destination);
  if (target === source || target.startsWith(source + path.sep)) throw new Error('Package destination must be outside the source plugin directory.');
  await readFile(path.join(source, 'dist/server.mjs'));
  await readFile(path.join(source, 'dist/graph.html'));
  await mkdir(target, { recursive: false });
  for (const item of ['plugin.json', 'mcp.json', 'dist', 'skills', 'CODICONS-LICENSE.txt', 'THIRD-PARTY-NOTICES.md']) {
    await cp(path.join(source, item), path.join(target, item), { recursive: true, errorOnExist: true, force: false });
  }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/package.mjs <new-directory> (run npm run build first)');
  console.log(`Packaged WorkGraph: ${await packagePlugin(destination)}`);
}
