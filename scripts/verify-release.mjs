import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeReleaseArchive, releaseNotes, validateReleaseVersion } from './release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const maxFileBytes = 16 * 1024 * 1024;
const maxArchiveSourceBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 1024 * 1024;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// Keep the verification contract independent of the packaging copy lists.
const skillFiles = [
  'LICENSE', 'SKILL.md', 'references/initialize.md', 'references/update.md',
  'scripts/CODICONS-LICENSE.txt', 'scripts/THIRD-PARTY-LICENSES.txt',
  'scripts/THIRD-PARTY-NOTICES.md', 'scripts/graph.html', 'scripts/workgraph.mjs',
];
const pluginFiles = [
  'CODICONS-LICENSE.txt', 'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'THIRD-PARTY-NOTICES.md',
  'dist/graph.html', 'dist/server.mjs', 'mcp.json', 'plugin.json',
];

async function readBoundedFile(filename, limit = maxFileBytes) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
    throw new Error(`Expected a nonempty regular file of at most ${limit} bytes: ${filename}`);
  }
  const file = await open(filename, readFlags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new Error(`File changed before verification: ${filename}`);
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error(`File size changed during verification: ${filename}`);
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function canonicalArchive(kind, license) {
  const skillPrefix = kind === 'plugin' ? 'skills/workgraph/' : '';
  const layout = skillFiles.map(name => [`${skillPrefix}${name}`, `skills/workgraph/${name}`]);
  if (kind === 'plugin') {
    layout.push(...pluginFiles.map(name => [name, `plugins/workgraph/${name}`]));
  }
  layout.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let total = 0;
  const entries = [];
  for (const [name, source] of layout) {
    const bytes = await readBoundedFile(path.join(root, source), Math.min(maxFileBytes, maxArchiveSourceBytes - total));
    if (name.endsWith('/LICENSE') || name === 'LICENSE') {
      if (!bytes.equals(license)) throw new Error(`Project LICENSE differs from the repository license: ${source}`);
    }
    total += bytes.length;
    entries.push([`workgraph/${name}`, bytes]);
  }
  return encodeReleaseArchive(entries);
}

export async function verifyRelease({ directory, tag }) {
  const target = path.resolve(directory);
  if (!(await lstat(target)).isDirectory()) throw new Error(`Expected a regular release directory: ${target}`);
  const readJson = async relative => JSON.parse(await readBoundedFile(path.join(root, relative), maxMetadataBytes));
  const version = validateReleaseVersion(
    await readJson('package.json'), await readJson('plugins/workgraph/plugin.json'), tag, await readJson('package-lock.json'),
  );
  const kinds = ['plugin', 'skill'];
  const archives = kinds.map(kind => `workgraph-${kind}-${version}.zip`);
  const files = [...archives, 'SHA256SUMS', 'RELEASE-NOTES.md'];
  const missing = new Set(files);
  const unexpectedFileSet = () => new Error(`Unexpected release file set. Expected: ${files.join(', ')}.`);
  for await (const item of await opendir(target)) {
    if (!item.isFile() || !missing.delete(item.name)) throw unexpectedFileSet();
  }
  if (missing.size) throw unexpectedFileSet();
  const license = await readBoundedFile(path.join(root, 'LICENSE'), maxMetadataBytes);
  const manifest = await readBoundedFile(path.join(target, 'SHA256SUMS'), maxMetadataBytes);
  const sums = [];
  const candidates = [];
  for (const filename of archives) {
    const bytes = await readBoundedFile(path.join(target, filename));
    candidates.push(bytes);
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${filename}`);
  }
  if (!manifest.equals(Buffer.from(sums.join('\n') + '\n'))) throw new Error('SHA256SUMS does not match the candidate ZIPs.');
  const notes = await readBoundedFile(path.join(target, 'RELEASE-NOTES.md'), maxMetadataBytes);
  if (!notes.equals(Buffer.from(releaseNotes(version)))) throw new Error('RELEASE-NOTES.md does not match the candidate version and files.');
  for (const [index, kind] of kinds.entries()) {
    const filename = archives[index];
    const expected = await canonicalArchive(kind, license);
    // Comparing with trusted canonical bytes avoids parsing or inflating candidate data.
    if (!candidates[index].equals(expected)) throw new Error(`${filename} differs from the expected ZIP layout or checkout contents.`);
  }
  return { version, directory: target, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, flag, tag, ...extra] = process.argv.slice(2);
    if (!directory || directory.startsWith('--') || extra.length || (flag !== undefined && (flag !== '--tag' || !tag))) {
      throw new Error('Usage: npm run release:verify -- <candidate-directory> [--tag vX.Y.Z]');
    }
    console.log(JSON.stringify(await verifyRelease({ directory, tag })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
