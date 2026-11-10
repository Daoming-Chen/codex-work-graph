import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { git } from '../src/git.mjs';
import { prepareWorkMap, runCli, saveWorkMap } from '../src/workgraph-cli.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/workgraph-cli.mjs', import.meta.url));
const commit = n => n.toString(16).padStart(40, '0');
const work = (id, commits = [], extra = {}) => ({ id, title: id, status: '进行中', commits, ...extra });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  await mkdir('.test-output', { recursive: true });
  const base = await mkdtemp(path.resolve('.test-output/work-preview-'));
  return { base, root: path.join(base, 'repository'), context: path.join(base, 'context.json'), input: path.join(base, 'candidate.json'), receipt: path.join(base, 'preview.json') };
}

async function inputs(f, packet, candidate) {
  await writeFile(f.context, JSON.stringify(packet));
  await writeFile(f.input, JSON.stringify(candidate));
}

const previewArgs = f => ['preview', '--context', f.context, '--input', f.input];
const saveArgs = f => ['save', '--repo', f.root, '--context', f.context, '--input', f.input, '--preview', f.receipt];
const offlinePacket = (f, works = []) => ({
  version: 1, root: f.root, mode: 'update', previous: { version: 1, works },
  baseline: { fingerprint: 'a'.repeat(64) }, context: { scope: 'incremental' },
});

test('offline CLI previews compact update and explicit ownership changes without invoking Git', async () => {
  const f = await fixture();
  const packet = offlinePacket(f, [work('WG-A', [commit(1), commit(2)]), work('WG-B'), work('WG-C')]);
  const candidate = {
    version: 1,
    works: [work('WG-A'), work('WG-B', [commit(1)]), work('WG-D', [commit(3)])],
    unchangedIds: ['WG-C'],
  };
  await inputs(f, packet, candidate);
  // No repository exists. A real CLI process has no Git or model on PATH.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  environment.PATH = f.base;
  const { stdout } = await exec(process.execPath, [cli, ...previewArgs(f)], { env: environment, cwd: f.base });
  const preview = JSON.parse(stdout);
  assert.equal(preview.mode, 'update');
  assert.equal(preview.scope, 'incremental');
  assert.equal(preview.contextDigest, hash(await readFile(f.context)));
  assert.equal(preview.candidateDigest, hash(await readFile(f.input)));
  assert.deepEqual(preview.added, ['WG-D']);
  assert.deepEqual(preview.changed, [{ id: 'WG-A', fields: ['commits'] }, { id: 'WG-B', fields: ['commits'] }]);
  assert.deepEqual(preview.unchanged, ['WG-C']);
  assert.deepEqual(preview.explicitCommitOwnership, {
    total: 3, omitted: 0,
    changes: [
      { commit: commit(1), from: 'WG-A', to: 'WG-B' },
      { commit: commit(2), from: 'WG-A', to: null },
      { commit: commit(3), from: null, to: 'WG-D' },
    ],
  });
  assert.deepEqual((await readdir(f.base)).sort(), ['candidate.json', 'context.json']);
});

test('previews are bounded and keep the full ownership change count', async () => {
  const f = await fixture();
  await inputs(f, offlinePacket(f), { version: 1, works: [work('WG-A', Array.from({ length: 1000 }, (_, i) => commit(i)))] });
  const preview = await runCli(previewArgs(f));
  assert.equal(preview.explicitCommitOwnership.total, 1000);
  assert.equal(preview.explicitCommitOwnership.omitted, 900);
  assert.equal(preview.explicitCommitOwnership.changes.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) + 1 <= 64 * 1024);
});

test('detail excerpts show reviewable values and omit excess data without breaking JSON', async () => {
  const f = await fixture();
  const old = Array.from({ length: 75 }, (_, i) => work(`WORK-${i}`, [], {
    title: 'Before title', next: 'Before next', summary: '\u001b'.repeat(1000),
  }));
  const hostile = '"}\n\u001b[2J' + '😀'.repeat(200);
  const changed = old.map(item => ({
    ...item, title: 'After title', status: '已完成', next: hostile, summary: '\u0001'.repeat(1000),
    issues: ['New issue'],
  }));
  const added = Array.from({ length: 25 }, (_, i) => work(`ADDED-${i}`, [], {
    title: 'Added title', next: 'Added next',
  }));
  await inputs(f, offlinePacket(f, old), { version: 1, works: [...changed, ...added] });
  const preview = await runCli(previewArgs(f));
  assert.equal(preview.added.length, 25);
  assert.equal(preview.changed.length, 75);
  assert.equal(preview.details.added[0].title.text, 'Added title');
  assert.equal(preview.details.added[0].status, '进行中');
  const first = preview.details.changed[0];
  assert.equal(first.values.title.from.text, 'Before title');
  assert.equal(first.values.title.to.text, 'After title');
  assert.equal(first.values.status.to.text, '已完成');
  assert.equal(first.values.next.to.text, Array.from(hostile).slice(0, 120).join(''));
  assert.equal(first.values.next.to.truncated, true);
  assert.deepEqual(first.omittedFields, ['issues']);
  assert.equal(preview.details.omitted.added, 25 - preview.details.added.length);
  assert.equal(preview.details.omitted.changed, 75 - preview.details.changed.length);
  assert.ok(preview.details.omitted.added > 0);
  assert.ok(preview.details.omitted.changed > 0);
  const json = JSON.stringify(preview);
  assert.equal(json.includes('\u001b'), false);
  assert.ok(Buffer.byteLength('\ufeff' + json + '\r\n') <= 64 * 1024);
  assert.deepEqual(JSON.parse(json), preview);
});

