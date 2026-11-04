import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { packagePlugin } from '../scripts/package.mjs';
import { git } from '../src/git.mjs';

test('portable distribution launches after relocation outside the source checkout and restarts cleanly', async t => {
  const base = path.resolve('.test-output');
  await mkdir(base, { recursive: true });
  const parent = await mkdtemp(path.join(base, 'portable-'));
  const packaged = await packagePlugin(path.join(parent, 'first location 中文'));
  const relocated = path.join(parent, 'moved plugin with spaces');
  await rename(packaged, relocated);
  await assert.rejects(access(path.join(relocated, '.mcp.json')), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(path.join(relocated, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'workgraph');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const marketplace = JSON.parse(await readFile('.agents/plugins/marketplace.json', 'utf8'));
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.extensions['com.openai'].interface.displayName, 'WorkGraph');
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source.path, './plugins/workgraph');
  assert.match(await readFile(path.join(relocated, 'skills/workgraph/SKILL.md'), 'utf8'), /`workgraph_open`/);
  await assert.rejects(access(path.join(relocated, '.codex-plugin')), { code: 'ENOENT' });
  const portable = JSON.parse(await readFile(path.join(relocated, 'mcp.json'), 'utf8'));
  assert.equal(portable.mcpServers.workgraph.command, 'node');
  assert.deepEqual(portable.mcpServers.workgraph.args, ['${PLUGIN_ROOT}/dist/server.mjs']);
  // SDK is a raw stdio client, not a plugin host. Apply only the documented
  // host placeholder here; this checks relocatability, not host installation.
  const entry = portable.mcpServers.workgraph;
  const config = { ...entry, args: entry.args.map(value => value.replaceAll('${PLUGIN_ROOT}', relocated)), cwd: entry.cwd.replaceAll('${PLUGIN_ROOT}', relocated) };
  assert.equal(config.cwd, relocated);
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: 'portable-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ ...config, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', chunk => { diagnostics += chunk; });
    t.after(() => client.close());
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'workgraph_open'), diagnostics);
    const ui = await client.readResource({ uri: 'ui://workgraph/panel.html' });
    assert.match(ui.contents[0].text, /<!doctype html>/i);
    await client.close();
  }
  // A second copy also contains no dependency on the first distribution path.
  const second = path.join(parent, 'another copy');
  await cp(relocated, second, { recursive: true });
  assert.equal(await readFile(path.join(second, 'mcp.json'), 'utf8'), await readFile(path.join(relocated, 'mcp.json'), 'utf8'));
});

test('relocated analyzer loads both packaged skills without invoking a model', async t => {
  await mkdir('.test-output', { recursive: true });
  const parent = await mkdtemp(path.resolve('.test-output/portable-analysis-'));
  const original = await packagePlugin(path.join(parent, 'original'));
  const relocated = path.join(parent, 'relocated analyzer 中文');
  await rename(original, relocated);
  const root = path.join(parent, 'repository');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  const entry = JSON.parse(await readFile(path.join(relocated, 'mcp.json'), 'utf8')).mcpServers.workgraph;
  const client = new Client({ name: 'portable-analysis-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    ...entry,
    args: entry.args.map(value => value.replaceAll('${PLUGIN_ROOT}', relocated)),
    cwd: entry.cwd.replaceAll('${PLUGIN_ROOT}', relocated),
    // Node rejects Codex's arguments. Prompt construction (and skill loading)
    // runs first, so this exercises the real bundle without model usage.
    env: { ...process.env, WORKGRAPH_CODEX_PATH: process.execPath },
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  async function analyze(mode) {
    const started = await client.callTool({ name: 'workgraph_work_analyze', arguments: { repositoryPath: root, mode } });
    assert.equal(started.isError, undefined, JSON.stringify(started));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await client.callTool({ name: 'workgraph_work_status', arguments: { repositoryPath: root } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      if (result.structuredContent.state !== 'running') return result.structuredContent;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Packaged analysis did not settle within 15 seconds.');
  }
  for (const [mode, name] of [['initialize', 'workgraph-init'], ['update', 'workgraph-update']]) {
    const skill = path.join(relocated, 'skills', name, 'SKILL.md');
    assert.match(await readFile(skill, 'utf8'), new RegExp(`name: ${name}`));
    if (mode === 'update') {
      // A saved record enables the update entry point without a model call.
      await writeFile(path.join(root, '.workgraph/state.json'), JSON.stringify({ version: 1, works: [], automation: { enabled: false } }));
    }
    await rename(skill, `${skill}.missing`);
    try {
      const missing = await analyze(mode);
      assert.equal(missing.state, 'failed');
      assert.match(missing.error, /缺少 WorkGraph 分析 Skill/);
    } finally {
      await rename(`${skill}.missing`, skill);
    }
    const loaded = await analyze(mode);
    assert.equal(loaded.state, 'failed');
    assert.match(loaded.error, /本机 Codex 分析失败/);
    assert.doesNotMatch(loaded.error, /缺少 WorkGraph 分析 Skill/);
    assert.equal(loaded.lastRun.failedPhase, 'analysis');
  }
  await client.close();
});
