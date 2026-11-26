/**
 * 自测第十套：并发、性能、渲染契约、真实使用里的怪输入。
 *
 * 全部在临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { createTools } from '../lib/tools.js';
import { createStateHandler } from '../lib/api.js';
import { selectL1 } from '../lib/l1.js';
import { readState, writeIndex } from '../lib/snapshot.js';
import { appendStream, readStream } from '../lib/stream.js';

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
  return mkdtempSync(join(tmpdir(), 'my10-'));
}

function writeRaw(vault, rel, text) {
  const full = join(vault, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
}

function memoryMd(id, title, type = 'knowledge', core = '正文', importance = 50) {
  return `---\nid: ${id}\ntype: ${type}\nstatus: active\ntitle: ${title}\ntags: [${type}]\nconfidence: 0.8\nimportance: ${importance}\npinned: false\n---\n\n## 核心内容\n\n${core}\n`;
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

// ---------------------------------------------------------------- 并发

await check('并发 20 次 appendStream 同一 daily：行数正好 20、无交错', async () => {
  const vault = fresh();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => appendStream({ vaultPath: vault, kind: 'daily', content: `并发第${i}行` }))),
  );
  const read = readStream(vault, { kind: 'daily' });
  assert.equal(read.ok, true);
  const lines = read.text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 20, `实际 ${lines.length} 行`);
  for (let i = 0; i < 20; i += 1) assert.ok(read.text.includes(`并发第${i}行`), `丢了第 ${i} 行`);
});

await check('并发 20 次 createMemory：20 个文件、20 条 active、id 各不相同', async () => {
  const vault = fresh();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => createMemory({ vaultPath: vault, title: `并发条目${i}`, type: 'knowledge', content: `正文${i}` })),
    ),
  );
  const ids = new Set(results.filter((item) => item.ok).map((item) => item.id));
  assert.equal(ids.size, 20);
  const list = loadMemories(vault);
  assert.equal(list.filter((item) => item.status === 'verified').length, 20);
});

await check('并发 10 个 HTTP GET /state：全部 200 且结构一致', async () => {
  const vault = fresh();
  for (let i = 0; i < 5; i += 1) writeRaw(vault, `Knowledge/条目${i}-mem_c${i}.md`, memoryMd(`mem_c${i}`, `条目${i}`));
  const handler = createStateHandler({ vaultPath: vault });
  const outs = await Promise.all(Array.from({ length: 10 }, () => call(handler, { method: 'GET', url: '/memory-yuan/state' })));
  for (const out of outs) {
    assert.equal(out.status, 200);
    assert.equal(out.json.index.entries.length, 5);
  }
});

// ---------------------------------------------------------------- 性能

await check('500 条记忆：loadMemories + selectL1 在 300ms 内', () => {
  const vault = fresh();
  mkdirSync(join(vault, 'Knowledge'), { recursive: true });
  for (let i = 0; i < 500; i += 1) {
    writeFileSync(join(vault, 'Knowledge', `条目${i}-mem_p${i}.md`), memoryMd(`mem_p${i}`, `第 ${i} 条记忆 记忆插件 L1 检索`, 'knowledge', '记忆插件的 L1 检索按线索命中。'));
  }
  const start = performance.now();
  const list = loadMemories(vault);
  assert.equal(list.length, 500);
  selectL1(list, {
    agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text: '记忆插件的 L1 检索按线索命中' }] } }] } },
  });
  const cost = performance.now() - start;
  assert.ok(cost < 300, `花了 ${cost.toFixed(1)}ms`);
});

// ---------------------------------------------------------------- 渲染契约（防签名回归）

await check('memory_write 的 render 用 (args, value) 拿得到 value 并输出 md/index', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const args = { title: '渲染契约', type: 'knowledge', content: 'x' };
  const value = await tools.memory_write.execute(args, { sessionId: 's' });
  const blocks = tools.memory_write.output.render(args, value);
  assert.equal(blocks.length, 1);
  const text = blocks[0].text;
  assert.match(text, /已写入 knowledge：渲染契约/);
  assert.match(text, /md：ok/);
  assert.match(text, /索引：ok/);
});

await check('memory_search 的 render 用 (args, value)：输出条数与 query', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  createMemory({ vaultPath: vault, title: '渲染搜索', type: 'knowledge', content: 'x' });
  const args = { query: '渲染搜索' };
  const value = await tools.memory_search.execute(args, { sessionId: 's' });
  const text = tools.memory_search.output.render(args, value)[0].text;
  assert.match(text, /渲染搜索/);
  assert.ok(text.split('\n').length >= 1);
});

await check('memory_write append 的 render 输出「已追加」', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const args = { mode: 'append', stream: 'daily', content: '渲染一行' };
  const value = await tools.memory_write.execute(args, { sessionId: 's' });
  const text = tools.memory_write.output.render(args, value)[0].text;
  assert.match(text, /已追加 daily 流水/);
  assert.match(text, /渲染一行/);
});

await check('memory_get stream 的 render 输出全文', async () => {
  const vault = fresh();
  appendStream({ vaultPath: vault, kind: 'daily', content: '渲染流水' });
  const tools = toolsOf(vault);
  const args = { stream: 'daily' };
  const value = await tools.memory_get.execute(args, { sessionId: 's' });
  const text = tools.memory_get.output.render(args, value)[0].text;
  assert.match(text, /渲染流水/);
});

// ---------------------------------------------------------------- 怪输入

await check('HTTP id 用 URL 编码的中文：能命中', async () => {
  const vault = fresh();
  const created = createMemory({ vaultPath: vault, title: '中文 id 测试', type: 'knowledge', content: 'x' });
  const handler = createStateHandler({ vaultPath: vault });
  const out = await call(handler, { method: 'GET', url: `/memory-yuan/memory?id=${encodeURIComponent(created.id)}` });
  assert.equal(out.status, 200);
  assert.equal(out.json.id, created.id);
});

await check('手写的 md 没有 id：loadMemories 不崩、id 非空', () => {
  const vault = fresh();
  writeRaw(vault, 'Knowledge/没写id.md', '---\ntype: knowledge\nstatus: active\ntitle: 没写 id 的条目\n---\n\n## 核心内容\n\n正文\n');
  const list = loadMemories(vault);
  assert.equal(list.length, 1);
  assert.ok(String(list[0].id ?? '').trim().length > 0, `id 是空的：${JSON.stringify(list[0].id)}`);
});

await check('memory_write supersedes 不存在的 id：仍写入成功并带提示', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const out = await tools.memory_write.execute(
    { title: '取代不存在', type: 'knowledge', content: 'x', supersedes: 'mem_nope' },
    { sessionId: 's' },
  );
  assert.equal(out.ok, true);
  assert.ok(out.message && /没找到/.test(out.message), `提示是：${out.message}`);
});

await check('append 到被手工改成 CRLF 的 daily 文件：读回不炸', () => {
  const vault = fresh();
  writeRaw(vault, 'Daily/2026-11-20.md', '# 2026-11-20 流水\r\n\r\n- 09:00 旧行\r\n');
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '新行', date: '2026-11-20' });
  assert.equal(out.ok, true);
  const read = readStream(vault, { kind: 'daily', date: '2026-11-20' });
  assert.match(read.text, /旧行/);
  assert.match(read.text, /新行/);
});

await check('mode=append 但 stream=nope：报错说 kind', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const out = await tools.memory_write.execute({ mode: 'append', stream: 'nope', content: 'x' }, { sessionId: 's' });
  assert.equal(out.ok, false);
  assert.match(String(out.message), /daily|project|流水/);
});

await check('mode=append 缺 content：报错清楚', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const out = await tools.memory_write.execute({ mode: 'append', stream: 'daily' }, { sessionId: 's' });
  assert.equal(out.ok, false);
  assert.match(String(out.message), /content/);
});

await check('vault 路径带中文与空格：写入与索引正常', () => {
  const parent = fresh();
  const vault = join(parent, '我的 记忆 库');
  const created = createMemory({ vaultPath: vault, title: '中文路径', type: 'knowledge', content: 'x' });
  assert.equal(created.ok, true);
  assert.ok(existsSync(created.path));
  writeIndex(vault);
  assert.equal(readState(vault).index.entries.length, 1);
});

await check('/state 的 entries 含 superseded 条目且带 status 字段', async () => {
  const vault = fresh();
  const tools = toolsOf(vault);
  const a = await tools.memory_write.execute({ title: '会被取代', type: 'knowledge', content: 'x' }, { sessionId: 's' });
  await tools.memory_write.execute({ title: '新版', type: 'knowledge', content: 'y', supersedes: a.id }, { sessionId: 's' });
  writeIndex(vault);
  const state = readState(vault);
  const old = state.index.entries.find((entry) => entry.id === a.id);
  assert.ok(old, 'superseded 条目不在 index 里');
  assert.equal(old.status, 'superseded');
});

await check('readStream 不存在的项目：ok=false 且说「还没有」', () => {
  const vault = fresh();
  const read = readStream(vault, { kind: 'project', project: '没写过的项目' });
  assert.equal(read.ok, false);
  assert.match(String(read.message), /还没有/);
});

await check('memory_get 传目录前缀「Experiences/」：能找到或明确失败，不崩', async () => {
  const vault = fresh();
  createMemory({ vaultPath: vault, title: '目录前缀取法', type: 'experience', content: 'x' });
  const tools = toolsOf(vault);
  const out = await tools.memory_get.execute({ id: 'Experiences/' }, { sessionId: 's' });
  assert.equal(typeof out.ok, 'boolean');
});

await check('同 title 不同 type：两个文件互不覆盖', () => {
  const vault = fresh();
  const a = createMemory({ vaultPath: vault, title: '同名跨类型', type: 'knowledge', content: 'A' });
  const b = createMemory({ vaultPath: vault, title: '同名跨类型', type: 'experience', content: 'B' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.path, b.path);
  assert.equal(readFileSync(a.path, 'utf8').includes('同名跨类型'), true);
});

await check('索引写不进去时：md 仍算成功、index=failed、indexError 带原始错误', async () => {
  const vault = fresh();
  // 把 .dsh-memory 挤掉：同名路径先放一个普通文件，mkdir 就会失败
  writeFileSync(join(vault, '.dsh-memory'), 'blocked', 'utf8');
  const tools = toolsOf(vault);
  const args = { title: '索引写不进去', type: 'knowledge', content: 'x' };
  const value = await tools.memory_write.execute(args, { sessionId: 's' });
  assert.equal(value.ok, true);
  assert.equal(value.md, 'ok');
  assert.equal(value.index, 'failed');
  assert.ok(String(value.indexError ?? '').length > 0, 'indexError 是空的');
  const text = tools.memory_write.output.render(args, value)[0].text;
  assert.match(text, /md：ok/);
  assert.match(text, /索引：failed/);
  assert.match(text, /别重写/);
});

await check('vault 指向一个文件（建不了目录）：md=failed 且说原因', async () => {
  const parent = fresh();
  const fake = join(parent, 'not-a-dir');
  writeFileSync(fake, 'x', 'utf8');
  const tools = toolsOf(fake);
  const args = { title: '建不了目录', type: 'knowledge', content: 'x' };
  const value = await tools.memory_write.execute(args, { sessionId: 's' });
  assert.equal(value.ok, false);
  assert.equal(value.md, 'failed');
  const text = tools.memory_write.output.render(args, value)[0].text;
  assert.match(text, /md 没写成/);
});

console.log('');
if (fails.length) {
  console.log(`selftest10：${pass} 项通过，${fails.length} 项失败`);
  for (const [name, message] of fails) console.log(`  - ${name}: ${message}`);
  process.exitCode = 1;
} else {
  console.log(`selftest10：全部通过（${pass} 项）`);
}
