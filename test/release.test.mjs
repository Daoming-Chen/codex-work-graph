import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { createRelease, validateReleaseVersion } from '../scripts/release.mjs';
import { collectThirdPartyLicenses } from '../scripts/third-party-licenses.mjs';
const exec = promisify(execFile);

test('release refuses mismatched versions and tags before creating output', async t => {
  assert.throws(() => validateReleaseVersion({ name: 'workgraph', version: '0.3.0' }, { name: 'workgraph', version: '0.4.0' }, 'v0.3.0'), /versions/);
  assert.throws(() => validateReleaseVersion({ name: 'workgraph', version: '0.3.0' }, { name: 'workgraph', version: '0.3.0' }, 'v0.3.0', { name: 'workgraph', version: '0.2.0', packages: { '': { version: '0.2.0' } } }), /Lockfile/);
  await mkdir('.test-output', { recursive: true });
  const parent = await mkdtemp(path.resolve('.test-output/release-refusal-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const destination = path.join(parent, 'bad');
  await assert.rejects(createRelease({ destination, tag: 'v999.0.0' }), /Release tag/);
  await assert.rejects(access(destination), { code: 'ENOENT' });
});

test('release archives preserve licensing, exclude stale files, relocate, and reproduce checksums', async t => {
  await mkdir('.test-output', { recursive: true });
  const parent = await mkdtemp(path.resolve('.test-output/release-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  // User-created files and old build artifacts must never become release assets.
  const id = randomUUID();
  const stale = [`skills/workgraph/scripts/local-secret-${id}.tmp`, `plugins/workgraph/dist/stale-${id}.mjs`, `plugins/workgraph/skills/workgraph/stale-${id}.txt`];
  for (const filename of stale) {
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, 'not for distribution', { flag: 'wx' });
  }
  t.after(() => Promise.all(stale.map(filename => rm(filename, { force: true }))));
  const first = await createRelease({ destination: path.join(parent, 'one') });
  const second = await createRelease({ destination: path.join(parent, 'two') });
  assert.equal(await readFile(path.join(first.directory, 'SHA256SUMS'), 'utf8'), await readFile(path.join(second.directory, 'SHA256SUMS'), 'utf8'));
  await assert.rejects(createRelease({ destination: first.directory }), /already exists/);
  const license = await readFile('LICENSE', 'utf8');
  const checksums = await readFile(path.join(first.directory, 'SHA256SUMS'), 'utf8');
  for (const kind of ['plugin', 'skill']) {
    const name = `workgraph-${kind}-${first.version}.zip`, archive = await readFile(path.join(first.directory, name));
    assert.ok(checksums.includes(`${createHash('sha256').update(archive).digest('hex')}  ${name}`));
    const files = unzipSync(archive);
    assert.equal(Buffer.from(files['workgraph/LICENSE']).toString(), license);
    assert.ok(Object.keys(files).every(name => name.startsWith('workgraph/') && !name.includes('..') && !/stale|local-secret|node_modules/.test(name)));
    const notices = Buffer.from(files[kind === 'plugin' ? 'workgraph/THIRD-PARTY-LICENSES.txt' : 'workgraph/scripts/THIRD-PARTY-LICENSES.txt']).toString();
    assert.match(notices, /@modelcontextprotocol\/sdk@/);
    assert.match(notices, /zod@/);
    assert.match(notices, /Permission is hereby granted/);
    assert.match(notices, /Microsoft Corporation/);
    const prefix = kind === 'plugin' ? 'workgraph/skills/workgraph/' : 'workgraph/';
    assert.equal(Buffer.from(files[`${prefix}LICENSE`]).toString(), license);
    const relocated = path.join(parent, `${kind} 中文 with spaces`);
    for (const [filename, bytes] of Object.entries(files)) {
      const destination = path.join(relocated, filename); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    }
    const entry = path.join(relocated, prefix, 'scripts/workgraph.mjs');
    const doctor = JSON.parse((await exec(process.execPath, [entry, 'doctor'], { cwd: parent })).stdout);
    assert.equal(doctor.ready, true);
  }
});

test('third-party notice collection fails instead of silently dropping missing license texts', async t => {
  const base = await mkdtemp(path.resolve('.test-output/notices-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'node_modules/example'), { recursive: true });
  await writeFile(path.join(base, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/example': { version: '1.0.0' } } }));
  await writeFile(path.join(base, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.0.0', license: 'MIT' }));
  await assert.rejects(collectThirdPartyLicenses(base), /Missing third-party license text/);
});
