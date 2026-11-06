import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink, readdir, symlink, utimes } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from '../src/git.mjs';
import { readPreferences, savePreferences } from '../src/preferences.mjs';
import { withFileLock } from '../src/file-lock.mjs';

async function fixture() {
  const root = path.resolve('.test-output/preferences-process-' + randomUUID());
  await mkdir(root, { recursive: true });
  await git(root, ['init', '-b', 'main']);
  return { root, lock: path.join(root, '.git/workgraph-state.lock') };
}

async function worker(t, mode, root, prefix = '') {
  const child = fork(new URL('./helpers/preferences-worker.mjs', import.meta.url), [mode, root, prefix], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const first = await once(child, 'message');
  assert.notEqual(first[0].state, 'error', first[0].error || stderr);
  return { child, exited, first: first[0], stderr: () => stderr };
}

test('two real service processes preserve all independent review writes', { timeout: 20000 }, async t => {
  const f = await fixture();
  await savePreferences(f.root, { config: { dateFormat: 'full' } });
  const [a, b] = await Promise.all([worker(t, 'save', f.root, '1'), worker(t, 'save', f.root, '2')]);
  for (const w of [a, b]) { assert.equal(w.first.state, 'ready'); w.child.send('start'); }
  for (const w of [a, b]) { const [code] = await w.exited; assert.equal(code, 0, w.stderr()); }
  const data = await readPreferences(f.root);
  assert.equal(data.config.dateFormat, 'full');
  assert.equal(Object.keys(data.reviews).length, 30);
  for (const prefix of [1, 2]) for (let i = 0; i < 15; i++) {
    const key = `root:${(prefix * 100 + i).toString(16).padStart(40, '0')}`;
    assert.deepEqual(data.reviews[key].files, [`worker-${prefix}-${i}.txt`]);
  }
  assert.equal((await readdir(path.dirname(f.lock))).some(name => name.startsWith('workgraph-state.lock')), false);
});

test('a waiting writer proceeds only after another process releases its lease', { timeout: 10000 }, async t => {
  const f = await fixture(), holder = await worker(t, 'hold', f.root);
  assert.equal(holder.first.state, 'locked');
  assert.deepEqual(await readPreferences(f.root), { config: {}, reviews: {} });
  let finished = false;
  const saving = savePreferences(f.root, { config: { autoLoad: true } }).then(() => { finished = true; });
  saving.catch(() => {});
  // A live owner must not be stolen merely because the timestamp is old.
  await utimes(f.lock, new Date(0), new Date(0));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(finished, false);
  holder.child.send('release');
  await saving;
  assert.equal((await readPreferences(f.root)).config.autoLoad, true);
});

test('crashed owner fails closed until explicit offline lock removal', { timeout: 10000 }, async t => {
  const f = await fixture(), holder = await worker(t, 'hold', f.root);
  assert.equal(holder.first.state, 'locked');
  const owner = await readFile(f.lock, 'utf8');
  holder.child.kill('SIGKILL'); await holder.exited;
  await assert.rejects(withFileLock(f.lock, () => assert.fail('must not acquire stale lease'), { timeoutMs: 80, retryMs: 10 }), /等待超时.*停止.*所有 WorkGraph/);
  assert.equal(await readFile(f.lock, 'utf8'), owner);
  // Simulate the documented operator action, after the owner has actually exited.
  await unlink(f.lock);
  await savePreferences(f.root, { config: { fileTree: true } });
  assert.equal((await readPreferences(f.root)).config.fileTree, true);
});

test('invalid locks fail closed and release does not remove a substituted successor', async t => {
  const f = await fixture();
  for (const content of ['', '{bad json']) {
    await writeFile(f.lock, content);
    await assert.rejects(withFileLock(f.lock, () => assert.fail('must not acquire invalid lease'), { timeoutMs: 0 }), /等待超时/);
    assert.equal(await readFile(f.lock, 'utf8'), content);
    await unlink(f.lock);
  }
  await withFileLock(f.lock, async () => {
    await unlink(f.lock);
    await writeFile(f.lock, 'successor');
  });
  assert.equal(await readFile(f.lock, 'utf8'), 'successor');
  await unlink(f.lock);
  const external = path.join(f.root, 'external');
  await writeFile(external, 'external');
  try { await symlink(external, f.lock, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Symlink creation unavailable on this host.'); return; } throw error; }
  await assert.rejects(withFileLock(f.lock, () => assert.fail('must not follow symlink'), { timeoutMs: 0 }), /符号链接/);
  assert.equal(await readFile(external, 'utf8'), 'external');
});

test('task failures release the lease and leave no temporary owner files', async () => {
  const f = await fixture();
  await assert.rejects(withFileLock(f.lock, () => { throw new Error('test failure'); }), /test failure/);
  assert.equal((await readdir(path.dirname(f.lock))).some(name => name.startsWith('workgraph-state.lock')), false);
  await savePreferences(f.root, { config: { autoLoad: false } });
});
