import { test as base, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../../src/git.mjs';
import { startHttp } from '../../src/http.mjs';

const test = base.extend({
  workMap: async ({}, use) => {
    const output = path.resolve('.test-output');
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(path.join(output, 'browser-'));
    const root = path.join(directory, 'repository 中文 with spaces');
    let panel;
    try {
      await mkdir(root);
      await git(root, ['init', '-b', 'main']);
      await git(root, ['config', 'user.name', 'Browser Fixture']);
      await git(root, ['config', 'user.email', 'browser@example.test']);
      await writeFile(path.join(root, 'feature.txt'), 'browser evidence\n');
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'Add browser evidence']);
      const hash = (await git(root, ['rev-parse', 'HEAD'])).trim();
      const record = { version: 1, works: [
        { id: 'PARENT', title: '发布准备', status: '进行中', commits: [], summary: '父级进展', next: '核对发布产物' },
        { id: 'CHILD', parentId: 'PARENT', title: '浏览器验证', status: '已完成', commits: [hash], summary: '已验证真实页面交互', outcomes: ['浏览器可查看代码依据'] },
        { id: 'OTHER', title: '安装文档', status: '待开始', commits: [], summary: '另一项工作' },
      ] };
      await mkdir(path.join(root, '.workgraph'));
      const writeRecord = async value => writeFile(path.join(root, '.workgraph/state.json'), JSON.stringify(value));
      await writeRecord(record);
      const html = await readFile(new URL('../../skills/workgraph/scripts/graph.html', import.meta.url), 'utf8');
      // Real HTTP + real Git; the standalone entry has no model/write routes.
      panel = await startHttp({ repositoryPath: root, html, workMapOnly: true });
      await use({ ...panel, root, record, writeRecord });
    } finally {
      await panel?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function open(page, workMap) {
  await page.goto(workMap.url);
  await expect(page.getByRole('heading', { name: '工作进展' })).toBeVisible();
  await expect(page.locator('[data-record="PARENT"]')).toBeVisible();
}

// Browser route interception delays genuine server responses to exercise races;
// response bodies in these tests still come from WorkGraph's actual HTTP API.
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('loads, expands, filters and opens a real commit diff', async ({ page, workMap }) => {
  await open(page, workMap);
  await expect(page.locator('[data-record="CHILD"]')).toHaveCount(0);
  await page.getByRole('button', { name: '展开 发布准备 的子工作与成果' }).click();
  await page.locator('[data-record="CHILD"]').click();
  await expect(page.getByRole('complementary', { name: '工作详情' })).toContainText('已验证真实页面交互');
  await page.getByRole('tab', { name: '代码依据' }).click();
  await page.getByRole('button', { name: /Add browser evidence/ }).click();
  await expect(page.locator('#work-real-patch')).toContainText('+browser evidence');
  await page.getByRole('searchbox', { name: '搜索工作与依据' }).fill('安装文档');
  await expect(page.locator('[data-record="PARENT"]')).toHaveCount(0);
  await expect(page.locator('[data-record="OTHER"]')).toBeVisible();
  await expect(page.locator('#work-detail')).toBeHidden();
});

test('retains authentication on refresh and rejects unauthenticated or write API access', async ({ page, workMap, request }) => {
  await open(page, workMap);
  const before = new URL(page.url()).hash;
  expect(before).toBe(`#token=${workMap.token}`);
  await page.reload();
  await expect(page.locator('[data-record="PARENT"]')).toBeVisible();
  expect(new URL(page.url()).hash).toBe(before);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('#work-count')).toContainText('1 个提交');
  expect((await request.get(`${workMap.origin}/api/work_graph`)).status()).toBe(401);
  expect((await request.post(`${workMap.origin}/api/prepare`, {
    headers: { Authorization: `Bearer ${workMap.token}` }, data: {},
  })).status()).toBe(404);
  await expect(page.locator('#work-mode')).toBeHidden();
  await expect(page.locator('#work-analyze')).toBeHidden();
});

test('a delayed diff cannot appear in a newly selected work item', async ({ page, workMap }) => {
  await open(page, workMap);
  await page.locator('[data-expand="PARENT"]').click();
  await page.locator('[data-record="CHILD"]').click();
  await page.getByRole('tab', { name: '代码依据' }).click();
  const held = gate(), received = gate(), delivered = gate();
  await page.route('**/api/commit?*', async route => {
    const response = await route.fetch();
    received.release();
    await held.promise;
    await route.fulfill({ response });
    delivered.release();
  });
  try {
    await page.getByRole('button', { name: /Add browser evidence/ }).click();
    await received.promise;
    await page.locator('[data-record="OTHER"]').click();
    const response = page.waitForResponse(result => result.url().includes('/api/commit?'));
    held.release();
    await delivered.promise;
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#work-detail')).toContainText('安装文档');
    await expect(page.locator('#work-detail')).toContainText('暂无明确关联的提交');
    await expect(page.locator('#work-detail')).not.toContainText('+browser evidence');
  } finally { held.release(); }
});

test('an older refresh cannot replace newer work records', async ({ page, workMap }) => {
  await open(page, workMap);
  const held = gate(), received = gate(), delivered = gate();
  let intercepted = false;
  await page.route('**/api/work_graph?*', async route => {
    if (intercepted) { await route.continue(); return; }
    intercepted = true;
    const response = await route.fetch();
    received.release();
    await held.promise;
    await route.fulfill({ response });
    delivered.release();
  });
  try {
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await received.promise;
    workMap.record.works[0].title = '发布准备：新记录';
    await workMap.writeRecord(workMap.record);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.locator('[data-record="PARENT"]')).toHaveText('发布准备：新记录');
    const response = page.waitForResponse(result => result.url().includes('/api/work_graph?'));
    held.release();
    await delivered.promise;
    await (await response).finished();
    // Flush the fulfilled response through the browser's fetch and render queue.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('[data-record="PARENT"]')).toHaveText('发布准备：新记录');
  } finally { held.release(); }
});
