// 浏览器信任闸：路由必须只服务 DSH 自己的页面。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createStateHandler } from '../lib/api.js';
import { createMemory } from '../lib/store.js';

const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-gate-'));
createMemory({
  vaultPath: VAULT,
  type: 'decision',
  title: '闸测试的一条',
  content: '这条只用来让路由有东西可读。',
  importance: 80,
  pinned: true,
  status: 'verified',
  confirm: true,
});

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

function check(name, fn) {
  return (async () => {
    await fn();
    console.log(`  ✓ ${name}`);
  })();
}

async function withServer(options, fn) {
  const handler = createStateHandler({ vaultPath: VAULT, ...options });
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const cases = [
  ['不传 trusted 时照旧放行（老宿主/测试）', async () => {
    const r = await withServer({}, (port) => request(port, '/memory-yuan/state'));
    assert.equal(r.status, 200);
  }],
  ['trusted 返回 false 时一律 403', async () => {
    const r = await withServer({ trusted: () => false }, (port) => request(port, '/memory-yuan/state'));
    assert.equal(r.status, 403);
    assert.match(r.body, /forbidden/);
  }],
  ['trusted 返回 false 时写接口也 403', async () => {
    const r = await withServer({ trusted: () => false }, (port) => request(port, '/memory-yuan/supersede', 'POST'));
    assert.equal(r.status, 403);
  }],
  ['trusted 返回 true 时正常', async () => {
    const r = await withServer({ trusted: () => true }, (port) => request(port, '/memory-yuan/state'));
    assert.equal(r.status, 200);
  }],
  ['403 是 JSON，不是 HTML', async () => {
    const r = await withServer({ trusted: () => false }, (port) => request(port, '/memory-yuan/state'));
    assert.deepEqual(JSON.parse(r.body), { error: 'forbidden' });
  }],
];

let fail = 0;
for (const [name, fn] of cases) {
  try {
    await check(name, fn);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}
console.log(fail === 0 ? '\n全部通过' : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
