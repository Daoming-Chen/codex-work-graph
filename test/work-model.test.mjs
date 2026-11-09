import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { importLegacyWorkRecord, exportLegacyWorkRecord, validateWorkSnapshot, serializeWorkSnapshot, parseWorkSnapshot,
  applyWorkObservations, workConflicts, loadCommonWorkRecord } from '../src/work-model.mjs';
import { readWorkGraph } from '../src/work-graph.mjs';
import { git } from '../src/git.mjs';

const options = { repository: { id: 'repo-1', provider: 'local', locators: ['D:/repo'] }, sourceId: 'local-record', object: '.workgraph/state.json', observedAt: '2026-11-09T02:00:00Z', scope: 'current worktree record' };
const manifest = () => ({ version: 1, works: [
  { id: 'PARENT', title: '目标', status: '进行中', commits: [], next: '核对' },
  { id: 'CHILD', title: '成果', parentId: 'PARENT', kind: 'outcome', status: '已完成', commits: ['a'.repeat(40)], updatedAt: '2026-11-09T01:00:00Z', outcomes: ['已实现'], issues: ['尚未验收'] },
], analysis: { head: 'a'.repeat(40), branch: 'feature', custom: ['preserve'] }, automation: { enabled: false }, extension: { preserved: true } });
const snapshot = () => importLegacyWorkRecord(manifest(), options);
function update(s, kind = 'agent', sourceId = 'agent-1') {
  return { expectedRevision: s.revision, source: { id: sourceId, kind, object: 'analysis-1', revision: 'r1', observedAt: options.observedAt },
    works: [{ id: 'PARENT', observation: { ...structuredClone(s.works[0].observations[0]), sourceId, title: '新目标' } }] };
}

test('legacy JSON roundtrip preserves optional fields, metadata and original completed meaning', () => {
  const original = manifest(), s = importLegacyWorkRecord(original, options);
  assert.deepEqual(exportLegacyWorkRecord(parseWorkSnapshot(serializeWorkSnapshot(s))), original);
  const o = s.works[1].observations[0];
  assert.equal(o.progress, 'implemented');
  for (const key of ['verification', 'integration', 'acceptance']) assert.deepEqual(o[key], { state: 'unknown' });
  assert.equal(s.coverage.complete, false);
  s.legacy.manifest.analysis.custom.push('changed');
  assert.deepEqual(original.analysis.custom, ['preserve']);
  for (const status of ['待开始', '进行中', '已搁置', '已完成']) {
    const m = { version: 1, works: [{ id: 'A', title: 'A', status, commits: [] }] };
    assert.deepEqual(exportLegacyWorkRecord(importLegacyWorkRecord(m, options)), m);
  }
  assert.deepEqual(exportLegacyWorkRecord(importLegacyWorkRecord({ version: 1, works: [] }, options)), { version: 1, works: [] });
  const whitespace = manifest(); whitespace.works[1].outcomes = ['  preserve surrounding whitespace  '];
  assert.deepEqual(exportLegacyWorkRecord(importLegacyWorkRecord(whitespace, options)), whitespace);
});

test('strict versioning, duplicate identities, source integrity and hierarchy are enforced', () => {
  for (const mutate of [
    s => s.schemaVersion = 2, s => s.unknown = true,
    s => s.works.push(structuredClone(s.works[0])),
    s => s.sources.push(structuredClone(s.sources[0])),
    s => s.works[0].observations[0].sourceId = 'missing',
    s => s.works[0].observations.push(structuredClone(s.works[0].observations[0])),
    s => s.works[0].observations[0].parentId = 'CHILD',
    s => s.works[1].observations[0].parentId = 'MISSING',
    s => s.works[0].observations[0].progress = 'accepted',
    s => s.works[0].observations[0].verification = { state: 'passed' },
    s => s.repository = { id: 'github:1', provider: 'github', locators: [] },
    s => s.sources[0].observedAt = '2026-02-30T00:00:00Z',
    s => s.works[0].observations[0].title = 'silent downgrade',
  ]) { const s = snapshot(); mutate(s); assert.throws(() => validateWorkSnapshot(s)); }
  assert.throws(() => importLegacyWorkRecord({ version: 2, works: [] }, options));
  const m = manifest(); m.works.push({ ...m.works[0] }); assert.throws(() => importLegacyWorkRecord(m, options));
});

