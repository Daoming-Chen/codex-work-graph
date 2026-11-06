import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Script } from 'node:vm';
import { collectThirdPartyLicenses } from './third-party-licenses.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'plugins/workgraph/dist');
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
const workUi = await build({ entryPoints: [path.join(root, 'src/ui/work-map.js')], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true });
const workTemplate = await readFile(path.join(root, 'src/ui/work-map.html'), 'utf8');
await writeFile(path.join(skill, 'scripts/graph.html'), workTemplate.replace('/* STYLES */', () => css).replace('/* SCRIPT */', () => workUi.outputFiles[0].text.replaceAll('</script', '<\\/script')));
await build({ entryPoints: [path.join(root, 'src/server.mjs')], bundle: true, outfile: path.join(out, 'server.mjs'),
  platform: 'node', format: 'esm', target: 'node22',
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' } });
console.log('Built plugins/workgraph/dist and standalone skills/workgraph.');

await writeFile(path.join(root,'plugins/workgraph/CODICONS-LICENSE.txt'), await readFile(path.join(root,'node_modules/@vscode/codicons/LICENSE')));
await writeFile(path.join(root,'plugins/workgraph/THIRD-PARTY-NOTICES.md'),'Microsoft Codicons 0.0.44 SVG assets, Copyright Microsoft Corporation, CC BY 4.0. See CODICONS-LICENSE.txt. Source: https://github.com/microsoft/vscode-codicons. Accessibility attributes added; shapes unchanged.\n');
await writeFile(path.join(skill, 'scripts/CODICONS-LICENSE.txt'), (await readFile(path.join(root, 'plugins/workgraph/CODICONS-LICENSE.txt'), 'utf8')).replace(/\r\n/g, '\n').replace(/[ \t]+(?=\r?$)/gm, ''));
await cp(path.join(root, 'plugins/workgraph/THIRD-PARTY-NOTICES.md'), path.join(skill, 'scripts/THIRD-PARTY-NOTICES.md'));
const projectLicense = await readFile(path.join(root, 'LICENSE'), 'utf8');
await writeFile(path.join(root, 'plugins/workgraph/LICENSE'), projectLicense);
await writeFile(path.join(skill, 'LICENSE'), projectLicense);
const thirdPartyLicenses = await collectThirdPartyLicenses(root);
await writeFile(path.join(root, 'plugins/workgraph/THIRD-PARTY-LICENSES.txt'), thirdPartyLicenses);
await writeFile(path.join(skill, 'scripts/THIRD-PARTY-LICENSES.txt'), thirdPartyLicenses);
const packagedSkill = path.join(root, 'plugins/workgraph/skills/workgraph');
await rm(packagedSkill, { recursive: true, force: true });
await cp(skill, packagedSkill, { recursive: true });
