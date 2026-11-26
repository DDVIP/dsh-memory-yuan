// 第四轮自测：盯「三处数据源是否一致」——磁盘文件、index.json、last-inject.json、UI 契约。
// 前几轮查的是单点行为，这一轮查的是它们之间会不会互相撒谎。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { loadMemories } from '../lib/vault.js';
import { buildL0, renderL0, selectL0 } from '../lib/l0.js';
import { buildL1, collectConversationTexts, selectL1 } from '../lib/l1.js';
import { createMemory, makeId, supersedeMemory } from '../lib/store.js';
import { findMemory, searchMemories } from '../lib/search.js';
import { l0Snapshot, l1Snapshot, markSuperseded, readState, writeIndex, writeInjection, stateDir, charCount } from '../lib/snapshot.js';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `my4-${tag}-`));
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

const vault = freshVault('consistency');
const handler = createStateHandler({ vaultPath: vault, budget: 4000 });

// ================= 1. 三处数据源一致 =================
console.log('【1】磁盘 / index.json / last-inject.json 是否互相一致');
const decision = createMemory({ vaultPath: vault, title: '三处一致：决策条', type: 'decision', content: '这条必须同时出现在磁盘、索引、注入快照里', importance: 88, pinned: true, tags: ['一致性'] });
const knowledge = createMemory({ vaultPath: vault, title: '三处一致：知识条', type: 'knowledge', content: '带线索的知识', importance: 40, tags: ['一致性'] });
{
  const mems = loadMemories(vault);
  const selected = selectL0(mems);
  const context = userTurn('三处一致 决策条 索引 注入快照');
  const { rows } = selectL1(mems, context, { maxItems: 4 });
  const l0Text = renderL0(selected);
  const l1Text = buildL1(mems, context, { maxItems: 4 });
  writeIndex(vault);
  writeInjection({ vaultPath: vault, session: 'session-test', l0: l0Snapshot(selected), l1: l1Snapshot(rows), chars: { l0: charCount(l0Text), l1: charCount(l1Text), budget: 4000 } });

  await check('last-inject 里的每个 l0/l1 id 都能在 index.json 里找到', () => {
    const state = readState(vault);
    const ids = new Set(state.index.entries.map((e) => e.id));
    const missing = [...(state.lastInject.l0 ?? []), ...(state.lastInject.l1 ?? [])].filter((x) => !ids.has(x.id));
    eq(missing, []);
    return { l0: state.lastInject.l0.length, l1: state.lastInject.l1.length, index: ids.size };
  });
  await check('last-inject 的 chars 与实际注入文本长度一致（按码点）', () => {
    const state = readState(vault);
    eq(state.lastInject.chars.l0, charCount(l0Text));
    eq(state.lastInject.chars.l1, charCount(l1Text));
    return state.lastInject.chars;
  });
  await check('index 里每条 path 都真实存在（索引不指向幽灵文件）', () => {
    const state = readState(vault);
    const ghost = state.index.entries.filter((e) => !fs.existsSync(e.path));
    eq(ghost.map((e) => e.id), []);
    return state.index.entries.length;
  });
  await check('/state 返回的 lastInject 与磁盘文件一致（at 相同）', async () => {
    const disk = JSON.parse(fs.readFileSync(path.join(stateDir(vault), 'last-inject.json'), 'utf8'));
    const res = await call(handler, 'GET', '/memory-yuan/state');
    eq(res.json.lastInject.at, disk.at);
    return disk.at;
  });
}

// ================= 2. supersede 后四处同时变化 =================
console.log('\n【2】supersede 之后：磁盘、索引、L0、L1、UI 五处都要同步');
{
  const mems = loadMemories(vault);
  const context = userTurn('三处一致：决策条 这条必须同时出现在');
  const before = selectL1(mems, context, { maxItems: 8 }).rows.some((r) => r.memory.id === decision.id);
  await check('取代前：L1 命中、L0 有它', () => {
    assert.equal(before, true);
    assert.ok(selectL0(mems).some((m) => m.id === decision.id));
    return { before };
  });
  const result = supersedeMemory(decision.path, knowledge.id);
  writeIndex(vault);
  const mems2 = loadMemories(vault);
  await check('取代后：磁盘 status=superseded、正文没动', () => {
    assert.equal(result.ok, true);
    const raw = fs.readFileSync(decision.path, 'utf8');
    assert.match(raw, /status: superseded/);
    assert.match(raw, /这条必须同时出现在磁盘、索引、注入快照里/);
    return true;
  });
  await check('取代后：L0 不再注入、L1 不再命中、默认检索不到', () => {
    eq(selectL0(mems2).some((m) => m.id === decision.id), false);
    eq(selectL1(mems2, context, { maxItems: 8 }).rows.some((r) => r.memory.id === decision.id), false);
    eq(searchMemories(mems2, { query: '三处一致 决策条' }).some((row) => row.memory.id === decision.id), false);
  });
  await check('取代后：index 里 status=superseded、UI /state 也能看到', async () => {
    const res = await call(handler, 'GET', '/memory-yuan/state');
    const entry = res.json.index.entries.find((e) => e.id === decision.id);
    return { status: entry?.status };
  });
  await check('再标一次 superseded：幂等，不报错、status 不变', () => {
    const again = markSuperseded(vault, decision.id, { now: new Date('2026-11-22T09:00:00Z') });
    const raw = fs.readFileSync(decision.path, 'utf8');
    return { ok: again.ok, stillSuperseded: /status: superseded/.test(raw) };
  });
}

