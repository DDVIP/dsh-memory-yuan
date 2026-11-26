// 自测：专挑边界与往返一致性，目标是找出真实 bug（不是刷通过率）。
// 全部在临时 vault 里跑，绝不碰真实 vault。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { loadMemories, parseFrontmatter } from '../lib/vault.js';
import { buildL0, renderL0, selectL0 } from '../lib/l0.js';
import { buildL1, collectConversationTexts, grams, scoreByTokens, selectL1, L1_DEFAULTS } from '../lib/l1.js';
import { createMemory, supersedeMemory, makeId, slugify } from '../lib/store.js';
import { searchMemories, findMemory } from '../lib/search.js';
import { markSuperseded, readMemoryText, readState, writeIndex, writeInjection } from '../lib/snapshot.js';
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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'my-selftest-'));
console.log(`临时 vault：${vault}\n`);

// ---------- 1. 写入 → 读取 往返一致性 ----------
console.log('【1】往返一致性');
await check('普通条目往返', () => {
  const r = createMemory({ vaultPath: vault, title: '普通标题', type: 'knowledge', content: '正文一段', tags: ['a', 'b'] });
  assert.equal(r.ok, true);
  const m = loadMemories(vault).find((x) => x.id === r.id);
  eq(m?.title, '普通标题');
  eq(m?.tags, ['a', 'b']);
  return m?.path?.split(/[\\/]/).pop();
});