test('updates preserve other sources, expose differences, reject stale results and lossy downgrade', () => {
  const original = snapshot();
  const next = applyWorkObservations(original, update(original), { actorKind: 'agent' });
  assert.equal(original.revision, 0); assert.equal(next.revision, 1);
  assert.equal(next.works[0].observations.length, 2);
  assert.deepEqual(workConflicts(next), [{ workId: 'PARENT', sourceIds: ['local-record', 'agent-1'], fields: ['title'] }]);
  assert.deepEqual(parseWorkSnapshot(serializeWorkSnapshot(next)), next);
  assert.throws(() => exportLegacyWorkRecord(next), /downgrade/);
  assert.throws(() => applyWorkObservations(next, update(original), { actorKind: 'agent' }), /Stale/);
  const duplicate = update(next); duplicate.works.push(duplicate.works[0]);
  assert.throws(() => applyWorkObservations(next, duplicate, { actorKind: 'agent' }), /Duplicate/);
  const replay = update(next);
  assert.deepEqual(applyWorkObservations(next, replay, { actorKind: 'agent' }), next);
  replay.works[0].observation.title = 'same revision, different content';
  assert.throws(() => applyWorkObservations(next, replay, { actorKind: 'agent' }), /revision reused/);
  replay.source.revision = 'r2';
  assert.equal(applyWorkObservations(next, replay, { actorKind: 'agent' }).revision, 2);
});

test('agent cannot rewrite human assertions or invent acceptance; evidence requires version and target', () => {
  const s = snapshot(), human = update(s, 'human', 'person-1');
  human.works[0].observation.acceptance = { state: 'accepted', actor: 'reviewer', criteria: '目标满足', evidence: 'review:123' };
  const confirmed = applyWorkObservations(s, human, { actorKind: 'human' });
  assert.throws(() => applyWorkObservations(s, human, { actorKind: 'agent' }), /actor/);
  assert.throws(() => applyWorkObservations(confirmed, update(confirmed, 'agent', 'person-1'), { actorKind: 'agent' }), /identity/);
  const agent = update(confirmed);
  agent.works[0].observation.acceptance = human.works[0].observation.acceptance;
  assert.throws(() => applyWorkObservations(confirmed, agent, { actorKind: 'agent' }), /human/);
  const good = update(confirmed);
  good.works[0].observation.verification = { state: 'passed', sha: 'b'.repeat(40), scope: 'unit', evidence: 'run:1' };
  good.works[0].observation.integration = { state: 'integrated', target: 'refs/heads/main', sha: 'b'.repeat(40), evidence: 'pr:1' };
  const result = applyWorkObservations(confirmed, good, { actorKind: 'agent' });
  assert.deepEqual(result.works[0].observations.find(o => o.sourceId === 'person-1').acceptance, human.works[0].observation.acceptance);
  delete good.works[0].observation.integration.target;
  assert.throws(() => applyWorkObservations(confirmed, good, { actorKind: 'agent' }));
});

test('both local record locations remain readable and adapter never modifies files', async () => {
  await mkdir('.test-output', { recursive: true });
  const root = await mkdtemp(path.resolve('.test-output/common-model-'));
  await git(root, ['init', '-b', 'main']);
  const oldFile = path.join(root, '.workgraph.json'), raw = JSON.stringify(manifest());
  await writeFile(oldFile, raw);
  const old = await loadCommonWorkRecord(root, options);
  assert.deepEqual(exportLegacyWorkRecord(old), manifest());
  assert.equal((await readWorkGraph(root)).works[1].status, '已完成');
  assert.equal(await readFile(oldFile, 'utf8'), raw);
  await mkdir(path.join(root, '.workgraph'));
  const file = path.join(root, '.workgraph/state.json');
  const changed = manifest(); changed.works[0].title = '新记录';
  await writeFile(file, JSON.stringify(changed));
  assert.deepEqual(exportLegacyWorkRecord(await loadCommonWorkRecord(root, options)), changed);
  assert.equal((await readWorkGraph(root)).works[0].title, '新记录');
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(changed));
  await writeFile(file, '{broken');
  await assert.rejects(() => loadCommonWorkRecord(root, options));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
