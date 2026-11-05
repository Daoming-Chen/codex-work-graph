import { readFile } from 'node:fs/promises';
import { createFixture } from '../test/fixture.mjs';
import { startHttp } from '../src/http.mjs';

const fixture = await createFixture();
const html = await readFile(new URL('../plugins/codex-work-graph/dist/graph.html', import.meta.url), 'utf8');
const demo = await startHttp({ repositoryPath: fixture.root, html });
console.log(`测试仓库（演示数据）: ${demo.url}`);
console.log(`测试目录: ${fixture.directory}`);
process.once('SIGINT', () => demo.server.close());
process.once('SIGTERM', () => demo.server.close());
