/**
 * 自测 26：体检可操作。
 *
 * 每条都带「为什么」和「怎么办」；忽略记进 review-ignored.json，单子不再出现；
 * HTTP 的忽略接口与工具层输出保持同一份语义。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReview, ignoreInReview, readIgnored, reviewVault } from '../lib/review.js';
import { createStateHandler } from '../lib/api.js';
import { createTools } from '../lib/tools.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-review-'));
const writeNote = (name, body) => {
  const dir = path.join(vault, 'Experiences');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
};

const oldNote = writeNote(
  'old.md',
  '---\nid: mem_old\ntype: experience\nstatus: verified\ntitle: 一条很久没动的经验\ncreated_at: 2026-08-01 10:00:00\nupdated_at: 2026-08-01 10:00:00\ntags:\n  - 测试\n---\n\n## 核心内容\n\n正文。\n',
);
const noEvDir = path.join(vault, 'Knows');
fs.mkdirSync(noEvDir, { recursive: true });
const noEv = path.join(noEvDir, 'noev.md');
fs.writeFileSync(
  noEv,
  '---\nid: mem_noev\ntype: knowledge\nstatus: verified\ntitle: 没写出处的知识点\ncreated_at: 2026-11-20 10:00:00\nupdated_at: 2026-11-20 10:00:00\n---\n\n## 核心内容\n\n正文。\n',
  'utf8',
);
void oldNote;
void noEv;

const NOW = new Date('2026-11-24T12:00:00');

console.log('体检可操作');

await check('每条单子都带 why 与 fix', () => {
  const review = buildReview(
    [
      { id: 'a', type: 'experience', status: 'verified', title: '旧的', evidence: '', updated: '2026-08-01 10:00:00', dir: 'Experiences', tags: ['x', 'y'], reads: 0 },
      { id: 'b', type: 'experience', status: 'verified', title: '旧的二', evidence: 'e', updated: '2026-08-02 10:00:00', dir: 'Experiences', tags: ['x', 'y'], reads: 0 },
    ],
    { now: NOW, hits: { a: { hits: 4 }, b: { hits: 4 } } },
  );
  assert.ok(review.stale.length >= 1);
  assert.ok(review.stale.every((item) => item.why && item.fix));
  assert.ok(review.unused.every((item) => item.why && item.fix));
  assert.ok(review.noEvidence.every((item) => item.why && item.fix));
  assert.ok(review.merge.every((item) => item.why && item.fix));
});

await check('忽略一条后它从 stale / unused / noEvidence 消失', () => {
  const before = reviewVault(vault, { now: NOW });
  assert.ok(before.stale.some((item) => item.id === 'mem_old'));
  assert.ok(before.noEvidence.some((item) => item.id === 'mem_noev'));

  assert.equal(ignoreInReview(vault, 'mem_old', { now: NOW }).ok, true);
  assert.equal(ignoreInReview(vault, 'mem_noev', { now: NOW }).ok, true);

  const after = reviewVault(vault, { now: NOW });
  assert.ok(!after.stale.some((item) => item.id === 'mem_old'));
  assert.ok(!after.noEvidence.some((item) => item.id === 'mem_noev'));
});

await check('忽略清单落盘，读得回来，且没有 .tmp 残留', () => {
  const ids = readIgnored(vault);
  assert.ok(ids.has('mem_old'));
  assert.ok(ids.has('mem_noev'));
  const dir = path.join(vault, '.dsh-memory');
  assert.ok(!fs.readdirSync(dir).some((name) => name.includes('.tmp')));
});

await check('缺 id 的忽略请求被拒（不写清单）', () => {
  const r = ignoreInReview(vault, '   ', { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(readIgnored(vault).size, 2);
});

await check('坏掉的清单文件当空，不炸', () => {
  const file = path.join(vault, '.dsh-memory', 'review-ignored.json');
  fs.writeFileSync(file, '{不是 json', 'utf8');
  assert.equal(readIgnored(vault).size, 0);
  const r = reviewVault(vault, { now: NOW });
  assert.ok(r.stale.some((item) => item.id === 'mem_old'), '坏文件不应该永久隐藏单子');
});

await check('merge 单子里任意一条被忽略就不再出现', () => {
  const memories = [
    { id: 'm1', type: 'experience', status: 'verified', title: '甲：插件注入写法', evidence: 'e', updated: '2026-11-20 10:00:00', dir: 'Experiences', tags: ['插件', '注入'] },
    { id: 'm2', type: 'experience', status: 'verified', title: '乙：插件注入写法', evidence: 'e', updated: '2026-11-20 10:00:00', dir: 'Experiences', tags: ['插件', '注入'] },
  ];
  const plain = buildReview(memories, { now: NOW });
  assert.equal(plain.merge.length, 1);
  const hidden = buildReview(memories, { now: NOW, ignored: new Set(['m2']) });
  assert.equal(hidden.merge.length, 0);
});

// ---- HTTP ----
const handler = createStateHandler({ vaultPath: vault });
const call = async (method, url, body) => {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {
    method,
    url,
    on(event, fn) {
      if (event === 'data') chunks.forEach((chunk) => fn(chunk));
      if (event === 'end') fn();
      return req;
    },
  };
  let status = 0;
  let text = '';
  const res = {
    writeHead(code) {
      status = code;
    },
    end(payload) {
      text = payload;
    },
  };
  await handler(req, res);
  return { status, body: JSON.parse(text || '{}') };
};

await check('HTTP POST /review/ignore 记下忽略并返回 200', async () => {
  const r = await call('POST', '/memory-yuan/review/ignore', { id: 'mem_old' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

await check('HTTP GET /review 带 ignored 计数且单子已消失', async () => {
  const r = await call('GET', '/memory-yuan/review');
  assert.equal(r.status, 200);
  assert.ok(r.body.ignored >= 1);
  assert.ok(!r.body.stale.some((item) => item.id === 'mem_old'));
});

await check('HTTP 忽略缺 id 返回 400', async () => {
  const r = await call('POST', '/memory-yuan/review/ignore', {});
  assert.equal(r.status, 400);
});

// ---- 工具层 ----
await check('memory_review 的输出过 schema，render 带「为什么」', async () => {
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
  const review = tools.memory_review;
  const value = await review.execute({});
  const text = review.output.render({}, value)[0].text;
  assert.match(text, /体检：扫了/);
  const checked = JSON.parse(JSON.stringify(value));
  assert.equal(typeof checked.scanned, 'number');
  for (const item of checked.stale ?? []) {
    assert.ok(item.why, 'schema 里必须有 why 字段');
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