test('preview rejects dropped IDs, conflicting ownership, invalid records and unsupported input files', async t => {
  const f = await fixture(), packet = offlinePacket(f, [work('WG-A')]);
  for (const [candidate, expected] of [
    [{ version: 1, works: [work('WG-B')] }, /丢失已有工作项/],
    [{ version: 1, works: [work('WG-A', [commit(1)]), work('WG-B', [commit(1)])] }, /提交关联无效或重复/],
    [{ version: 1, works: [work('WG-A')], unchangedIds: ['WG-A'] }, /重叠/],
    [{ version: 2, works: [] }, /候选工作记录格式无效/],
    [{ version: 1, works: [work('WG-A', [], { parentId: 'MISSING' })] }, /缺失父项/],
  ]) {
    await inputs(f, packet, candidate);
    await assert.rejects(runCli(previewArgs(f)), expected);
  }
  await writeFile(f.input, Buffer.from([0x22, 0xff, 0x22]));
  await assert.rejects(runCli(previewArgs(f)), /有效的 UTF-8 JSON/);
  await writeFile(f.input, ' '.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(runCli(previewArgs(f)), /4 MiB/);
  const link = path.join(f.base, 'linked.json');
  try { await symlink(f.context, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink creation unavailable.'); return; } throw error; }
  await assert.rejects(runCli(['preview', '--context', link, '--input', f.input]), /普通 JSON 文件/);
});

test('bound save hashes original bytes before touching the repository and accepts matching BOM inputs', async () => {
  const f = await fixture();
  await mkdir(f.root);
  await git(f.root, ['init', '-b', 'main']);
  const contextBytes = '\ufeff' + JSON.stringify(await prepareWorkMap(f.root));
  const candidateBytes = '\ufeff' + JSON.stringify({ version: 1, works: [work('WG-A')] });
  await writeFile(f.context, contextBytes);
  await writeFile(f.input, candidateBytes);
  const preview = await runCli(previewArgs(f));
  assert.equal(preview.contextDigest, hash(contextBytes));
  assert.equal(preview.candidateDigest, hash(candidateBytes));
  await writeFile(f.receipt, JSON.stringify(preview));
  for (const [filename, bytes] of [[f.context, contextBytes], [f.input, candidateBytes]]) {
    await writeFile(filename, bytes + '\n');
    await assert.rejects(runCli(saveArgs(f)), /在预览后已变化/);
    await assert.rejects(access(path.join(f.root, '.workgraph')), { code: 'ENOENT' });
    await writeFile(filename, bytes);
  }
  await writeFile(f.receipt, JSON.stringify({ ...preview, version: 2 }));
  await assert.rejects(runCli(saveArgs(f)), /更新预览格式无效/);
  await assert.rejects(access(path.join(f.root, '.workgraph')), { code: 'ENOENT' });
  await writeFile(f.receipt, ' '.repeat(64 * 1024 + 1));
  await assert.rejects(runCli(saveArgs(f)), /64 KiB/);
  const directoryReceipt = saveArgs(f).slice(0, -1).concat(f.base);
  await assert.rejects(runCli(directoryReceipt), /普通 JSON 文件/);
  await assert.rejects(access(path.join(f.root, '.workgraph')), { code: 'ENOENT' });
  await writeFile(f.receipt, JSON.stringify(preview));
  assert.equal((await runCli(saveArgs(f))).state, 'saved');
  assert.equal(JSON.parse(await readFile(path.join(f.root, '.workgraph/state.json'), 'utf8')).works[0].id, 'WG-A');
});

test('matching preview still rejects a stale context without replacing the last map', async () => {
  const f = await fixture();
  await mkdir(f.root);
  await git(f.root, ['init', '-b', 'main']);
  await saveWorkMap(f.root, await prepareWorkMap(f.root), { version: 1, works: [work('WG-A')] });
  const filename = path.join(f.root, '.workgraph/state.json');
  const before = await readFile(filename);
  await inputs(f, await prepareWorkMap(f.root), { version: 1, works: [work('WG-A', [], { next: 'planned' })] });
  await writeFile(f.receipt, JSON.stringify(await runCli(previewArgs(f))));
  await writeFile(path.join(f.root, 'new.txt'), 'changed after context collection');
  await assert.rejects(runCli(saveArgs(f)), /仓库或工作记录已变化/);
  assert.deepEqual(await readFile(filename), before);
});
