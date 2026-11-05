import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'plugins/codex-work-graph/dist');
await mkdir(out, { recursive: true });
const ui = await build({ entryPoints: [path.join(root, 'src/ui/app.js')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true });
const css = await readFile(path.join(root, 'src/ui/style.css'), 'utf8');
const template = await readFile(path.join(root, 'src/ui/index.html'), 'utf8');
const html = template.replace('/* STYLES */', () => css).replace('/* SCRIPT */', () => ui.outputFiles[0].text.replaceAll('</script', '<\\/script'));
new Script(html.match(/<script>([\s\S]*)<\/script>/)[1], { filename: 'graph-inline.js' });
await writeFile(path.join(out, 'graph.html'), html);
const skill = path.join(root, 'skills/workgraph');
await mkdir(path.join(skill, 'scripts'), { recursive: true });
await build({ entryPoints: [path.join(root, 'src/workgraph-cli.mjs')], bundle: true, outfile: path.join(skill, 'scripts/workgraph.mjs'),
  platform: 'node', format: 'esm', target: 'node22' });
// The standalone skill displays the work map; Git management stays in the plugin.
const workUi = await build({ entryPoints: [path.join(root, 'src/ui/work-map.js')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true });
const workTemplate = await readFile(path.join(root, 'src/ui/work-map.html'), 'utf8');
await writeFile(path.join(skill, 'scripts/graph.html'), workTemplate.replace('/* STYLES */', () => css).replace('/* SCRIPT */', () => workUi.outputFiles[0].text.replaceAll('</script', '<\\/script')));
await build({ entryPoints: [path.join(root, 'src/server.mjs')], bundle: true, outfile: path.join(out, 'server.mjs'),
  platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
// Legacy developer wiring is separate from the portable root mcp.json, whose
// ${PLUGIN_ROOT} placeholder is resolved by the plugin host after installation.
await writeFile(path.join(root, 'plugins/codex-work-graph/.mcp.json'), JSON.stringify({ mcpServers: { git_graph: {
  command: process.execPath, args: [path.join(out, 'server.mjs')],
} } }, null, 2) + '\n');
console.log('Built portable plugins/codex-work-graph/dist and legacy local MCP configuration.');

await writeFile(path.join(root,'plugins/codex-work-graph/CODICONS-LICENSE.txt'), await readFile(path.join(root,'node_modules/@vscode/codicons/LICENSE')));
await writeFile(path.join(root,'plugins/codex-work-graph/THIRD-PARTY-NOTICES.md'),'Microsoft Codicons 0.0.44 SVG assets, Copyright Microsoft Corporation, CC BY 4.0. See CODICONS-LICENSE.txt. Source: https://github.com/microsoft/vscode-codicons. Accessibility attributes added; shapes unchanged.\n');
for (const name of ['CODICONS-LICENSE.txt', 'THIRD-PARTY-NOTICES.md']) await cp(path.join(root, 'plugins/codex-work-graph', name), path.join(skill, 'scripts', name));
await cp(skill, path.join(root, 'plugins/codex-work-graph/skills/workgraph'), { recursive: true });
