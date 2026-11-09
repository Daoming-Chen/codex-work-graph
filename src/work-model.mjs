import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateWorkManifest, loadWorkRecord } from './work-graph.mjs';

// This contract is independent of the local version:1 file format.
const text = z.string().min(1).max(1000).refine(v => !!v.trim());
const id = z.string().regex(/^[A-Z][A-Z0-9-]{0,39}$/).refine(v => v !== 'UNASSIGNED');
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const time = z.string().datetime().refine(v => new Date(v).toISOString() === v.replace(/Z$/, v.includes('.') ? 'Z' : '.000Z'));
const repository = z.object({ id: text, provider: z.enum(['local', 'github']), providerId: text.optional(), locators: z.array(text).max(20) }).strict()
  .refine(v => v.provider !== 'github' || !!v.providerId, 'GitHub repository requires providerId');
const source = z.object({ id: text, kind: z.enum(['legacy', 'human', 'git', 'platform', 'agent']), object: text, revision: text, observedAt: time }).strict();
const verification = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.enum(['passed', 'failed']), sha, scope: text, evidence: text }).strict(),
]);
const integration = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.enum(['pending', 'partial', 'integrated', 'needs-review']), target: text, sha, evidence: text }).strict(),
]);
const acceptance = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unknown') }).strict(),
  z.object({ state: z.enum(['accepted', 'rejected']), actor: text, criteria: text, evidence: text }).strict(),
]);
const observation = z.object({
  sourceId: text, title: z.string().min(1).max(160).refine(v => !!v.trim()), parentId: id.optional(), kind: z.enum(['work', 'outcome']),
  progress: z.enum(['not-started', 'in-progress', 'blocked', 'paused', 'implemented']),
  summary: z.string().max(1000), next: z.string().max(1000), outcomes: z.array(text).max(20), issues: z.array(text).max(20),
  verification, integration, acceptance,
  associations: z.array(z.object({ kind: z.enum(['commit', 'branch', 'pr', 'issue']), object: text, basis: z.enum(['explicit', 'inferred']) }).strict()).max(1000),
}).strict();
const work = z.object({ id, observations: z.array(observation).min(1).max(100) }).strict();
const schema = z.object({
  format: z.literal('workgraph.snapshot'), schemaVersion: z.literal(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  repository, sources: z.array(source).max(1000), works: z.array(work).max(10000),
  coverage: z.object({ scope: text, observedAt: time, complete: z.boolean(), gaps: z.array(text).max(100) }).strict(),
  legacy: z.object({ sourceId: text, manifest: z.unknown() }).strict().optional(),
}).strict();

const progress = { '待开始': 'not-started', '进行中': 'in-progress', '已搁置': 'paused', '已完成': 'implemented' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));

function legacyWorks(manifest, sourceId) {
  return validateWorkManifest(manifest).map(w => ({ id: w.id, observations: [{
    sourceId, title: w.title, ...(w.parentId ? { parentId: w.parentId } : {}), kind: w.kind,
    progress: progress[w.status], summary: w.summary, next: w.next, outcomes: w.outcomes, issues: w.issues,
    verification: { state: 'unknown' }, integration: { state: 'unknown' }, acceptance: { state: 'unknown' },
    associations: w.commits.map(object => ({ kind: 'commit', object, basis: 'explicit' })),
  }] }));
}

export function validateWorkSnapshot(input) {
  const snapshot = schema.parse(input);
  const sources = new Map(snapshot.sources.map(s => [s.id, s]));
  const works = new Map(snapshot.works.map(w => [w.id, w]));
  if (sources.size !== snapshot.sources.length || works.size !== snapshot.works.length) throw new Error('Duplicate source or work ID');
  for (const w of snapshot.works) {
    const seen = new Set();
    for (const o of w.observations) {
      if (!sources.has(o.sourceId) || seen.has(o.sourceId)) throw new Error('Unknown or duplicate observation source');
      seen.add(o.sourceId);
      if (o.acceptance.state !== 'unknown' && sources.get(o.sourceId).kind !== 'human') throw new Error('Acceptance requires a human source');
      const visited = new Set([w.id]); let current = o;
      while (current.parentId) {
        if (visited.has(current.parentId)) throw new Error('Work hierarchy contains a cycle');
        visited.add(current.parentId);
        current = works.get(current.parentId)?.observations.find(v => v.sourceId === o.sourceId);
        if (!current) throw new Error('Missing parent in observation source');
        if (visited.size > 3) throw new Error('Work hierarchy exceeds three levels');
      }
    }
  }
  if (snapshot.legacy) {
    const { sourceId, manifest } = snapshot.legacy;
    if (sources.get(sourceId)?.kind !== 'legacy') throw new Error('Invalid legacy source');
    if (sources.get(sourceId).revision !== createHash('sha256').update(json(manifest)).digest('hex')) throw new Error('Legacy revision mismatch');
    const expected = legacyWorks(manifest, sourceId);
    const actual = snapshot.works.filter(w => w.observations.some(o => o.sourceId === sourceId))
      .map(w => ({ id: w.id, observations: w.observations.filter(o => o.sourceId === sourceId) }));
    if (json(expected) !== json(actual)) throw new Error('Legacy projection was modified');
  }
  return structuredClone(snapshot);
}

