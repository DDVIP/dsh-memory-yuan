// 第三轮自测：先忠实复现 room/给记忆插件的-bug-报告.md 那条 bug，再把「写进去」和「记得住」之间的每个环节挨个戳一遍。
// 全部在临时 vault 里跑，绝不碰真实 vault。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { loadMemories } from '../lib/vault.js';
import { buildL0, countL0Candidates, renderL0, selectL0 } from '../lib/l0.js';
import { buildL1, grams, selectL1 } from '../lib/l1.js';
import { MEMORY_TYPES, createMemory, makeId, slugify, supersedeMemory } from '../lib/store.js';
import { findMemory, searchMemories } from '../lib/search.js';
import { markSuperseded, readMemoryText, readState, writeIndex } from '../lib/snapshot.js';
import { createStateHandler } from '../lib/api.js';
import { createTools } from '../lib/tools.js';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  ✓ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`  ✗ ${name} → ${error?.message ?? error}`);
  }
}
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
}

function freshVault(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `my3-${tag}-`));
  return dir;
}

function mockReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}
function mockRes() {
  const res = {
    statusCode: 0,
    chunks: [],
    writeHead(code) { res.statusCode = code; },
    write(chunk) { res.chunks.push(String(chunk)); },
    end(chunk) { if (chunk) res.chunks.push(String(chunk)); res.body = res.chunks.join(''); },
  };
  return res;
}
async function call(handler, method, url, body) {
  const res = mockRes();
  await handler(mockReq(method, url, body), res);
  return { status: res.statusCode, json: (() => { try { return JSON.parse(res.body); } catch { return res.body; } })() };
}

const userTurn = (text) => ({ agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }] } } });

// ================= 1. 忠实复现 bug 报告 =================
console.log('【1】bug 报告复现：写入成功的记忆，能不能被检索/索引/注入三处同时看见');
const vault = freshVault('report');
{
  const title = '唯一写入源：vault 文件，旧 memory 工具只留流水';
  const content = '长期事实一律写 vault 文件；改就新建并把旧的标 superseded。';
  const r = createMemory({ vaultPath: vault, title, type: 'decision', content, importance: 92, pinned: true });
  await check('报告场景：写盘成功，md 在、返回带 id', () => {
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(r.path), true);
    return path.basename(r.path);
  });
  await check('报告场景：writeIndex 后 index.json 里含这条 id（原 bug 里是 0 命中）', () => {
    writeIndex(vault);
    const state = readState(vault);
    const hits = state.index.entries.filter((e) => e.id === r.id);
    eq(hits.length, 1);
    return { total: state.index.entries.length };
  });
  await check('报告场景：memory_search 能搜到这条', () => {
    const hits = searchMemories(loadMemories(vault), { query: '唯一写入源 vault' });
    assert.ok(hits.some((row) => row.memory.id === r.id), `命中 ${hits.length} 条`);
    return hits.length;
  });
  await check('报告场景：同一轮线索能被 L1 命中（原 bug 里 L1 搜不到）', () => {
    const { rows } = selectL1(loadMemories(vault), userTurn('记忆的唯一写入源改成 vault 文件了，旧的 memory 工具只留流水'));
    assert.ok(rows.some((row) => row.memory.id === r.id), `L1 命中：${rows.map((x) => x.memory.title).join(' / ')}`);
    return rows.map((row) => `${row.memory.type}:${row.memory.id}`);
  });
  await check('报告场景：这轮 L0 里也有它（pinned decision）', () => {
    const selected = selectL0(loadMemories(vault));
    assert.ok(selected.some((m) => m.id === r.id));
    return selected.length;
  });
  await check('报告场景：index.json 删掉后 L1 仍能命中（L1 扫文件、不依赖索引）', () => {
    fs.rmSync(path.join(vault, '.dsh-memory', 'index.json'), { force: true });
    const { rows } = selectL1(loadMemories(vault), userTurn('唯一写入源 vault 文件'));
    return { stillHits: rows.some((row) => row.memory.id === r.id) };
  });
  await check('报告场景：memory_write 渲染文案必须说「已写入」而不是失败', () => {
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
    return (async () => {
      const args = { title: '渲染文案验收', type: 'knowledge', content: 'x' };
      const value = await tools.memory_write.execute(args, {});
      const blocks = tools.memory_write.output.render(args, value);
      const text = blocks.map((b) => b.text).join('\n');
      assert.match(text, /已写入/);
      assert.doesNotMatch(text, /写入失败/);
      return text.split('\n')[0];
    })();
  });
}

