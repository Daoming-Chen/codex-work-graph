import { createWorkAnalysis } from './work-analysis.mjs';
import { readWorkGraph } from './work-graph.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { snapshot, commitDetail, worktreeDetail } from './git.mjs';
import { startHttp } from './http.mjs';
import { actionNames, resolveRef, prepareAction, executeAction } from './actions.mjs';
import { repositoryInfo, commitInfo, refInfo, reviewFiles, reviewDiff, fileContent } from './review.mjs';
import { readPreferences, savePreferences } from './preferences.mjs';
import { repositoryContext } from './workspace-context.mjs';
import { createPanelManager } from './panel-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function readUi() {
  for (const filename of [path.join(here, 'graph.html'), path.join(here, '../plugins/workgraph/dist/graph.html')]) {
    try { return await readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('请先运行 npm run build，生成 WorkGraph 面板。');
}

export function createMcpServer(html, { contextOptions = {}, analysisOptions = {} } = {}) {
  const mcp = new McpServer({ name: 'workgraph', version: '0.3.0' });
  const uri = 'ui://workgraph/panel.html';
  const analysis = createWorkAnalysis(analysisOptions);
  const panels = createPanelManager({ html });
  mcp.server.onclose = () => { void panels.close(); void analysis.close(); };
  // Context lookups always query roots afresh, so changes require no cached-state
  // invalidation. Accept the standard notification without guessing a thread id.
  mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {});
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  registerAppResource(mcp, 'workgraph-panel', uri, {}, async () => ({ contents: [{
    uri, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  const safely = fn => async (args, extra) => {
    try { return { content: [], structuredContent: await fn(args, extra) }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  const repo = { repositoryPath: z.string().optional().describe('Absolute repository path override. Open automatically resolves the local Codex conversation/project, a single local Git MCP root, or WORKGRAPH_REPO.') };
  const requiredRepo = input => {
    const selected = input || process.env.WORKGRAPH_REPO;
    if (!selected) throw new Error('请先选择仓库。');
    return selected;
  };
  registerAppTool(mcp, 'workgraph_open', {
    title: 'WorkGraph', description: 'Open Git history and local worktree review. Automatically resolves the local Codex conversation or selected project; also accepts an explicit repository path, a single local Git MCP root, or WORKGRAPH_REPO. Returns a loopback browser panel URL.',
    inputSchema: { ...repo, limit: z.number().int().min(1).max(2000).default(300), offset:z.number().int().nonnegative().default(0), scope: z.string().default(''), scopes:z.array(z.string()).optional(),branchGlob:z.string().optional(),firstParent:z.boolean().optional(),includeReflogs:z.boolean().optional(),showRemotes:z.boolean().optional(),showTags:z.boolean().optional(),showStashes:z.boolean().optional() }, annotations,
    _meta: { ui: { resourceUri: uri, visibility: ['app', 'model'] }, 'openai/ui': { entrypoints: [{ type: 'thread' }] } },
  }, safely(async ({ repositoryPath, ...options }, extra) => {
    const binding = await repositoryContext(mcp.server, { ...contextOptions, repositoryPath, meta: extra?._meta, signal: extra?.signal });
    if (binding.needsRepository) return binding;
    const data = await snapshot(binding.repositoryPath, options);
    const key = data.repository.path;
    const panel = await panels.open(key);
    return { ...data, context: binding.context, panelUrl: panel.url };
  }));
  registerAppTool(mcp, 'workgraph_context', {
    title: '读取 Workspace 上下文', description: 'Resolve the current local repository from per-request Codex conversation metadata and local project state, standardized MCP roots, or WORKGRAPH_REPO.',
    inputSchema: {}, annotations, _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
  }, safely((args, extra) => repositoryContext(mcp.server, { ...contextOptions, meta: extra?._meta, signal: extra?.signal })));
  registerAppTool(mcp, 'workgraph_work_graph', {
    title: '读取工作进展', description: 'Read explicit work records and real local Git commits.',
    inputSchema: { ...repo }, annotations, _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
  }, safely(async ({ repositoryPath }) => ({ ...await readWorkGraph(requiredRepo(repositoryPath)), analysis: await analysis.status(requiredRepo(repositoryPath)) })));
  registerAppTool(mcp, 'workgraph_work_status', {
    title: '查看工作分析状态', description: 'Read local WorkGraph analysis progress.', inputSchema: repo, annotations, _meta:{ui:{resourceUri:uri,visibility:['app','model']}},
  }, safely(({repositoryPath})=>analysis.status(requiredRepo(repositoryPath))));
  registerAppTool(mcp, 'workgraph_work_analyze', {
    title: '初始化或更新工作记录', description: 'Update the work map only when requested by the user. Automatically choose initial analysis or incremental update. Never enable background maintenance. Runs local Codex read-only and saves validated records in .workgraph/. Uses local Codex authentication and model usage.',
    inputSchema: {...repo, mode:z.enum(['auto','initialize','update']).default('auto')},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    _meta:{ui:{resourceUri:uri,visibility:['app','model']}},
  }, safely(({repositoryPath,mode})=>analysis.start(requiredRepo(repositoryPath),mode)));
  registerAppTool(mcp, 'workgraph_commit', {
    title: '查看提交', description: 'Read commit details and a bounded patch; merges compare to the first parent.',
    inputSchema: { ...repo, hash: z.string().regex(/^[a-f0-9]{40,64}$/) }, annotations,
    _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
  }, safely(({ repositoryPath, hash }) => commitDetail(requiredRepo(repositoryPath), hash)));
  registerAppTool(mcp, 'workgraph_worktree', {
    title: '查看 Worktree 改动', description: 'Read staged and unstaged diffs plus untracked filenames for a worktree in this repository.',
    inputSchema: { ...repo, worktreePath: z.string() }, annotations,
    _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
  }, safely(({ repositoryPath, worktreePath }) => worktreeDetail(requiredRepo(repositoryPath), worktreePath)));
  const input = z.object({ worktreePath: z.string().optional(), hash: z.string().optional(), a: z.string().optional(), b: z.string().optional(), parent: z.number().int().optional(), fileId: z.string().optional(), version: z.string().optional(),revision:z.enum(['current','before','after']).optional() }).strict();
  for (const [name, fn] of [['files', reviewFiles], ['diff', reviewDiff], ['file_content',fileContent]]) registerAppTool(mcp, `workgraph_${name}`, {
    title: name === 'files' ? '读取变更文件' : '读取单文件差异', description: 'Read structured changes or one listed file diff.', inputSchema: { ...repo, input }, annotations,
    _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
  }, safely(({ repositoryPath, input }) => fn(requiredRepo(repositoryPath), input)));
  for(const [name,fn,field] of [['repository_info',repositoryInfo,null],['commit_info',commitInfo,'hash'],['ref_info',refInfo,'ref']]) registerAppTool(mcp,`workgraph_${name}`,{
    title:{repository_info:'查看远程仓库和 Stash',commit_info:'查看提交元数据',ref_info:'查看引用元数据'}[name],description:'Read repository metadata without modifying Git state.',inputSchema:{...repo,...(field?{[field]:z.string()}: {})},annotations,_meta:{ui:{resourceUri:uri,visibility:['app']}},
  },safely(args=>fn(requiredRepo(args.repositoryPath),field?args[field]:undefined)));
  registerAppTool(mcp, 'workgraph_resolve', { title: '解析引用', description: 'Resolve a full ref or immutable SHA.', inputSchema: { ...repo, ref: z.string() }, annotations, _meta: { ui: { resourceUri: uri, visibility: ['app'] } } }, safely(({ repositoryPath, ref }) => resolveRef(requiredRepo(repositoryPath), ref)));
  registerAppTool(mcp, 'workgraph_preferences', {title:'读取仓库偏好与审阅进度',description:'Read durable plugin preferences and review progress shared by the repository worktrees.',inputSchema:repo,annotations,_meta:{ui:{resourceUri:uri,visibility:['app']}}},safely(({repositoryPath})=>readPreferences(requiredRepo(repositoryPath))));
  registerAppTool(mcp, 'workgraph_save_preferences', {title:'保存仓库偏好与审阅进度',description:'Save plugin-only settings and review progress in the Git common directory. Does not modify refs, index, Git configuration or working files.',inputSchema:{...repo,input:z.record(z.string(),z.unknown())},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},_meta:{ui:{resourceUri:uri,visibility:['app']}}},safely(({repositoryPath,input})=>savePreferences(requiredRepo(repositoryPath),input)));
  registerAppTool(mcp, 'workgraph_prepare', { title: '检查 Git 操作', description: 'Validate and prepare a typed Git action; does not execute it. Destructive actions require explicit confirmation. Expires after two minutes.', inputSchema: { ...repo, action: z.enum(actionNames), payload: z.record(z.string(), z.unknown()), expectedVersion: z.string().optional() }, annotations, _meta: { ui: { resourceUri: uri, visibility: ['app'] } } }, safely(({ repositoryPath, action, payload, expectedVersion }) => prepareAction(requiredRepo(repositoryPath), action, payload, expectedVersion)));
  registerAppTool(mcp, 'workgraph_execute', { title: '执行已检查的 Git 操作', description: 'Execute a prepared action once with state revalidation. Can modify local and remote Git state, rewrite history, or discard explicitly selected changes. Runs normal Git hooks.', inputSchema: { ...repo, actionId: z.string().uuid(), operationId: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }, _meta: { ui: { resourceUri: uri, visibility: ['app'] } } }, safely(({ repositoryPath, actionId, operationId }) => executeAction(requiredRepo(repositoryPath), actionId, operationId)));
  let closing;
  return { mcp, close: () => closing ??= (async () => {
    try { await panels.close(); await analysis.close(); }
    finally { await mcp.close(); }
  })() };
}

async function main() {
  const args = process.argv.slice(2);
  const get = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const html = await readUi();
  if (args.includes('--http')) {
    const panel = await startHttp({ repositoryPath: path.resolve(get('--repo') || process.env.WORKGRAPH_REPO || process.cwd()), html, port: Number(get('--port') || 0) });
    console.log(`WorkGraph: ${panel.url}`);
    process.once('SIGINT', () => panel.server.close());
    process.once('SIGTERM', () => panel.server.close());
  } else {
    const server = createMcpServer(html);
    await server.mcp.connect(new StdioServerTransport());
    const shutdown = () => { void server.close().finally(() => process.stdin.pause()); };
    process.stdin.once('end', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
