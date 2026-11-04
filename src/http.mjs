import { createWorkAnalysis } from './work-analysis.mjs';
import { readWorkGraph } from './work-graph.mjs';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { snapshot, commitDetail, worktreeDetail, resolveRepository } from './git.mjs';
import { filesDetail, fileDiff, resolveRef, prepareAction, executeAction } from './actions.mjs';
import { repositoryInfo, commitInfo, refInfo, reviewFiles, reviewDiff, fileContent } from './review.mjs';
import { readPreferences, savePreferences } from './preferences.mjs';

export async function startHttp({ repositoryPath, html, port = 0, now = Date.now, analysisOptions = {} }) {
  const { root } = await resolveRepository(repositoryPath);
  const analysis = createWorkAnalysis(analysisOptions);
  const token = randomBytes(32).toString('hex');
  let origin;
  let lastActivity = now();
  let activeRequests = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end('Forbidden'); return;
    }
    const url = new URL(req.url, origin);
    if (!['GET', 'POST'].includes(req.method)) { res.writeHead(405).end('Method not allowed'); return; }
    if (url.pathname === '/' && req.method === 'GET') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'self'");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return;
    }
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) {
      res.writeHead(401).end('Unauthorized'); return;
    }
    lastActivity = now();
    activeRequests++;
    try {
      let data;
      const writable = ['/api/prepare', '/api/execute', '/api/save_preferences', '/api/work_analyze'].includes(url.pathname);
      if ((writable && req.method !== 'POST') || (!writable && req.method !== 'GET')) { res.writeHead(405).end('Method not allowed'); return; }
      let body;
      if (writable) {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('必须使用 JSON。');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error('请求过大。'); chunks.push(chunk); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      if (url.pathname === '/api/snapshot') {
        const options={limit:Number(url.searchParams.get('limit')||300),offset:Number(url.searchParams.get('offset')||0),scope:url.searchParams.get('scope')||'',scopes:JSON.parse(url.searchParams.get('scopes')||'[]'),branchGlob:url.searchParams.get('branchGlob')||''};
        for(const key of ['firstParent','includeReflogs','showRemotes','showTags','showStashes']) if(url.searchParams.has(key)) {
          const value=url.searchParams.get(key);if(!['true','false'].includes(value))throw new Error('历史选项必须为布尔值。');options[key]=value==='true';
        }
        data=await snapshot(root,options);
      }
      else if (url.pathname === '/api/work_graph') data = { ...await readWorkGraph(root), analysis: await analysis.status(root) };
      else if (url.pathname === '/api/work_status') data = await analysis.status(root);
      else if (url.pathname === '/api/work_analyze') data = await analysis.start(root, body.mode);
      else if (url.pathname === '/api/commit') data = await commitDetail(root, url.searchParams.get('hash') || '');
      else if (url.pathname === '/api/worktree') data = await worktreeDetail(root, url.searchParams.get('path') || '');
      else if (url.pathname === '/api/files') data = await reviewFiles(root, JSON.parse(url.searchParams.get('input') || '{}'));
      else if (url.pathname === '/api/diff') data = await reviewDiff(root, JSON.parse(url.searchParams.get('input') || '{}'));
      else if (url.pathname === '/api/repository_info') data = await repositoryInfo(root);
      else if (url.pathname === '/api/commit_info') data = await commitInfo(root, url.searchParams.get('hash') || '');
      else if (url.pathname === '/api/ref_info') data = await refInfo(root, url.searchParams.get('ref') || '');
      else if (url.pathname === '/api/file_content') data = await fileContent(root, JSON.parse(url.searchParams.get('input') || '{}'));
      else if (url.pathname === '/api/preferences') data = await readPreferences(root);
      else if (url.pathname === '/api/save_preferences') data = await savePreferences(root, body.input);
      else if (url.pathname === '/api/resolve') data = await resolveRef(root, url.searchParams.get('ref') || '');
      else if (url.pathname === '/api/prepare') data = await prepareAction(root, body.action, body.payload, body.expectedVersion);
      else if (url.pathname === '/api/execute') data = await executeAction(root, body.actionId, body.operationId);
      else { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error.message }));
    } finally {
      activeRequests--;
      lastActivity = now();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.once('close', () => { void analysis.close(); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/#token=${token}`, origin, token,
    get lastActivity() { return lastActivity; },
    get activeRequests() { return activeRequests; },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
