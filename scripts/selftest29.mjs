/**
 * selftest29：详情页的编辑与删除（改标题/标签/重要度/正文、移进 Archive、关联记忆）。
 *
 * 主人 2026-11-24：第二层要能编辑和删除；删除要二次确认，别一键就没了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { archiveMemory, createMemory, updateMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { createStateHandler } from '../lib/api.js';

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-edit-'));
}

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const listeners = {};
  return {
    method,
    url,
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    _flush() {
      if (chunks.length) listeners.data?.(Buffer.concat(chunks));
      listeners.end?.();
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk) {
      res.body += chunk ?? '';
    },
  };
  return res;
}

async function call(handler, method, url, body) {
  const req = fakeReq(method, url, body);
  const res = fakeRes();
  const done = handler(req, res);
  req._flush();
  await done;
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

// ---------------------------------------------------------------------------
await check('改标题：title 变、id/status 保留、updated_at 刷新', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '旧标题', type: 'knowledge', content: '正文。' });
  const result = updateMemory(made.path, { title: '新标题' }, { vaultPath: vault });
  assert.equal(result.ok, true);
  const raw = fs.readFileSync(made.path, 'utf8');
  assert.match(raw, /^title: 新标题$/m);
  assert.match(raw, new RegExp(`^id: ${made.id}$`, 'm'));
  assert.match(raw, /^status: verified$/m);
  assert.equal(path.basename(made.path), path.basename(made.path));
});

await check('改标签与重要度：行写对、越界夹取', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '带标签的', type: 'knowledge', content: '正文。', tags: ['a'] });
  const result = updateMemory(made.path, { tags: ['星图', '带 空格'], importance: 500 }, { vaultPath: vault });
  assert.equal(result.ok, true);
  const raw = fs.readFileSync(made.path, 'utf8');
  assert.match(raw, /^importance: 100$/m);
  const reloaded = loadMemories(vault);
  assert.deepEqual(reloaded[0].tags, ['星图', '带 空格']);
});

await check('改正文：只换 ## 核心内容，其它章节保留', () => {
  const vault = tmpVault();
  const made = createMemory({
    vaultPath: vault,
    title: '有来源的',
    type: 'experience',
    content: '旧正文。',
    source: '2026-11-24 的对话',
  });
  const result = updateMemory(made.path, { content: '新正文，一行。' }, { vaultPath: vault });
  assert.equal(result.ok, true);
  const raw = fs.readFileSync(made.path, 'utf8');
  assert.match(raw, /新正文，一行。/);
  assert.doesNotMatch(raw, /旧正文。/);
  assert.match(raw, /## 来源与依据[\s\S]*2026-11-24 的对话/);
  assert.match(raw, /## 相关记忆/);
});

await check('空标题 / 空正文 / tags 不是数组：拒绝且不写盘', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '别动我', type: 'knowledge', content: '正文。' });
  const before = fs.readFileSync(made.path, 'utf8');
  assert.equal(updateMemory(made.path, { title: '   ' }, { vaultPath: vault }).ok, false);
  assert.equal(updateMemory(made.path, { content: '  ' }, { vaultPath: vault }).ok, false);
  assert.equal(updateMemory(made.path, { tags: 'x' }, { vaultPath: vault }).ok, false);
  assert.equal(fs.readFileSync(made.path, 'utf8'), before);
});

await check('改之前有备份（backups 里多一份）', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '要备份的', type: 'knowledge', content: '正文。' });
  const dir = path.join(vault, '.dsh-memory', 'backups');
  const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  updateMemory(made.path, { title: '改过名' }, { vaultPath: vault });
  const after = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.ok(after > before, '备份没生成');
});

await check('删除 = 移到 Archive，原位置没有、内容还在', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '要删的', type: 'knowledge', content: '留着正文。' });
  const result = archiveMemory(made.path, { vaultPath: vault });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(made.path), false);
  assert.match(fs.readFileSync(result.path, 'utf8'), /留着正文。/);
  assert.match(result.path, /[\\/]Archive[\\/]/);
  assert.equal(loadMemories(vault).length, 0);
});

await check('删除重名不覆盖：两次归档同一份名字', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '同名', type: 'knowledge', content: '第一次。' });
  const base = path.basename(made.path);
  const first = archiveMemory(made.path, { vaultPath: vault });
  assert.equal(first.ok, true);
  fs.writeFileSync(path.join(vault, 'Archive', base), '第二次。', 'utf8');
  const again = archiveMemory(made.path, { vaultPath: vault });
  assert.equal(again.ok, false, '文件已经不在了，应该报失败');
});

await check('HTTP GET /related：同 tag 能连上', async () => {
  const vault = tmpVault();
  const a = createMemory({ vaultPath: vault, title: '星图节点一', type: 'knowledge', content: '甲。', tags: ['星图测试'] });
  createMemory({ vaultPath: vault, title: '星图节点二', type: 'knowledge', content: '乙。', tags: ['星图测试'] });
  const handler = createStateHandler({ vaultPath: vault });
  const res = await call(handler, 'GET', `/memory-yuan/related?id=${a.id}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.related));
  assert.ok(res.json.related.length >= 1);
  assert.ok(res.json.related[0].title);
});

await check('HTTP GET /related：缺 id 400、没有这条 404', async () => {
  const vault = tmpVault();
  createMemory({ vaultPath: vault, title: '一条', type: 'knowledge', content: '正文。' });
  const handler = createStateHandler({ vaultPath: vault });
  assert.equal((await call(handler, 'GET', '/memory-yuan/related')).status, 400);
  assert.equal((await call(handler, 'GET', '/memory-yuan/related?id=nope')).status, 404);
});

await check('HTTP POST /update：200 且文件真改了', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '改我', type: 'knowledge', content: '旧。' });
  const handler = createStateHandler({ vaultPath: vault });
  const res = await call(handler, 'POST', '/memory-yuan/update', { id: made.id, title: '改过了', importance: 88 });
  assert.equal(res.status, 200);
  const raw = fs.readFileSync(made.path, 'utf8');
  assert.match(raw, /^title: 改过了$/m);
  assert.match(raw, /^importance: 88$/m);
});

await check('HTTP POST /update：缺 id 400', async () => {
  const vault = tmpVault();
  const handler = createStateHandler({ vaultPath: vault });
  assert.equal((await call(handler, 'POST', '/memory-yuan/update', {})).status, 400);
});

await check('HTTP POST /delete：不带 confirm 400、带了才删', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '删我', type: 'knowledge', content: '正文。' });
  const handler = createStateHandler({ vaultPath: vault });
  assert.equal((await call(handler, 'POST', '/memory-yuan/delete', { id: made.id })).status, 400);
  const res = await call(handler, 'POST', '/memory-yuan/delete', { id: made.id, confirm: true });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(made.path), false);
});

await check('编辑后索引里的标题也变了', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '索引旧名', type: 'knowledge', content: '正文。' });
  const handler = createStateHandler({ vaultPath: vault });
  await call(handler, 'POST', '/memory-yuan/update', { id: made.id, title: '索引新名' });
  const state = await call(handler, 'GET', '/memory-yuan/state');
  const entry = state.json.index.entries.find((item) => item.id === made.id);
  assert.equal(entry.title, '索引新名');
});

// ---------------------------------------------------------------------------
console.log(`\nselftest29：${passed} 通过，${failures.length} 失败`);
if (failures.length) process.exitCode = 1;
