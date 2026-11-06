import { realpath, lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, resolveRepository } from './git.mjs';
import { withFileLock } from './file-lock.mjs';

const filename = 'workgraph-state.json';
const maxBytes = 1024 * 1024;
const retention = 90 * 24 * 60 * 60 * 1000;
const maxReviews = 2000, maxFiles = 5000;
const queues = new Map();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const reviewKey = /^(?:root|[a-f0-9]{40}|[a-f0-9]{64}):(?:root|[a-f0-9]{40}|[a-f0-9]{64})$/;
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label}必须为对象。`);
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label}包含未知字段。`);
}
function config(value) {
  object(value, ['issueUrl', 'prUrl', 'dateFormat', 'autoLoad', 'fileTree', 'columnWidths'], '仓库配置');
  const result = {};
  for (const key of ['issueUrl', 'prUrl']) if (own(value, key)) {
    if (typeof value[key] !== 'string' || value[key].length > 8192 || /[\0\r\n]/.test(value[key])) throw new Error('链接模板必须为有效字符串。');
    if (value[key]) {
      let url;
      try { url = new URL(value[key].replaceAll('{id}', '1').replaceAll('{branch}', 'main')); } catch { throw new Error('链接模板必须为 HTTP 或 HTTPS URL。'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('链接模板仅支持 HTTP 或 HTTPS。');
    }
    result[key] = value[key];
  }
  if (own(value, 'dateFormat')) {
    if (!['short', 'full', 'relative'].includes(value.dateFormat)) throw new Error('日期格式无效。');
    result.dateFormat = value.dateFormat;
  }
  for (const key of ['autoLoad', 'fileTree']) if (own(value, key)) {
    if (typeof value[key] !== 'boolean') throw new Error(`${key} 必须为布尔值。`);
    result[key] = value[key];
  }
  if (own(value, 'columnWidths')) {
    object(value.columnWidths, ['author', 'date', 'sha'], '列宽');
    result.columnWidths = {};
    for (const [key, width] of Object.entries(value.columnWidths)) {
      if (!Number.isFinite(width) || width < 40 || width > 1000) throw new Error('列宽必须在 40–1000 像素之间。');
      result.columnWidths[key] = width;
    }
  }
  return result;
}
function review(value, timestamp, stored = false) {
  object(value, stored ? ['active', 'files', 'updatedAt'] : ['key', 'active', 'files'], '审阅记录');
  if (typeof value.active !== 'boolean' || !Array.isArray(value.files) || value.files.length > maxFiles || value.files.some(file => typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0'))) throw new Error('审阅状态或文件列表无效。');
  if (stored && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > timestamp + 24 * 60 * 60 * 1000)) throw new Error('审阅更新时间无效。');
  return { active: value.active, files: [...new Set(value.files)], updatedAt: stored ? value.updatedAt : timestamp };
}
function state(value, timestamp) {
  object(value, ['config', 'reviews'], '仓库存储');
  const result = { config: config(value.config), reviews: {} };
  object(value.reviews, null, '审阅集合');
  if (Object.keys(value.reviews).length > maxReviews) throw new Error('审阅记录过多。');
  for (const [key, item] of Object.entries(value.reviews)) {
    if (!reviewKey.test(key)) throw new Error('审阅比较键无效。');
    const normalized = review(item, timestamp, true);
    if (normalized.updatedAt >= timestamp - retention) result.reviews[key] = normalized;
  }
  return result;
}
async function storage(repository) {
  const { root } = await resolveRepository(repository);
  const directory = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  return { directory, target: path.join(directory, filename) };
}
async function checkedStat(target) {
  const stat = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('仓库存储必须是普通文件，不能使用符号链接。');
  if (stat?.size > maxBytes) throw new Error('仓库存储超过 1 MiB。');
  return stat;
}
async function read(target, timestamp) {
  if (!await checkedStat(target)) return { config: {}, reviews: {} };
  const bytes = await readFile(target);
  if (bytes.length > maxBytes) throw new Error('仓库存储超过 1 MiB。');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('仓库存储 JSON 无效，未覆盖现有数据。'); }
  return state(parsed, timestamp);
}
async function serial(directory, fn) {
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const promise = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, promise);
  try { return await promise; } finally { if (queues.get(key) === promise) queues.delete(key); }
}

export async function readPreferences(repository) {
  const { directory, target } = await storage(repository);
  return serial(directory, () => read(target, Date.now()));
}

export async function savePreferences(repository, input) {
  object(input, ['config', 'review'], '保存请求');
  if (!own(input, 'config') && !own(input, 'review')) throw new Error('请选择要保存的配置或审阅记录。');
  // Clone and validate before entering the queue; callers cannot mutate a queued request.
  const nextConfig = own(input, 'config') ? config(input.config) : undefined;
  let nextReview;
  if (own(input, 'review')) {
    if (!reviewKey.test(input.review?.key || '')) throw new Error('审阅比较键无效。');
    nextReview = { key: input.review.key, ...review(input.review, Date.now()) };
  }
  const { directory, target } = await storage(repository);
  return serial(directory, () => withFileLock(path.join(directory, 'workgraph-state.lock'), async () => {
    const timestamp = Date.now(), data = await read(target, timestamp);
    if (nextConfig) data.config = nextConfig;
    if (nextReview) data.reviews[nextReview.key] = { active: nextReview.active, files: nextReview.files, updatedAt: timestamp };
    if (Object.keys(data.reviews).length > maxReviews) throw new Error('审阅记录过多，请先清理旧记录。');
    const content = JSON.stringify(data, null, 2) + '\n';
    if (Buffer.byteLength(content) > maxBytes) throw new Error('仓库存储超过 1 MiB。');
    const temporary = path.join(directory, `${filename}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await checkedStat(target);
      await rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return data;
  }));
}
