// 自测第二轮：排序/状态/预算/HTTP 写路径/边界值。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { loadMemories } from '../lib/vault.js';
import { buildL0, selectL0, L0_DEFAULTS } from '../lib/l0.js';
import { buildL1, selectL1 } from '../lib/l1.js';
import { createMemory, supersedeMemory } from '../lib/store.js';
import { searchMemories, findMemory } from '../lib/search.js';
import { readState, writeInjection } from '../lib/snapshot.js';
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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'my-selftest2-'));
const writeFile = (rel, body) => {
  const full = path.join(vault, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
};

console.log(`临时 vault：${vault}\n`);

// ---------- L0 排序与预算 ----------
console.log('【1】L0 排序与预算');
for (let i = 0; i < 15; i += 1) {
  writeFile(
    `Decisions/规则${i}.md`,
    `---\nid: mem_rule_${i}\ntype: decision\nstatus: active\ntitle: 规则 ${i}\nimportance: ${60 + i}\npinned: true\nupdated_at: 2026-11-22 10:00:0${i % 10}\n---\n\n## 核心内容\n\n这是第 ${i} 条规则的正文，用来占字数。\n`,
  );
}
await check('超预算时条数 ≤ maxItems 且字数 ≤ maxChars', () => {
  const text = buildL0(loadMemories(vault));
  const lines = text.split('\n').filter((line) => line.startsWith('- ['));
  assert.ok(lines.length <= L0_DEFAULTS.maxItems, `条数 ${lines.length}`);
  assert.ok(text.length <= L0_DEFAULTS.maxChars + 200, `字数 ${text.length}`);
  return { count: lines.length, chars: text.length, footer: text.split('\n').slice(-2)[0] };
});
await check('importance 高者在前', () => {
  const ids = selectL0(loadMemories(vault)).map((m) => m.id);
  // 期望从 mem_rule_14 往前排
  eq(ids[0], 'mem_rule_14', JSON.stringify(ids.slice(0, 3)));
  return ids.slice(0, 3);
});
await check('pinned 但 type 不是 decision/preference 的被排除', () => {
  writeFile('Knowledge/不该进.md', '---\nid: mem_notl0\ntype: knowledge\nstatus: active\ntitle: 不该进 L0\nimportance: 100\npinned: true\n---\n\n正文\n');
  const ids = selectL0(loadMemories(vault)).map((m) => m.id);
  assert.ok(!ids.includes('mem_notl0'));
  return 'ok';
});
await check('status 大写/混合大小写按小写处理（SUPERSEDED 不进 L0）', () => {
  writeFile('Decisions/大写.md', '---\nid: mem_upper\ntype: decision\nstatus: SUPERSEDED\ntitle: 大写状态\nimportance: 100\npinned: true\n---\n\n正文\n');
  writeFile('Decisions/混写.md', '---\nid: mem_mixed\ntype: decision\nstatus: Active\ntitle: 混写状态\nimportance: 99\npinned: true\n---\n\n正文\n');
  const ids = selectL0(loadMemories(vault)).map((m) => m.id);
  return { upperIn: ids.includes('mem_upper'), mixedIn: ids.includes('mem_mixed') };
});

// ---------- importance / confidence 边界 ----------
console.log('\n【2】数值边界');
await check('importance 200 → 夹到 100', () => {
  const r = createMemory({ vaultPath: vault, title: '越界权重', type: 'knowledge', content: 'x', importance: 200, confidence: 5 });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { importance: m?.importance, confidence: m?.confidence };
});
await check('importance -5 → 夹到 0', () => {
  const r = createMemory({ vaultPath: vault, title: '负权重', type: 'knowledge', content: 'x', importance: -5 });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { importance: m?.importance };
});
await check('importance "abc" → 回落 50', () => {
  const r = createMemory({ vaultPath: vault, title: '坏权重', type: 'knowledge', content: 'x', importance: 'abc' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { importance: m?.importance };
});

// ---------- supersede 全链路 ----------
console.log('\n【3】supersede 全链路');
await check('标 superseded 后：检索/L0/L1 都看不到，includeArchived 能看到', () => {
  const r = createMemory({ vaultPath: vault, title: '将被取代的规则', type: 'decision', content: '旧内容', importance: 99, pinned: true });
  assert.equal(searchMemories(loadMemories(vault), { query: '将被取代' }).length, 1);
  const result = supersedeMemory(r.path, 'mem_new_thing');
  assert.equal(result.ok, true);
  const all = loadMemories(vault);
  const archived = searchMemories(all, { query: '将被取代' });
  const withArchived = searchMemories(all, { query: '将被取代', includeArchived: true });
  const inL0 = selectL0(all).some((m) => m.id === r.id);
  const inL1 = selectL1(all, { agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text: '将被取代的规则 旧内容' }] } }] } } }).rows.some((row) => row.memory.id === r.id);
  return { activeHits: archived.length, archivedHits: withArchived.length, inL0, inL1 };
});
await check('旧文件正文没被改动、status 与 superseded_by 写对', () => {
  const r = createMemory({ vaultPath: vault, title: '正文不动检查', type: 'knowledge', content: '这段正文必须一字不改。' });
  const before = fs.readFileSync(r.path, 'utf8').split('---').slice(2).join('---');
  supersedeMemory(r.path, 'mem_other', { now: new Date('2026-11-22T12:00:00Z') });
  const after = fs.readFileSync(r.path, 'utf8');
  const bodyAfter = after.split('---').slice(2).join('---');
  return { bodySame: before === bodyAfter, hasSuperseded: /status: superseded/.test(after), hasBy: after.includes('superseded_by') };
});