// ================= 2. 文件层边界 =================
console.log('\n【2】文件层边界');
const v2 = freshVault('files');
await check('同标题连写两次：id 不同、两份文件都在', () => {
  const a = createMemory({ vaultPath: v2, title: '同名连写', type: 'knowledge', content: 'a' });
  const b = createMemory({ vaultPath: v2, title: '同名连写', type: 'knowledge', content: 'b' });
  assert.notEqual(a.id, b.id);
  assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
  return [a.id, b.id];
});
await check('手写两条同 id 的文件：不崩，findMemory 拿第一条', () => {
  const dir = path.join(v2, 'Knowledge');
  fs.mkdirSync(dir, { recursive: true });
  const body = (title) => `---\nid: mem_dup\ntype: knowledge\nstatus: active\ntitle: ${title}\n---\n\n## 核心内容\n\n同 id 两份\n`;
  fs.writeFileSync(path.join(dir, 'dup-a.md'), body('同 id 甲'), 'utf8');
  fs.writeFileSync(path.join(dir, 'dup-b.md'), body('同 id 乙'), 'utf8');
  const all = loadMemories(v2).filter((m) => m.id === 'mem_dup');
  const found = findMemory(loadMemories(v2), 'mem_dup');
  return { count: all.length, picked: found?.title };
});
await check('frontmatter 没写 id：能读出来（不因缺 id 整条消失）', () => {
  const dir = path.join(v2, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'no-id.md'), '---\ntype: knowledge\nstatus: active\ntitle: 没有 id 的记忆\n---\n\n## 核心内容\n\nx\n', 'utf8');
  const all = loadMemories(v2);
  const m = all.find((x) => x.title === '没有 id 的记忆');
  return { found: Boolean(m), id: m?.id };
});
await check('BOM 开头的文件：标题不带 BOM', () => {
  const dir = path.join(v2, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'bom.md'), '\uFEFF---\nid: mem_bom\ntype: knowledge\nstatus: active\ntitle: BOM 标题\n---\n\n## 核心内容\n\nx\n', 'utf8');
  const m = loadMemories(v2).find((x) => x.id === 'mem_bom');
  return { title: m?.title, startsWithBom: String(m?.title ?? '').charCodeAt(0) === 0xfeff };
});
await check('CRLF 文件：frontmatter 仍能解析', () => {
  const dir = path.join(v2, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'crlf.md'), '---\r\nid: mem_crlf\r\ntype: knowledge\r\nstatus: active\r\ntitle: CRLF 标题\r\n---\r\n\r\n## 核心内容\r\n\r\nx\r\n', 'utf8');
  const m = loadMemories(v2).find((x) => x.id === 'mem_crlf');
  return { found: Boolean(m), title: m?.title };
});
await check('200KB 正文：读得出来、不截断', () => {
  const big = '大'.repeat(200 * 1024);
  const r = createMemory({ vaultPath: v2, title: '大正文', type: 'knowledge', content: big });
  const m = loadMemories(v2).find((x) => x.id === r.id);
  return { contentLen: m?.body?.length, expected: big.length };
});

// ================= 3. 注入层边界 =================
console.log('\n【3】注入层边界（L0/L1 的极端参数）');
const v3 = freshVault('inject');
for (let i = 0; i < 3; i += 1) {
  createMemory({ vaultPath: v3, title: `pinned 第 ${i} 条`, type: 'decision', content: `规矩 ${i}`, importance: 90 - i, pinned: true });
}
await check('L0 maxChars=10：不崩，返回空或只剩 footer', () => {
  const text = buildL0(loadMemories(v3), { maxChars: 10 });
  return { len: text.length, head: text.slice(0, 30) };
});
await check('L0 maxItems=0：返回空字符串', () => {
  const text = buildL0(loadMemories(v3), { maxItems: 0 });
  assert.equal(text, '');
});
await check('L0 候选数统计（countL0Candidates）与实际注入条数对得上', () => {
  const mems = loadMemories(v3);
  const candidates = countL0Candidates(mems);
  const selected = selectL0(mems, { maxItems: 2 });
  return { candidates, selected: selected.length };
});
await check('L1 maxItems=0：不注入', () => {
  const text = buildL1(loadMemories(v3), userTurn('pinned 第 0 条 规矩'), { maxItems: 0 });
  assert.equal(text, '');
});
await check('L1 minScore 极大：不注入', () => {
  const text = buildL1(loadMemories(v3), userTurn('pinned 第 0 条 规矩'), { minScore: 1e9 });
  assert.equal(text, '');
});
await check('memory_search limit=0 / limit=1000：不崩', () => {
  const mems = loadMemories(v3);
  return { zero: searchMemories(mems, { query: '规矩', limit: 0 }).length, huge: searchMemories(mems, { query: '规矩', limit: 1000 }).length };
});

