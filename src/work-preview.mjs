import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mergeAnalysisResult } from './work-analysis.mjs';
import { validateWorkManifest } from './work-graph.mjs';

const maxInputBytes = 4 * 1024 * 1024;
const maxPreviewBytes = 64 * 1024;
const previewFileOverhead = 5; // A UTF-8 BOM and CRLF when saving CLI output.
const maxCommitChanges = 100;
const maxDetailItems = 20;
const maxDetailCharacters = 120;
const detailFields = new Set(['title', 'status', 'next', 'summary', 'parentId', 'kind']);
const digestPattern = /^[a-f0-9]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function readMapInput(filename, label, maxBytes = maxInputBytes) {
  const limit = maxBytes === maxInputBytes ? '4 MiB' : '64 KiB';
  const invalidFile = () => new Error(`${label}必须是大小不超过 ${limit} 的普通 JSON 文件。`);
  const before = await lstat(filename);
  if (!before.isFile() || before.size > maxBytes) throw invalidFile();

  // Validate and read through one descriptor. Do not follow a substituted link
  // or block opening a substituted pipe on platforms with these flags.
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > maxBytes || current.dev !== before.dev || current.ino !== before.ino) throw invalidFile();
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw invalidFile();
    const bytes = buffer.subarray(0, length);
    let value;
    try {
      value = JSON.parse(utf8.decode(bytes));
    } catch {
      throw new Error(`${label}必须包含有效的 UTF-8 JSON。`);
    }
    return { value, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}

function owners(works) {
  const result = new Map();
  for (const { id, commits } of works) {
    if (typeof id !== 'string') throw new Error('工作项标识必须是字符串。');
    for (const commit of commits) {
      if (typeof commit !== 'string') throw new Error('提交关联必须是 SHA 字符串。');
      result.set(commit, id);
    }
  }
  return result;
}

function ownershipChanges(before, after) {
  const changes = [];
  let total = 0;
  function add(commit, from, to) {
    total++;
    if (changes.length < maxCommitChanges) changes.push({ commit, from, to });
  }
  for (const [commit, from] of before) {
    const to = after.get(commit) ?? null;
    if (from !== to) add(commit, from, to);
  }
  for (const [commit, to] of after) {
    if (!before.has(commit)) add(commit, null, to);
  }
  return { total, omitted: total - changes.length, changes };
}

function textPreview(value) {
  if (value === undefined) return null;
  const characters = Array.from(value);
  return { text: characters.slice(0, maxDetailCharacters).join(''), truncated: characters.length > maxDetailCharacters };
}

function addDetails(preview, details) {
  const detailBudget = Math.floor((maxPreviewBytes - Buffer.byteLength(JSON.stringify(preview)) - previewFileOverhead) / 2);
  for (const kind of ['added', 'changed']) {
    let remaining = detailBudget;
    for (const item of details[kind].slice(0, maxDetailItems)) {
      // Reserve one byte for a possible comma. Omitted counts only decrease.
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (bytes > remaining) break;
      preview.details[kind].push(item);
      preview.details.omitted[kind]--;
      remaining -= bytes;
    }
  }
}

export function previewMapUpdate(contextInput, candidateInput) {
  const packet = contextInput.value;
  const candidate = candidateInput.value;
  if (packet?.version !== 1 || typeof packet.root !== 'string' || !packet.root ||
      !['initialize', 'update'].includes(packet.mode) || typeof packet.baseline?.fingerprint !== 'string' ||
      !digestPattern.test(packet.baseline.fingerprint) ||
      !packet.context || typeof packet.context !== 'object' || Array.isArray(packet.context)) {
    throw new Error('分析材料格式无效。请使用 context 生成的材料。');
  }
  if (candidate?.version !== 1 || !Array.isArray(candidate.works) || candidate.works.length > 100) {
    throw new Error('候选工作记录格式无效。');
  }

  validateWorkManifest(packet.previous);
  const works = mergeAnalysisResult(packet.previous, candidate, packet.mode);
  validateWorkManifest({ version: candidate.version, works });
  const oldOwners = owners(packet.previous.works);
  const newOwners = owners(works);
  const oldWorks = new Map(packet.previous.works.map(work => [work.id, work]));
  const nextIds = new Set(works.map(work => work.id));
  if ([...oldWorks.keys()].some(id => !nextIds.has(id))) {
    throw new Error('分析结果丢失已有工作项。请保留原有标识。');
  }

  const added = [], changed = [], unchanged = [];
  const details = { added: [], changed: [] };
  for (const work of works) {
    const old = oldWorks.get(work.id);
    if (!old) {
      added.push(work.id);
      details.added.push({ id: work.id, title: textPreview(work.title), status: work.status, next: textPreview(work.next) });
      continue;
    }
    const fields = [...new Set([...Object.keys(old), ...Object.keys(work)])].filter(
      key => key !== 'updatedAt' && JSON.stringify(old[key]) !== JSON.stringify(work[key]),
    ).sort();
    if (!fields.length) {
      unchanged.push(work.id);
      continue;
    }
    changed.push({ id: work.id, fields });
    details.changed.push({
      id: work.id,
      values: Object.fromEntries(fields.filter(key => detailFields.has(key)).map(key => [
        key, { from: textPreview(old[key]), to: textPreview(work[key]) },
      ])),
      omittedFields: fields.filter(key => !detailFields.has(key)),
    });
  }

  const scope = ['incremental', 'focused-map', 'initial-map'].includes(packet.context.scope)
    ? packet.context.scope : 'unknown';
  const preview = {
    version: 1,
    state: 'preview',
    mode: packet.mode,
    scope,
    contextDigest: contextInput.digest,
    candidateDigest: candidateInput.digest,
    added,
    changed,
    unchanged,
    explicitCommitOwnership: ownershipChanges(oldOwners, newOwners),
    details: { added: [], changed: [], omitted: { added: added.length, changed: changed.length } },
    limits: [
      '仅比较材料中的旧记录与合并后的候选，未核对实时仓库。收集的材料可能有遗漏或截断。',
      '仅比较显式提交 SHA 关联。未解析 Work-Item 标记或核验提交是否存在。',
      '详情仅展示部分字段和值的短文本。保存还会核对实时基线、记录和大小上限。',
    ],
  };
  addDetails(preview, details);
  if (Buffer.byteLength(JSON.stringify(preview)) + previewFileOverhead > maxPreviewBytes) throw new Error('更新预览超过 64 KiB。');
  return preview;
}

export async function verifyMapPreview(filename, contextInput, candidateInput) {
  const { value: preview } = await readMapInput(filename, '更新预览', maxPreviewBytes);
  if (preview?.version !== 1 || preview.state !== 'preview' ||
      typeof preview.contextDigest !== 'string' || !digestPattern.test(preview.contextDigest) ||
      typeof preview.candidateDigest !== 'string' || !digestPattern.test(preview.candidateDigest)) {
    throw new Error('更新预览格式无效。请重新运行 preview。');
  }
  if (preview.contextDigest !== contextInput.digest || preview.candidateDigest !== candidateInput.digest) {
    throw new Error('分析材料或候选文件在预览后已变化。请重新生成并核对预览。');
  }
}