// ---------- HTTP 写路径 ----------
console.log('\n【4】HTTP 写路径');
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
const handler = createStateHandler({ vaultPath: vault, budget: 4000 });

await check('POST /supersede 成功并刷新 index', async () => {
  const r = createMemory({ vaultPath: vault, title: 'HTTP 取代测试', type: 'knowledge', content: 'x' });
  const res = await call(handler, 'POST', '/memory-yuan/supersede', JSON.stringify({ id: r.id }));
  const index = readState(vault).index;
  const entry = index?.entries?.find((e) => e.id === r.id);
  return { status: res.status, ok: res.json?.ok, indexStatus: entry?.status };
});
await check('POST /supersede 缺 id / 不存在的 id', async () => {
  const a = await call(handler, 'POST', '/memory-yuan/supersede', JSON.stringify({}));
  const b = await call(handler, 'POST', '/memory-yuan/supersede', JSON.stringify({ id: 'mem_nope' }));
  return { missing: a.status, notFound: b.status };
});
await check('POST body 是数组 / 字符串不崩', async () => {
  const a = await call(handler, 'POST', '/memory-yuan/supersede', '[1,2]');
  const b = await call(handler, 'POST', '/memory-yuan/supersede', '"hi"');
  return { arr: a.status, str: b.status };
});
await check('GET /state 的 index 结构（重建后）', async () => {
  const res = await call(handler, 'GET', '/memory-yuan/state');
  return { status: res.status, entries: res.json?.index?.entries?.length, budget: res.json?.budget };
});
await check('last-inject 写入后能读到', () => {
  writeInjection({ vaultPath: vault, session: 's1', l0: [{ id: 'a', type: 'decision', importance: 90, title: 'x', chars: 10 }], l1: [{ id: 'b', type: 'knowledge', title: 'y', hits: 3, score: 9, matched: ['z'] }], chars: { l0: 10, l1: 20, budget: 4000 } });
  const st = readState(vault);
  return { at: st.lastInject?.at?.slice(0, 10), l0: st.lastInject?.l0?.length, l1: st.lastInject?.l1?.length, chars: st.lastInject?.chars };
});

// ---------- 检索优先级 ----------
console.log('\n【5】检索优先级与其它');
await check('title 命中应排在 body 命中之前', () => {
  writeFile('Knowledge/标题命中.md', '---\nid: mem_title_hit\ntype: knowledge\nstatus: active\ntitle: 向量检索优化\nimportance: 10\n---\n\n## 核心内容\n\n无关正文\n');
  writeFile('Knowledge/正文命中.md', '---\nid: mem_body_hit\ntype: knowledge\nstatus: active\ntitle: 其它条目\nimportance: 99\n---\n\n## 核心内容\n\n这里提到向量检索优化一下\n');
  const rows = searchMemories(loadMemories(vault), { query: '向量检索优化' });
  const order = rows.map((row) => row.id ?? row.memory?.id);
  return { order: order.slice(0, 2) };
});
await check('memory_get 用路径尾巴能找到', async () => {
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const target = loadMemories(vault)[0];
  const r = await tools.memory_get.execute({ id: target.path.split(/[\\/]/).pop() }, {});
  return { ok: r.ok, sameId: r.id === target.id };
});
await check('search 的 tag 过滤要求全部包含', () => {
  const r = createMemory({ vaultPath: vault, title: '标签 A B', type: 'knowledge', content: 'x', tags: ['a', 'b'] });
  const both = searchMemories(loadMemories(vault), { tags: ['a', 'b'] });
  const onlyA = searchMemories(loadMemories(vault), { tags: ['a', 'zzz'] });
  return { both: both.length, onlyA: onlyA.length };
});
await check('findMemory 传完整路径', () => {
  const all = loadMemories(vault);
  const target = all[0];
  const byFull = findMemory(all, target.path);
  return { found: Boolean(byFull), sameId: byFull?.id === target.id };
});

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(`  ✗ ${f.name} → ${f.message}`);
fs.rmSync(vault, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