export function serializeWorkSnapshot(snapshot) { return JSON.stringify(validateWorkSnapshot(snapshot), null, 2) + '\n'; }
export function parseWorkSnapshot(serialized) { return validateWorkSnapshot(JSON.parse(serialized)); }

// Caller supplies persisted repository identity; paths and remote URLs are only locators.
export function importLegacyWorkRecord(manifest, { repository, sourceId, object, observedAt, scope }) {
  const copy = JSON.parse(JSON.stringify(manifest));
  const works = legacyWorks(copy, sourceId);
  return validateWorkSnapshot({ format: 'workgraph.snapshot', schemaVersion: 1, revision: 0, repository,
    sources: [{ id: sourceId, kind: 'legacy', object, revision: createHash('sha256').update(json(copy)).digest('hex'), observedAt }],
    works, coverage: { scope, observedAt, complete: false, gaps: ['Legacy record only; repository branches and verification were not collected.'] },
    legacy: { sourceId, manifest: copy },
  });
}

// Explicit extraction, not a downgrade: common-model observations cannot be written to v1 losslessly.
export function exportLegacyWorkRecord(input) {
  const snapshot = validateWorkSnapshot(input);
  if (!snapshot.legacy) throw new Error('No legacy record');
  if (snapshot.sources.length !== 1 || snapshot.works.some(w => w.observations.some(o => o.sourceId !== snapshot.legacy.sourceId))) {
    throw new Error('Cannot downgrade additional sources to legacy format');
  }
  return structuredClone(snapshot.legacy.manifest);
}

export async function loadCommonWorkRecord(root, options) {
  const record = await loadWorkRecord(root);
  return importLegacyWorkRecord(record.manifest, { ...options, object: record.source });
}

// Pure compare-and-swap contract. Storage must perform the version check and write atomically.
// actorKind must come from the authenticated caller, never from the submitted payload.
export function applyWorkObservations(input, update, { actorKind }) {
  const current = validateWorkSnapshot(input);
  const request = z.object({ expectedRevision: z.number().int().nonnegative(), source,
    works: z.array(z.object({ id, observation }).strict()).max(10000) }).strict().parse(update);
  if (request.expectedRevision !== current.revision) throw new Error('Stale snapshot revision');
  if (!['human', 'git', 'platform', 'agent'].includes(actorKind) || request.source.kind !== actorKind) throw new Error('Source actor mismatch');
  const prior = current.sources.find(s => s.id === request.source.id);
  if (prior && (prior.kind !== actorKind || prior.object !== request.source.object)) throw new Error('Source identity cannot be reassigned');
  const ids = new Set();
  for (const entry of request.works) {
    if (ids.has(entry.id) || entry.observation.sourceId !== request.source.id) throw new Error('Duplicate work ID or mismatched source');
    ids.add(entry.id);
  }
  if (prior?.revision === request.source.revision) {
    const existing = current.works.flatMap(w => w.observations.filter(o => o.sourceId === prior.id).map(observation => ({ id: w.id, observation })));
    const ordered = entries => [...entries].sort((a, b) => a.id.localeCompare(b.id));
    if (json(prior) === json(request.source) && json(ordered(existing)) === json(ordered(request.works))) return current;
    throw new Error('Source revision reused with different content');
  }
  // A source revision describes its complete contribution, including removed observations.
  const next = structuredClone(current);
  next.sources = next.sources.filter(s => s.id !== request.source.id).concat(request.source);
  next.works = next.works.map(w => ({ ...w, observations: w.observations.filter(o => o.sourceId !== request.source.id) }));
  for (const entry of request.works) {
    let w = next.works.find(w => w.id === entry.id);
    if (!w) { w = { id: entry.id, observations: [] }; next.works.push(w); }
    w.observations.push(entry.observation);
  }
  next.works = next.works.filter(w => w.observations.length);
  next.revision++;
  return validateWorkSnapshot(next);
}

// No last-writer-wins projection: consumers receive the conflicting fields and all sources.
export function workConflicts(input) {
  const snapshot = validateWorkSnapshot(input);
  return snapshot.works.flatMap(w => {
    const fields = Object.keys(w.observations[0]).filter(key => key !== 'sourceId' && new Set(w.observations.map(o => json(o[key] ?? null))).size > 1);
    return fields.length ? [{ workId: w.id, sourceIds: w.observations.map(o => o.sourceId), fields }] : [];
  });
}