// ================= 4. HTTP 边界 =================
console.log('\n【4】HTTP 边界');
const v4 = freshVault('http');
const handler = createStateHandler({ vaultPath: v4, budget: 4000 });
const target = createMemory({ vaultPath: v4, title: 'HTTP 目标 标题', type: 'knowledge', content: 'x' });
await check('GET /memory 的 id 做 URL 编码（中文+空格）能取到', async () => {
  const res = await call(handler, 'GET', `/memory-yuan/memory?id=${encodeURIComponent(target.id)}`);
  return { status: res.status, hasText: Boolean(res.json?.text) };
});
await check('GET /memory 传多个 id 参数：取第一个，不 500', async () => {
  const res = await call(handler, 'GET', `/memory-yuan/memory?id=${target.id}&id=mem_nope`);
  return { status: res.status };
});
await check('POST body 不是 JSON：400 且不崩', async () => {
  const res = await call(handler, 'POST', '/memory-yuan/supersede', 'not-json{{{');
  return { status: res.status, error: res.json?.error };
});
await check('index.json 被写坏（截断 JSON）：GET /state 仍 200 并重建', async () => {
  fs.mkdirSync(path.join(v4, '.dsh-memory'), { recursive: true });
  fs.writeFileSync(path.join(v4, '.dsh-memory', 'index.json'), '{"at":"x","entries":[', 'utf8');
  const res = await call(handler, 'GET', '/memory-yuan/state');
  return { status: res.status, entries: res.json?.index?.entries?.length };
});
await check('GET /state 的 l0/l1 形状符合 UI 契约', async () => {
  const res = await call(handler, 'GET', '/memory-yuan/state');
  const { lastInject, index, budget } = res.json ?? {};
  return { budget, hasLastInject: Boolean(lastInject), entries: index?.entries?.length };
});

// ================= 5. 工具层边界 =================
console.log('\n【5】工具层边界');
const v5 = freshVault('tools');
const tools = Object.fromEntries(createTools({ vaultPath: v5 }).map((t) => [t.name, t]));
function assertOutputShape(tool, value) {
  const props = Object.keys(tool.output.schema.properties ?? {});
  const extra = Object.keys(value ?? {}).filter((k) => !props.includes(k));
  assert.deepEqual(extra, [], `多余字段：${extra.join(',')}`);
}
await check('memory_write 非法 type：ok=false 且带 message', async () => {
  const value = await tools.memory_write.execute({ title: 'x', type: '日记', content: 'y' }, {});
  assert.equal(value.ok, false);
  assert.match(String(value.message), /不认的 type/);
  assertOutputShape(tools.memory_write, value);
});
await check('memory_write supersedes 指向不存在 id：仍 ok=true + 提示', async () => {
  const value = await tools.memory_write.execute({ title: '取代不存在', type: 'knowledge', content: 'x', supersedes: 'mem_nope' }, {});
  assert.equal(value.ok, true);
  assert.match(String(value.message ?? ''), /不存在的|没找到|找不到/);
  assertOutputShape(tools.memory_write, value);
});
await check('memory_search type 大小写：Knowledge 也应搜到 knowledge', async () => {
  await tools.memory_write.execute({ title: '大小写类型', type: 'knowledge', content: '大小写测试' }, {});
  const lower = await tools.memory_search.execute({ query: '大小写', type: 'knowledge' }, {});
  const upper = await tools.memory_search.execute({ query: '大小写', type: 'Knowledge' }, {});
  return { lower: lower.rows?.length, upper: upper.rows?.length };
});
await check('memory_get 传文件名（带 .md）能取到', async () => {
  const w = await tools.memory_write.execute({ title: '文件名查找', type: 'knowledge', content: 'x' }, {});
  const byId = await tools.memory_get.execute({ id: w.id }, {});
  const file = path.basename(w.path);
  const byFile = await tools.memory_get.execute({ id: file }, {});
  return { byId: byId.ok, byFile: byFile.ok };
});
await check('memory_search 空 query 但带 tags：按 tag 能搜到', async () => {
  await tools.memory_write.execute({ title: '标签检索目标', type: 'knowledge', content: 'x', tags: ['标签检索'] }, {});
  const value = await tools.memory_search.execute({ query: '', tags: ['标签检索'] }, {});
  return { rows: value.rows?.length };
});
await check('每个工具的 output.render 都返回 [{type:text,text}] 且非空', async () => {
  const w = await tools.memory_write.execute({ title: '渲染形状', type: 'knowledge', content: 'x' }, {});
  const s = await tools.memory_search.execute({ query: '渲染' }, {});
  const g = await tools.memory_get.execute({ id: w.id }, {});
  const out = [['memory_write', tools.memory_write, w], ['memory_search', tools.memory_search, s], ['memory_get', tools.memory_get, g]];
  for (const [name, tool, value] of out) {
    const blocks = tool.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} render 返回空`);
    assert.equal(blocks[0].type, 'text');
    assert.ok(String(blocks[0].text).length > 0, `${name} render 文本为空`);
  }
  return 'ok';
});

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(` ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
