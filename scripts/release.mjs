import { readFile, writeFile, mkdir, mkdtemp, readdir, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { packagePlugin } from './package.mjs';
import { packageSkill } from './package-skill.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const exec = promisify(execFile);
export function validateReleaseVersion(pkg, plugin, tag, lock) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version) || pkg.name !== 'workgraph' || plugin.name !== pkg.name || plugin.version !== pkg.version) throw new Error('Package and plugin release versions must match.');
  if (lock && (lock.name !== pkg.name || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version)) throw new Error('Lockfile release version must match package.json.');
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}.`);
  return pkg.version;
}
export function encodeReleaseArchive(entries) {
  return zipSync(Object.fromEntries(entries.map(([name, bytes]) => [name, [bytes, { mtime: new Date(2000, 0, 1), level: 9 }]])));
}
async function archive(directory) {
  const files = [];
  async function visit(relative = '') {
    const names = (await readdir(path.join(directory, relative))).sort();
    for (const name of names) {
      const local = path.join(relative, name), full = path.join(directory, local), stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${local}`);
      if (stat.isDirectory()) await visit(local);
      else if (stat.isFile()) files.push([`workgraph/${local.split(path.sep).join('/')}`, await readFile(full)]);
      else throw new Error(`Unsupported release file: ${local}`);
    }
  }
  await visit();
  return encodeReleaseArchive(files);
}
export function releaseNotes(version) {
  return `# WorkGraph ${version}\n\n- workgraph-skill-${version}.zip: standalone skill; Node.js 22+ and Git required.\n- workgraph-plugin-${version}.zip: optional Codex plugin, including the same skill.\n- Both archives extract into a workgraph directory and include project and third-party licenses.\n\nVerify SHA256SUMS before installing.\nInstallation and host acceptance checklist: https://github.com/Daoming-Chen/codex-work-graph/blob/v${version}/docs/releasing.md\n\nThis package preparation does not certify desktop host installation, upgrade, or uninstall. Record actual acceptance results before publishing.\n`;
}
export async function createRelease({ destination, tag } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(path.join(root, 'plugins/workgraph/plugin.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const version = validateReleaseVersion(pkg, plugin, tag, lock);
  const target = path.resolve(destination || path.join(root, '.release-output', `v${version}`));
  // Refuse overwrite before running a build or writing staging files.
  await lstat(target).then(() => { throw new Error('Release output already exists; choose a new directory.'); }, error => { if (error.code !== 'ENOENT') throw error; });
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(target), '.workgraph-release-'));
  try {
    await exec(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const pluginDirectory = await packagePlugin(path.join(staging, 'plugin'));
    const skillDirectory = await packageSkill(path.join(staging, 'skill'));
    const sums = [];
    for (const [kind, directory] of [['plugin', pluginDirectory], ['skill', skillDirectory]]) {
      const filename = `workgraph-${kind}-${version}.zip`, bytes = await archive(directory);
      await writeFile(path.join(staging, filename), bytes, { flag: 'wx' });
      sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${filename}`);
      await rm(directory, { recursive: true });
    }
    await writeFile(path.join(staging, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' });
    await writeFile(path.join(staging, 'RELEASE-NOTES.md'), releaseNotes(version), { flag: 'wx' });
    await rename(staging, target);
    return { version, directory: target, files: [...sums.map(line => line.split('  ')[1]), 'SHA256SUMS', 'RELEASE-NOTES.md'] };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1];
      if (!['--output', '--tag'].includes(key) || !value || value.startsWith('--') || options[key]) throw new Error('Usage: npm run release -- [--tag vX.Y.Z] [--output <new-directory>]');
      options[key] = value;
    }
    console.log(JSON.stringify(await createRelease({ destination: options['--output'], tag: options['--tag'] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