// ================= 3. 并发与路径 =================
console.log('\n【3】并发写、路径怪字符');
const v3 = freshVault('bulk');
await check('一口气写 10 条：10 个文件都在、id 不重复', () => {
  const results = [];
  for (let i = 0; i < 10; i += 1) results.push(createMemory({ vaultPath: v3, title: `批量第 ${i} 条`, type: 'knowledge', content: `c${i}` }));
  const ids = new Set(results.map((r) => r.id));
  const files = results.filter((r) => fs.existsSync(r.path));
  return { ids: ids.size, files: files.length };
});
await check('同标题不同 type：落在不同目录、互不覆盖', () => {
  const a = createMemory({ vaultPath: v3, title: '同名跨类型', type: 'knowledge', content: 'k' });
  const b = createMemory({ vaultPath: v3, title: '同名跨类型', type: 'experience', content: 'e' });
  return { aDir: path.basename(path.dirname(a.path)), bDir: path.basename(path.dirname(b.path)), both: fs.existsSync(a.path) && fs.existsSync(b.path) };
});
await check('vaultPath 带中文和空格：照样写得进、读得出', () => {
  const weird = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'my4-weird-')), '渊 的 库');
  fs.mkdirSync(weird, { recursive: true });
  const r = createMemory({ vaultPath: weird, title: '中文路径', type: 'knowledge', content: 'x' });
  const m = loadMemories(weird).find((x) => x.id === r.id);
  return { ok: r.ok, found: Boolean(m) };
});
await check('findMemory 用完整路径（Windows 反斜杠）也找得到', () => {
  const r = createMemory({ vaultPath: v3, title: '路径查找', type: 'knowledge', content: 'x' });
  return { byAbs: findMemory(loadMemories(v3), r.path)?.id === r.id, byName: findMemory(loadMemories(v3), path.basename(r.path))?.id === r.id };
});
await check('findMemory 传大写 id：大小写不敏感', () => {
  const r = createMemory({ vaultPath: v3, title: '大小写 id', type: 'knowledge', content: 'x' });
  return { ok: findMemory(loadMemories(v3), r.id.toUpperCase())?.id === r.id };
});

// ================= 4. 对话线索的取样上限 =================
console.log('\n【4】对话线索取样');
await check('100 条 user 消息：只取最后 10 条（不把整段历史都当线索）', () => {
  const events = [];
  for (let i = 0; i < 100; i += 1) events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第 ${i} 句` }] } });
  const texts = collectConversationTexts({ agent: { session: { eventsSnapshot: events } } });
  return { count: texts.length, first: texts[0], last: texts.at(-1) };
});
await check('注入块（system-reminder）混在 user 消息里也不被当线索', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>\n记忆插件 索引 dsh' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '真正的用户问题：索引里为什么没有这条' }] } },
  ];
  const texts = collectConversationTexts({ agent: { session: { eventsSnapshot: events } } });
  return { texts };
});

// ================= 5. 工具输出契约 =================
console.log('\n【5】工具 execute 返回值必须严格落在 output.schema 里');
{
  const tools = Object.fromEntries(createTools({ vaultPath: v3 }).map((t) => [t.name, t]));
  await check('三个工具的 execute 返回值没有 schema 外字段', async () => {
    const w = await tools.memory_write.execute({ title: '契约检查', type: 'knowledge', content: 'x', tags: ['契约'] }, {});
    const s = await tools.memory_search.execute({ query: '契约' }, {});
    const g = await tools.memory_get.execute({ id: w.id }, {});
    const rows = s.rows ?? [];
    const problems = [];
    const watch = [['memory_write', tools.memory_write, w], ['memory_search', tools.memory_search, s], ['memory_get', tools.memory_get, g]];
    for (const [name, tool, value] of watch) {
      const props = Object.keys(tool.output.schema.properties ?? {});
      const extra = Object.keys(value ?? {}).filter((k) => !props.includes(k));
      if (extra.length) problems.push(`${name}: ${extra.join(',')}`);
    }
    const rowProps = Object.keys(tools.memory_search.output.schema.properties.rows.items.properties ?? {});
    const rowExtra = rows.flatMap((row) => Object.keys(row).filter((k) => !rowProps.includes(k)));
    if (rowExtra.length) problems.push(`rows[]: ${[...new Set(rowExtra)].join(',')}`);
    eq(problems, []);
    return { rows: rows.length };
  });
  await check('memory_get 对不存在的 id：ok=false 且 message 说得清', async () => {
    const g = await tools.memory_get.execute({ id: 'mem_not_exist' }, {});
    return { ok: g.ok, message: g.message };
  });
}

// ================= 6. 会话 id 与来源 =================
console.log('\n【6】来源会话记录');
await check('memory_write 带 source_sessions：写进 frontmatter', async () => {
  const tools = Object.fromEntries(createTools({ vaultPath: v3 }).map((t) => [t.name, t]));
  const w = await tools.memory_write.execute({ title: '来源会话', type: 'knowledge', content: 'x', source_sessions: ['session-a', 'session-b'] }, {});
  const raw = fs.readFileSync(w.path, 'utf8');
  return { hasA: raw.includes('session-a'), hasB: raw.includes('session-b') };
});
await check('memory_write 不传 source_sessions：不写入空值、不报错', async () => {
  const tools = Object.fromEntries(createTools({ vaultPath: v3 }).map((t) => [t.name, t]));
  const w = await tools.memory_write.execute({ title: '无来源会话', type: 'knowledge', content: 'x' }, {});
  const raw = fs.readFileSync(w.path, 'utf8');
  return { ok: w.ok, sourcesLine: /source_sessions:.*/.exec(raw)?.[0] ?? '(none)' };
});

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(` ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