await check('title 含双引号与反斜杠能否原样读回', () => {
  const title = '带引号 "与反斜杠 \\ 的标题';
  const r = createMemory({ vaultPath: vault, title, type: 'knowledge', content: 'x' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  eq(m?.title, title, `写入 ${JSON.stringify(title)} 读回 ${JSON.stringify(m?.title)}`);
});

await check('title 含换行会被压成单行', () => {
  const r = createMemory({ vaultPath: vault, title: '第一行\n第二行', type: 'knowledge', content: 'x' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  eq(m?.title, '第一行 第二行');
});

await check('tags 含空格与逗号能否原样读回', () => {
  const r = createMemory({ vaultPath: vault, title: '标签测试', type: 'knowledge', content: 'x', tags: ['a b', 'c,d', '中文标签'] });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  eq(m?.tags, ['a b', 'c,d', '中文标签'], JSON.stringify(m?.tags));
});

await check('title 全是非法字符（slug 兜底）', () => {
  const r = createMemory({ vaultPath: vault, title: '???:::   ', type: 'knowledge', content: 'x' });
  assert.equal(r.ok, true);
  const name = r.path.split(/[\\/]/).pop();
  eq(name.startsWith('memory-'), true, name);
  return name;
});

await check('importance 传字符串 "90" 是否正确解析', () => {
  const r = createMemory({ vaultPath: vault, title: '字符串权重', type: 'knowledge', content: 'x', importance: '90' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  eq(m?.importance, 90, `读回 ${JSON.stringify(m?.importance)}`);
});

// ---------- 2. vault 解析容错 ----------
console.log('\n【2】vault 解析容错');
await check('无 frontmatter 的 md 不崩、能读到', () => {
  const dir = path.join(vault, 'Knowledge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plain.md'), '# 裸文件的标题\n\n正文内容\n', 'utf8');
  const all = loadMemories(vault);
  const plain = all.find((m) => m.path.endsWith('plain.md'));
  assert.ok(plain, '裸文件没被加载');
  return { title: plain?.title, type: plain?.type, status: plain?.status };
});

await check('status 大写 SUPERSEDED 是否仍被当 active', () => {
  const dir = path.join(vault, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'upper.md'), '---\ntitle: 大写状态\nstatus: SUPERSEDED\ntype: knowledge\n---\n\n正文\n', 'utf8');
  const m = loadMemories(vault).find((x) => x.path.endsWith('upper.md'));
  return { status: m?.status };
});

await check('frontmatter 未闭合不崩', () => {
  const { data, body } = parseFrontmatter('---\ntitle: 坏文件\n正文没有闭合');
  return { data, bodyLen: body.length };
});

// ---------- 3. 检索 ----------
console.log('\n【3】检索');
await check('空 query 的行为', () => {
  const rows = searchMemories(loadMemories(vault), { query: '' });
  return { count: rows.length };
});
await check('findMemory 空串的行为', () => {
  const hit = findMemory(loadMemories(vault), '');
  return { matched: hit ? hit.title : null };
});
await check('limit=0 / 负数', () => {
  const all = loadMemories(vault);
  const zero = searchMemories(all, { query: '标签', limit: 0 });
  const neg = searchMemories(all, { query: '标签', limit: -3 });
  return { zero: zero.length, neg: neg.length };
});

// ---------- 4. L0 边界 ----------
console.log('\n【4】L0');
await check('pinned 但 type=experience 要排除', () => {
  const r = createMemory({ vaultPath: vault, title: '经验不该进 L0', type: 'experience', content: 'x', pinned: true, importance: 99 });
  const ids = selectL0(loadMemories(vault)).map((m) => m.id);
  return { included: ids.includes(r.id) };
});
await check('空记忆库返回空串', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'my-empty-'));
  return { text: buildL0(loadMemories(empty)) };
});
await check('maxChars 极小不出错', () => {
  const text = buildL0(loadMemories(vault), { maxChars: 10 });
  return { len: text.length, head: text.slice(0, 30) };
});
await check('同一 importance 的排序是否稳定（两次结果一致）', () => {
  const a = selectL0(loadMemories(vault)).map((m) => m.id).join(',');
  const b = selectL0(loadMemories(vault)).map((m) => m.id).join(',');
  eq(a, b);
  return { count: a.split(',').filter(Boolean).length };
});

// ---------- 5. L1 边界 ----------
console.log('\n【5】L1');
await check('context 为 undefined / 空对象', () => {
  eq(collectConversationTexts(undefined), []);
  eq(collectConversationTexts({}), []);
  return 'ok';
});
await check('eventsSnapshot 里 content 是字符串而不是数组', () => {
  const ctx = { agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: '裸字符串内容' } }] } } };
  return { texts: collectConversationTexts(ctx) };
});
await check('content 里 text 是数字', () => {
  const ctx = { agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text: 42 }] } }] } } };
  return { texts: collectConversationTexts(ctx) };
});
await check('excludeIds 生效', () => {
  const all = loadMemories(vault);
  const ctx = { agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text: '标签测试 中文标签' }] } }] } } };
  const first = selectL1(all, ctx);
  const excluded = new Set(first.rows.map((r) => r.memory.id));
  const second = selectL1(all, ctx, { excludeIds: excluded });
  return { before: first.rows.length, after: second.rows.length };
});
await check('grams 空串 / 纯标点', () => {
  return { empty: grams(''), punct: grams('。。。！！！') };
});
await check('极小阈值下 scoreByTokens 不崩', () => {
  const m = loadMemories(vault)[0];
  return scoreByTokens(m, []);
});

// ---------- 6. snapshot ----------
console.log('\n【6】snapshot');
await check('vault 目录不存在时 writeIndex 的行为', () => {
  const missing = path.join(os.tmpdir(), 'my-not-exist-' + Date.now(), 'deeper');
  try {
    writeIndex(missing);
    return { exists: fs.existsSync(path.join(missing, '.dsh-memory', 'index.json')) };
  } catch (error) {
    return { threw: error?.code ?? error?.message };
  }
});
await check('readState 在没有 index 时', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'my-fresh-'));
  const st = readState(fresh);
  return { lastInject: st?.lastInject, indexKeys: st?.index ? Object.keys(st.index) : null };
});
await check('markSuperseded 不存在的 id', () => markSuperseded(vault, 'mem_nope')?.ok);
await check('readMemoryText 用路径尾部查找', () => {
  const all = loadMemories(vault);
  const target = all[0];
  const byTail = readMemoryText(vault, target.path.split(/[\\/]/).pop());
  return { found: Boolean(byTail) };
});

