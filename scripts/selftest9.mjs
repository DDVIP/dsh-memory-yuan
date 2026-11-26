/**
 * 自测第九套：内容/frontmatter 边界、vault 扫描、索引自愈、HTTP 边界。
 *
 * 全部在临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, serializeMemory, supersedeMemory } from '../lib/store.js';
import { loadMemories, readMemoryFile } from '../lib/vault.js';
import { createTools } from '../lib/tools.js';
import { createStateHandler } from '../lib/api.js';
import { markSuperseded, readMemoryText, readState, writeIndex } from '../lib/snapshot.js';
import { appendStream, readStream, streamFile } from '../lib/stream.js';

let pass = 0;
const fails = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fails.push([name, error?.message ?? String(error)]);
    console.log(`  FAIL ${name} → ${error?.message ?? error}`);
  }
}

function fresh() {
  return mkdtempSync(join(tmpdir(), 'my9-'));
}

function writeRaw(vault, rel, text) {
  const full = join(vault, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      Object.assign(res.headers, headers ?? {});
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    end(chunk) {
      if (chunk) res.body += String(chunk);
    },
  };
  return res;
}

function mockReq({ method = 'GET', url = '/', body } = {}) {
  const handlers = {};
  const req = {
    method,
    url,
    headers: {},
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
      return req;
    },
  };
  queueMicrotask(() => {
    if (body !== undefined) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      for (const fn of handlers.data ?? []) fn(Buffer.from(text));
    }
    for (const fn of handlers.end ?? []) fn();
  });
  return req;
}

async function call(handler, opts) {
  const res = mockRes();
  await handler(mockReq(opts), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, json };
}

function toolsOf(vault) {
  const list = createTools({ vaultPath: vault });
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

// ---------------------------------------------------------------- 内容边界

await check('content 里带 --- 分隔线：不破坏 frontmatter，条目仍是 verified', () => {
  const vault = fresh();
  const created = createMemory({
    vaultPath: vault,
    title: '带分隔线的条目',
    type: 'experience',
    content: '第一段\n\n---\n\n第二段',
  });
  assert.equal(created.ok, true);
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'verified');
  assert.equal(list[0].id, created.id);
  assert.match(list[0].raw, /---\n\n第二段/);
});

await check('content 里带「## 核心内容」：core 取第一段且内容完整', () => {
  const vault = fresh();
  createMemory({
    vaultPath: vault,
    title: '重复小节标题',
    type: 'experience',
    content: '第一条核心\n\n## 核心内容\n\n第二条',
  });
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.match(list[0].core, /第一条核心/);
});

await check('title 400 字：写入成功、文件名不超长、title 完整保留', () => {
  const vault = fresh();
  const title = '长标题'.repeat(100);
  const created = createMemory({ vaultPath: vault, title, type: 'knowledge', content: '正文' });
  assert.equal(created.ok, true);
  const name = created.path.split(/[\\/]/).pop();
  assert.ok(name.length < 200, `文件名太长：${name.length}`);
  const list = loadMemories(vault);
  assert.equal(list[0].title, title);
});

await check('tags 含 [ ] : # " 与 emoji：往返无损', () => {
  const vault = fresh();
  const tags = ['[方括号]', '冒号: 半角', '#井号', '引号"双', '❤️ emoji'];
  const created = createMemory({ vaultPath: vault, title: '怪 tag', type: 'knowledge', content: 'x', tags });
  assert.equal(created.ok, true);
  const list = loadMemories(vault);
  for (const tag of tags) assert.ok(list[0].tags.includes(tag), `丢了 tag：${tag} → ${JSON.stringify(list[0].tags)}`);
});

await check('content 含 CRLF / Tab / emoji：读回内容不丢', () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '换行与制表符', type: 'experience', content: '行一\r\n行二\t制表 ❤️' });
  const list = loadMemories(vault);
  assert.match(list[0].core, /行一/);
  assert.match(list[0].core, /行二\t制表 ❤️/);
});

await check('source 含换行：不破坏 frontmatter', () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '来源带换行', type: 'experience', content: '正文', source: '第一行\n第二行' });
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'verified');
});

await check('同秒两次写入同名 title：两个不同 id、都是 verified', () => {
  const vault = fresh();
  const a = createMemory({ vaultPath: vault, title: '同名', type: 'knowledge', content: 'A' });
  const b = createMemory({ vaultPath: vault, title: '同名', type: 'knowledge', content: 'B' });
  assert.notEqual(a.id, b.id);
  const list = loadMemories(vault);
  assert.equal(list.filter((item) => item.status === 'verified').length, 2);
});

// ---------------------------------------------------------------- 检索边界

await check('memory_search query=".*"：不抛，正常返回数组', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '正则字符', type: 'knowledge', content: 'x' });
  const tools = toolsOf(vault);
  const out = await tools.memory_search.execute({ query: '.*' }, { sessionId: 's' });
  assert.ok(Array.isArray(out.rows));
  assert.equal(out.count, out.rows.length);
});

await check('memory_search limit=0 / 负数：返回空数组而不是全量', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '限额', type: 'knowledge', content: 'x' });
  const tools = toolsOf(vault);
  for (const limit of [0, -3]) {
    const out = await tools.memory_search.execute({ query: '限额', limit }, { sessionId: 's' });
    assert.equal(out.rows.length, 0, `limit=${limit} 返回了 ${out.rows.length} 条`);
  }
});

await check('memory_search tags=[]：不因空数组返回空', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '空 tag 查询', type: 'knowledge', content: 'x' });
  const tools = toolsOf(vault);
  const out = await tools.memory_search.execute({ query: '空 tag', tags: [] }, { sessionId: 's' });
  assert.ok(out.rows.length >= 1);
});

await check('memory_search type="nope"：返回空而不是报错', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '类型非法', type: 'knowledge', content: 'x' });
  const tools = toolsOf(vault);
  const out = await tools.memory_search.execute({ query: '类型', type: 'nope' }, { sessionId: 's' });
  assert.equal(out.rows.length, 0);
});

// ---------------------------------------------------------------- vault 扫描

await check('vault 里的 README.md / .txt / 非 md 文件：不当记忆', () => {
  const vault = fresh();
  writeRaw(vault, 'README.md', '# 说明\n不是记忆');
  writeRaw(vault, 'Knowledge/notes.txt', '纯文本');
  createMemory({ vaultPath: vault, title: '真记忆', type: 'knowledge', content: 'x' });
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '真记忆');
});

await check('大写目录 DECISIONS/：仍能被扫到', () => {
  const vault = fresh();
  writeRaw(
    vault,
    'DECISIONS/大写目录-mem_x1.md',
    '---\nid: mem_x1\ntype: decision\nstatus: active\ntitle: 大写目录条目\ntags: [决定]\nimportance: 70\n---\n\n## 核心内容\n\n正文\n',
  );
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '大写目录条目');
});

// ---------------------------------------------------------------- 索引自愈

await check('index.json 是坏 JSON：GET /state 仍 200 并自动重建', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '索引坏了也要能看', type: 'knowledge', content: 'x' });
  writeRaw(vault, '.dsh-memory/index.json', '{ 这不是 json');
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'GET', url: '/memory-yuan/state' });
  assert.equal(out.status, 200);
  assert.equal(Array.isArray(out.json.index.entries), true);
  assert.equal(out.json.index.entries.length, 1);
});

await check('last-inject.json 坏了：GET /state 不炸', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '快照坏了', type: 'knowledge', content: 'x' });
  writeRaw(vault, '.dsh-memory/last-inject.json', 'oops');
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'GET', url: '/memory-yuan/state' });
  assert.equal(out.status, 200);
  assert.ok(out.json.lastInject !== undefined);
});

await check('writeIndex 后 entries 数量等于非流水条目数', () => {
  const vault = fresh();
  for (let i = 0; i < 5; i += 1) createMemory({ vaultPath: vault, title: `条目${i}`, type: 'knowledge', content: 'x' });
  appendStream({ vaultPath: vault, kind: 'daily', content: '流水一行' });
  writeIndex(vault);
  const state = readState(vault);
  assert.equal(state.index.entries.length, 5);
});

await check('markSuperseded 不存在的 id：ok=false 且带原因', () => {
  const vault = fresh();
  const result = markSuperseded(vault, 'mem_nope');
  assert.equal(result.ok, false);
  assert.ok(result.message && result.message.length > 0);
});

await check('重复 supersede 同一条：第二次仍 ok（幂等）', () => {
  const vault = fresh();
  const created = createMemory({ vaultPath: vault, title: '重复取代', type: 'knowledge', content: 'x' });
  const first = markSuperseded(vault, created.id);
  const second = markSuperseded(vault, created.id);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
});

await check('readMemoryText 不存在 id：返回 null', () => {
  const vault = fresh();
  assert.equal(readMemoryText(vault, 'mem_nope'), null);
});

// ---------------------------------------------------------------- 流水

await check('appendStream 指定昨天日期：落在 Daily/YYYY-MM-DD.md', () => {
  const vault = fresh();
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '昨天写的', date: '2026-11-21' });
  assert.equal(out.ok, true);
  assert.ok(out.path.includes('2026-11-21'));
  const read = readStream(vault, { kind: 'daily', date: '2026-11-21' });
  assert.match(read.text, /昨天写的/);
});

await check('项目名带 emoji：能建文件并读回', () => {
  const vault = fresh();
  const out = appendStream({ vaultPath: vault, kind: 'project', project: '记忆 🐟 插件', content: '一行' });
  assert.equal(out.ok, true);
  const read = readStream(vault, { kind: 'project', project: '记忆 🐟 插件' });
  assert.equal(read.ok, true);
  assert.match(read.text, /一行/);
});

// ---------------------------------------------------------------- HTTP 边界

await check('HTTP /memory 不存在 id：404', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'GET', url: '/memory-yuan/memory?id=mem_nope' });
  assert.equal(out.status, 404);
});

await check('HTTP /state 带 cache-control: no-store', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'GET', url: '/memory-yuan/state' });
  assert.equal(out.headers['cache-control'], 'no-store');
});

await check('HTTP PUT /state：当作未知路径 404', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'PUT', url: '/memory-yuan/state' });
  assert.equal(out.status, 404);
});

await check('HTTP /supersede 的 id 前后带空格：能裁掉空格找到', async () => {
  const vault = fresh();
  const created = createMemory({ vaultPath: vault, title: '空格 id', type: 'knowledge', content: 'x' });
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'POST', url: '/memory-yuan/supersede', body: { id: `  ${created.id}  ` } });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
});

// ---------------------------------------------------------------- 工具契约

await check('tools 的 schema 与 execute 返回键一致（write 的 md/index/indexError）', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const args = tools.memory_write.parameters;
  assert.deepEqual(args.required, []);
  const declared = Object.keys(args.properties ?? {});
  for (const key of ['mode', 'stream', 'project', 'date', 'supersedes', 'source_sessions']) {
    assert.ok(declared.includes(key), `write schema 缺 ${key}`);
  }
  const out = await tools.memory_write.execute({ title: '契约', type: 'knowledge', content: 'x' }, { sessionId: 's' });
  assert.equal(out.md, 'ok');
  assert.ok(['ok', 'failed'].includes(out.index));
});

await check('memory_get 同时传 id 与 stream：仍返回结果不抛', async () => {
  const vault = fresh();
  const created = createMemory({ vaultPath: vault, title: '两种取法', type: 'knowledge', content: 'x' });
  appendStream({ vaultPath: vault, kind: 'daily', content: '流水' });
  const tools = toolsOf(vault);
  const out = await tools.memory_get.execute({ id: created.id, stream: 'daily' }, { sessionId: 's' });
  assert.equal(out.ok, true);
});

await check('createMemory type=profile：落到 Profile/ 目录', () => {
  const vault = fresh();
  const created = createMemory({ vaultPath: vault, title: '档案条目', type: 'profile', content: 'x' });
  assert.equal(created.ok, true);
  assert.ok(created.path.includes('Profile'));
});

await check('createMemory 缺 title：报错里说 title', () => {
  const result = createMemory({ vaultPath: fresh(), type: 'knowledge', content: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.message, /title/i);
});

await check('serializeMemory 的 importance 越界被夹取', () => {
  const text = serializeMemory({ id: 'mem_z', title: '夹取', type: 'knowledge', content: 'x', importance: 999 });
  assert.match(text, /^importance: 100$/m);
});

console.log('');
if (fails.length) {
  console.log(`selftest9：${pass} 项通过，${fails.length} 项失败`);
  for (const [name, message] of fails) console.log(`  - ${name}: ${message}`);
  process.exitCode = 1;
} else {
  console.log(`selftest9：全部通过（${pass} 项）`);
}
