/**
 * 待办5 的自测：流水来源标记 / 状态四态 / 证据 / 时效 / 读取计数 / 体检单。
 *
 * 全部在 mkdtemp 临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { createMemory, recordRead, setMemoryStatus } from '../lib/store.js';
import { loadMemories, readMemoryFile } from '../lib/vault.js';
import { selectL0 } from '../lib/l0.js';
import { selectL1 } from '../lib/l1.js';
import { appendStream } from '../lib/stream.js';
import { readDaily, writeSummary } from '../lib/digest.js';
import { buildReview } from '../lib/review.js';
import { createStateHandler } from '../lib/api.js';

const DAY = 24 * 60 * 60 * 1000;
let pass = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

function newVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-5-'));
}

function contextWith(text) {
  return {
    agent: {
      session: {
        eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }],
      },
    },
  };
}

function makeReq({ method = 'GET', url, body } = {}) {
  const req = { method, url };
  req.on = (event, cb) => {
    if (event === 'data' && body !== undefined) setTimeout(() => cb(Buffer.from(JSON.stringify(body))), 0);
    if (event === 'end') setTimeout(cb, 1);
    return req;
  };
  return req;
}

function makeRes() {
  const res = { status: 0, body: '' };
  res.writeHead = (status) => {
    res.status = status;
  };
  res.end = (chunk) => {
    res.body = String(chunk ?? '');
  };
  return res;
}

async function callApi(handler, options) {
  const res = makeRes();
  await handler(makeReq(options), res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

// ---------- 1) 流水来源标记 ----------
const vault = newVault();
await check('appendStream 带 by：行里出现 [插件] 标记', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '收盘没跑成', by: '插件', at: new Date('2026-11-23T09:05:00') });
  assert.equal(out.ok, true);
  assert.equal(out.line, '- 09:05 [插件] 收盘没跑成');
});

await check('appendStream 不带 by：不写方括号，旧格式兼容', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '开机', at: new Date('2026-11-23T09:06:00') });
  assert.match(out.line, /^- 09:06 开机$/);
});

await check('readDaily 的 items 解析出 by：无标记按「家里」算', async () => {
  appendStream({ vaultPath: vault, kind: 'daily', content: '工作上的事', by: '工作', at: new Date('2026-11-23T09:07:00') });
  const daily = readDaily(vault, '2026-11-23');
  assert.equal(daily.ok, true);
  const byPlugin = daily.items.find((item) => item.text.includes('收盘没跑成'));
  const byHome = daily.items.find((item) => item.text === '开机');
  const byWork = daily.items.find((item) => item.text === '工作上的事');
  assert.equal(byPlugin.by, '插件');
  assert.equal(byHome.by, '家里');
  assert.equal(byWork.by, '工作');
});

await check('收盘摘要不带来源标记（句子里的 [插件] 会被剥掉）', () => {
  const written = writeSummary(vault, { date: '2026-11-23', sentences: ['[插件] 第一句写完了。', '第二句也写完了。', '第三句收尾。'] });
  assert.equal(written.ok, true);
  const text = fs.readFileSync(written.path, 'utf8');
  assert.ok(!text.includes('[插件]'), '摘要里不该留标记');
  assert.ok(text.includes('第一句写完了。'));
});

// ---------- 2) 状态四态 ----------
const toolsFor = (vaultPath) => Object.fromEntries(createTools({ vaultPath }).map((tool) => [tool.name, tool]));

await check('memory_write 默认写 candidate，落 Inbox/', async () => {
  const tools = toolsFor(vault);
  const out = await tools.memory_write.execute({ title: '默认候选', type: 'knowledge', content: '还等人确认' }, {});
  assert.equal(out.ok, true);
  assert.match(out.path, /Inbox/);
  const file = readMemoryFile(out.path, vault);
  assert.equal(file.status, 'candidate');
});

await check('memory_write 写 verified 不带 confirm 会被拒', async () => {
  const tools = toolsFor(vault);
  const out = await tools.memory_write.execute({ title: '偷偷盖章', type: 'knowledge', content: 'x', status: 'verified' }, {});
  assert.equal(out.ok, false);
  assert.match(out.message, /confirm/);
});

await check('memory_write 写 verified 带 confirm:true 才放行', async () => {
  const tools = toolsFor(vault);
  const out = await tools.memory_write.execute(
    { title: '人确认过的一条', type: 'decision', content: '定下来了', status: 'verified', confirm: true, pinned: true },
    {},
  );
  assert.equal(out.ok, true);
  assert.equal(readMemoryFile(out.path, vault).status, 'verified');
});

await check('L0 只收 verified：candidate 的 pinned 条目不进 L0', async () => {
  const v = newVault();
  const verified = createMemory({ vaultPath: v, title: '确认过的规矩', type: 'decision', content: '这条要进 L0', importance: 90, pinned: true, status: 'verified' });
  createMemory({ vaultPath: v, title: '候选的规矩', type: 'decision', content: '这条先不进 L0', importance: 95, pinned: true, status: 'candidate' });
  const memories = loadMemories(v);
  const selected = selectL0(memories);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, verified.id);
});

await check('disputed 不进 L0，也不进 L1', async () => {
  const v = newVault();
  const created = createMemory({ vaultPath: v, title: '记忆插件收盘校验有争议', type: 'knowledge', content: '记忆插件 收盘 校验', tags: ['记忆插件', '收盘'], status: 'verified' });
  const memory = loadMemories(v).find((m) => m.id === created.id);
  assert.equal(memory.status, 'verified');
  setMemoryStatus(memory.path, 'disputed');
  const memories = loadMemories(v);
  assert.equal(selectL0(memories).length, 0);
  const l1 = selectL1(memories, contextWith('记忆插件的收盘校验要怎么改？记忆插件 收盘'));
  assert.equal(l1.rows.length, 0);
});

await check('旧文件里的 status: active 读出来视作 verified', () => {
  const v = newVault();
  const file = path.join(v, 'Knowledge', '旧条目.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nid: mem_old\ntype: decision\nstatus: active\ntitle: 旧条目\ntags: [旧]\nconfidence: 0.8\nimportance: 70\npinned: true\n---\n\n## 核心内容\n\n正文\n', 'utf8');
  const memory = readMemoryFile(file, v);
  assert.equal(memory.status, 'verified');
  assert.equal(selectL0(loadMemories(v)).length, 1);
});

// ---------- 3) 证据 ----------
await check('evidence 写进 frontmatter，memory_get 一并返回', async () => {
  const tools = toolsFor(vault);
  const out = await tools.memory_write.execute(
    { title: '带证据的一条', type: 'knowledge', content: '证据要留下来', evidence: '2026-11-23 的对话，第三轮' },
    {},
  );
  assert.equal(out.ok, true);
  const read = await tools.memory_get.execute({ id: out.id }, {});
  assert.equal(read.ok, true);
  assert.equal(read.evidence, '2026-11-23 的对话，第三轮');
  assert.match(fs.readFileSync(out.path, 'utf8'), /evidence: 2026-11-23 的对话，第三轮/);
});

// ---------- 4) 时效 ----------
await check('expires 过期的条目：不进 L1', () => {
  const v = newVault();
  const expired = createMemory({
    vaultPath: v,
    title: '记忆插件价格 2026 年 11 月',
    type: 'knowledge',
    content: '记忆插件 价格 99 元',
    tags: ['记忆插件', '价格'],
    expires: '2026-11-20',
    status: 'verified',
  });
  assert.equal(expired.ok, true);
  const memories = loadMemories(v);
  const l1 = selectL1(memories, contextWith('记忆插件 价格 是多少？记忆插件 价格'), { today: '2026-11-23' });
  assert.equal(l1.rows.length, 0);
});

await check('expires 还没到的条目：照常进 L1', () => {
  const v = newVault();
  createMemory({
    vaultPath: v,
    title: '记忆插件价格 2026 年 12 月',
    type: 'knowledge',
    content: '记忆插件 价格 88 元',
    tags: ['记忆插件', '价格'],
    expires: '2026-12-31',
    status: 'verified',
  });
  const l1 = selectL1(loadMemories(v), contextWith('记忆插件 价格 是多少？记忆插件 价格'), { today: '2026-11-23' });
  assert.equal(l1.rows.length, 1);
});

// ---------- 5) 读取计数 ----------
await check('memory_get 每读一次 reads +1', async () => {
  const v = newVault();
  const tools = toolsFor(v);
  const out = await tools.memory_write.execute({ title: '计数的条目', type: 'knowledge', content: '读我' }, {});
  const first = await tools.memory_get.execute({ id: out.id }, {});
  assert.equal(first.reads, 1);
  const second = await tools.memory_get.execute({ id: out.id }, {});
  assert.equal(second.reads, 2);
  assert.equal(readMemoryFile(out.path, v).reads, 2);
});

await check('recordRead 对没有 reads 行的旧文件补一行', () => {
  const v = newVault();
  const file = path.join(v, 'Knowledge', '无计数.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nid: mem_x\ntype: knowledge\nstatus: verified\ntitle: 没有计数\nupdated_at: 2026-11-01 10:00:00\n---\n\n## 核心内容\n\n正文\n', 'utf8');
  const result = recordRead(file, v);
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(file, 'utf8'), /reads: 1/);
});

// ---------- 6) 体检单 ----------
await check('memory_review 出三张单子：过时 / 没用 / 可合并', async () => {
  const v = newVault();
  const old = new Date(Date.now() - 90 * DAY);
  const stale = createMemory({ vaultPath: v, title: '早就过时的计划', type: 'project-state', content: '当时对，后来不做了', status: 'verified', now: old });
  const unused = createMemory({ vaultPath: v, title: '被检索到但没人读', type: 'knowledge', content: '命中过', status: 'candidate', now: old });
  const mergeA = createMemory({ vaultPath: v, title: '记忆插件的收盘校验', type: 'knowledge', content: 'a', tags: ['记忆插件', '收盘'], status: 'verified', now: old });
  const mergeB = createMemory({ vaultPath: v, title: '记忆插件的收盘校验规则', type: 'knowledge', content: 'b', tags: ['收盘', '记忆插件'], status: 'verified', now: old });

  const dir = path.join(v, '.dsh-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hits.json'), JSON.stringify({ [unused.id]: { hits: 5, lastAt: '2026-11-20T00:00:00.000Z' } }), 'utf8');

  const review = buildReview(loadMemories(v), { now: new Date(), hits: JSON.parse(fs.readFileSync(path.join(dir, 'hits.json'), 'utf8')) });
  assert.ok(review.stale.some((item) => item.id === stale.id), '过时的条目要在单子上');
  assert.ok(review.unused.some((item) => item.id === unused.id), '没用的条目要在单子上');
  assert.ok(review.merge.some((pair) => [pair.a.id, pair.b.id].includes(mergeA.id) && [pair.a.id, pair.b.id].includes(mergeB.id)), '可合并的一对要在单子上');
  assert.equal(review.counts.stale >= 1, true);
});

await check('memory_review 工具可调用，只出单子不改 status', async () => {
  const v = newVault();
  const old = new Date(Date.now() - 90 * DAY);
  const created = createMemory({ vaultPath: v, title: '老得没人管的条目', type: 'knowledge', content: 'x', status: 'verified', now: old });
  const tools = toolsFor(v);
  const review = await tools.memory_review.execute({ now: '2026-11-23' }, {});
  assert.equal(review.ok, true);
  assert.ok(review.stale.some((item) => item.id === created.id));
  assert.equal(readMemoryFile(created.path, v).status, 'verified', '体检不能改动记忆');
});

await check('memory_review 的渲染里有三张单子的标题', async () => {
  const v = newVault();
  const old = new Date(Date.now() - 90 * DAY);
  createMemory({ vaultPath: v, title: '又是老条目', type: 'knowledge', content: 'x', status: 'verified', now: old });
  const tools = toolsFor(v);
  const review = await tools.memory_review.execute({ now: '2026-11-23' }, {});
  const rendered = tools.memory_review.output.render({}, review)[0].text;
  assert.match(rendered, /疑似过时/);
  assert.match(rendered, /只出单子/);
});

// ---------- HTTP：/status 与 /review ----------
await check('POST /status 把条目标成 verified，文件真的变了', async () => {
  const v = newVault();
  const created = createMemory({ vaultPath: v, title: '待确认条目', type: 'knowledge', content: 'x', status: 'candidate' });
  const handler = createStateHandler({ vaultPath: v });
  const result = await callApi(handler, { method: 'POST', url: '/memory-yuan/status', body: { id: created.id, status: 'verified' } });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(readMemoryFile(created.path, v).status, 'verified');
});

await check('POST /status 缺 id / status 非法都返回 400', async () => {
  const v = newVault();
  createMemory({ vaultPath: v, title: '某条', type: 'knowledge', content: 'x', status: 'candidate' });
  const handler = createStateHandler({ vaultPath: v });
  assert.equal((await callApi(handler, { method: 'POST', url: '/memory-yuan/status', body: {} })).status, 400);
  assert.equal((await callApi(handler, { method: 'POST', url: '/memory-yuan/status', body: { id: 'x', status: 'weird' } })).status, 400);
});

await check('GET /review 返回体检单 JSON', async () => {
  const v = newVault();
  const handler = createStateHandler({ vaultPath: v });
  const result = await callApi(handler, { url: '/memory-yuan/review' });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.ok(result.json.counts);
});

// ---------- 检索口径 ----------
await check('candidate 能被 memory_search 搜到，disputed 搜不到', async () => {
  const v = newVault();
  const tools = toolsFor(v);
  const candidate = await tools.memory_write.execute({ title: '候选也能搜到', type: 'knowledge', content: '候选的正文' }, {});
  const disputedOut = await tools.memory_write.execute({ title: '有争议的搜不到', type: 'knowledge', content: '争议正文' }, {});
  const memory = loadMemories(v).find((m) => m.id === disputedOut.id);
  setMemoryStatus(memory.path, 'disputed');

  const foundCandidate = await tools.memory_search.execute({ query: '候选' }, {});
  assert.ok(foundCandidate.rows.some((row) => row.id === candidate.id));

  const foundDisputed = await tools.memory_search.execute({ query: '争议' }, {});
  assert.ok(!foundDisputed.rows.some((row) => row.id === disputedOut.id));
});

console.log(`\nselftest18：${pass} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