// ---------- 7. HTTP 层 ----------
console.log('\n【7】HTTP 层');
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
    headers: null,
    chunks: [],
    writeHead(code, headers) { res.statusCode = code; res.headers = headers; },
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
const handler = createStateHandler({ vaultPath: vault, budget: 1234 });
await check('GET /memory-yuan/state 返回结构', async () => {
  const r = await call(handler, 'GET', '/memory-yuan/state');
  return { status: r.status, hasLastInject: r.json?.lastInject !== undefined, budget: r.json?.budget };
});
await check('GET /memory 缺 id 参数', async () => {
  const r = await call(handler, 'GET', '/memory-yuan/memory');
  return { status: r.status };
});
await check('GET /memory?id=不存在', async () => {
  const r = await call(handler, 'GET', '/memory-yuan/memory?id=mem_nope');
  return { status: r.status };
});
await check('POST /supersede body 不是 JSON', async () => {
  const r = await call(handler, 'POST', '/memory-yuan/supersede', 'not-json');
  return { status: r.status };
});
await check('未知路径', async () => {
  const r = await call(handler, 'GET', '/memory-yuan/nope');
  return { status: r.status };
});

// ---------- 8. 工具层 ----------
console.log('\n【8】工具层');
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
await check('memory_search limit=0 / 负数', async () => {
  const zero = await tools.memory_search.execute({ query: '标签', limit: 0 }, {});
  const neg = await tools.memory_search.execute({ query: '标签', limit: -3 }, {});
  return { zero: zero.rows.length, neg: neg.rows.length };
});
await check('memory_write importance 越界 200 会不会被限住', async () => {
  const r = await tools.memory_write.execute({ title: '越界权重', type: 'knowledge', content: 'x', importance: 200 }, {});
  return { importance: r.importance };
});
await check('memory_write 缺 content', async () => {
  const r = await tools.memory_write.execute({ title: '缺正文', type: 'knowledge' }, {});
  return { ok: r.ok, message: r.message };
});
await check('memory_get 不存在的 id 渲染', async () => {
  const r = await tools.memory_get.execute({ id: 'mem_nope' }, {});
  const rendered = tools.memory_get.output.render({}, r);
  return { ok: r.ok, rendered: Array.isArray(rendered) ? rendered[0]?.text?.slice(0, 40) : rendered };
});
await check('memory_search 空结果的渲染', async () => {
  const r = await tools.memory_search.execute({ query: '绝对不存在的词xyzzy' }, {});
  const rendered = tools.memory_search.output.render({}, r);
  return { rows: r.rows.length, rendered: Array.isArray(rendered) ? rendered[0]?.text : rendered };
});
await check('工具 schema 与返回值字段一致（additionalProperties）', async () => {
  const r = await tools.memory_search.execute({ query: '标签' }, {});
  const schema = tools.memory_search.output.schema;
  const rowSchema = schema.properties.rows.items;
  const bad = [];
  for (const row of r.rows) {
    for (const key of Object.keys(row)) if (!(key in rowSchema.properties)) bad.push(key);
  }
  const topBad = Object.keys(r).filter((key) => !(key in schema.properties));
  return { topBad, rowBad: [...new Set(bad)] };
});

// ---------- 9. 并发写同名 ----------
console.log('\n【9】并发/重复');
await check('同标题连写两次不互相覆盖', async () => {
  const a = await tools.memory_write.execute({ title: '同名条目', type: 'knowledge', content: 'A' }, {});
  const b = await tools.memory_write.execute({ title: '同名条目', type: 'knowledge', content: 'B' }, {});
  return { samePath: a.path === b.path, files: [a.path, b.path].filter((p) => fs.existsSync(p)).length };
});

// ---------- 汇总 ----------
console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
for (const f of failures) console.log(`  ✗ ${f.name} → ${f.message}`);
fs.rmSync(vault, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
