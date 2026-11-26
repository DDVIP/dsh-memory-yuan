/**
 * selftest28：体检的出口（留着 / 过期 / 忽略 / 恢复）+ 旧 id 兼容。
 *
 * 主人 2026-11-24 反馈：点了忽略就找不到了；有些只是没标来源、有些只是小用、
 * 有些只是暂时有用——原来只有「废弃 / 忽略」两个出口，全被逼成同一个动作。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemory, setMemoryExpiry, setMemoryStatus } from '../lib/store.js';
import { buildReview, ignoreInReview, readIgnored, reviewVault, unignoreInReview } from '../lib/review.js';
import { loadMemories } from '../lib/vault.js';
import { findMemory } from '../lib/search.js';
import { INDEX_SCHEMA_VERSION, writeIndex, writeIndexIfChanged } from '../lib/snapshot.js';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-review-'));
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
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
    _flush() {
      listeners.data?.(Buffer.concat(chunks));
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

const today = new Date();
const stamp = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);

// ---------------------------------------------------------------------------
await check('setMemoryExpiry：写进去、改更新日、可清空', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '计划：下个月换显卡', type: 'project-state', content: '暂时有用。' });
  const set = setMemoryExpiry(made.path, '2026-12-01', { now: new Date('2026-11-24T10:00:00') });
  assert.equal(set.ok, true);
  const raw = fs.readFileSync(made.path, 'utf8');
  assert.match(raw, /^expires: 2026-12-01$/m);
  assert.match(raw, /^updated_at: 2026-11-24 10:00:00$/m);
  const cleared = setMemoryExpiry(made.path, '');
  assert.equal(cleared.ok, true);
  assert.doesNotMatch(fs.readFileSync(made.path, 'utf8'), /^expires:/m);
});

await check('setMemoryExpiry：坏日期拒绝', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: 'x', type: 'knowledge', content: 'y' });
  const bad = setMemoryExpiry(made.path, '2026/12/01');
  assert.equal(bad.ok, false);
  assert.match(bad.message, /YYYY-MM-DD/);
});

await check('review：已过期的进「已过期」组', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '旧计划', type: 'project-state', content: '过了。' });
  setMemoryExpiry(made.path, stamp(yesterday));
  const review = reviewVault(vault, { now: today });
  assert.equal(review.counts.expired, 1);
  assert.equal(review.expired[0].id, made.id);
  assert.match(review.expired[0].why, /过期了/);
});

await check('review：还没到期的不进「已过期」', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '新计划', type: 'project-state', content: '还早。' });
  setMemoryExpiry(made.path, stamp(tomorrow));
  const review = reviewVault(vault, { now: today });
  assert.equal(review.counts.expired, 0);
  assert.equal(review.expired.length, 0);
  assert.ok(review.expired.every((item) => item.id !== made.id));
});

await check('review：忽略后从单子消失，但出现在 ignoredEntries', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '被忽略的', type: 'knowledge', content: 'x' });
  ignoreInReview(vault, made.id);
  const review = reviewVault(vault, { now: today });
  const ids = [...review.stale, ...review.unused, ...review.noEvidence, ...review.expired].map((x) => x.id);
  assert.ok(!ids.includes(made.id));
  assert.equal(review.counts.ignored, 1);
  assert.equal(review.ignoredEntries[0].id, made.id);
  assert.equal(review.ignoredEntries[0].title, '被忽略的');
});

await check('unignore：恢复后重新出现在单子里', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '恢复我', type: 'knowledge', content: 'x', importance: 10 });
  ignoreInReview(vault, made.id);
  const back = unignoreInReview(vault, made.id);
  assert.equal(back.ok, true);
  assert.equal(readIgnored(vault).has(made.id), false);
  const review = reviewVault(vault, { now: today });
  assert.equal(review.counts.ignored, 0);
});

await check('unignore：不存在的 id 也返回 ok（幂等）', () => {
  const vault = tmpVault();
  const r = unignoreInReview(vault, 'nope');
  assert.equal(r.ok, true);
});

await check('HTTP /expire：设过期并写进文件', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '走路由', type: 'knowledge', content: 'x' });
  const handler = createStateHandler({ vaultPath: vault });
  const res = await call(handler, 'POST', '/memory-yuan/expire', { id: made.id, expires: '2026-12-31' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(fs.readFileSync(made.path, 'utf8'), /^expires: 2026-12-31$/m);
});

await check('HTTP /expire：缺 id 400、找不到 404、坏日期 400', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: 'x', type: 'knowledge', content: 'y' });
  const handler = createStateHandler({ vaultPath: vault });
  assert.equal((await call(handler, 'POST', '/memory-yuan/expire', {})).status, 400);
  assert.equal((await call(handler, 'POST', '/memory-yuan/expire', { id: 'nope', expires: '2026-12-31' })).status, 404);
  assert.equal((await call(handler, 'POST', '/memory-yuan/expire', { id: made.id, expires: '明天' })).status, 400);
});

await check('HTTP /review 带 ignoredEntries 与 expired 计数', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '忽略我', type: 'knowledge', content: 'x' });
  ignoreInReview(vault, made.id);
  const handler = createStateHandler({ vaultPath: vault });
  const res = await call(handler, 'GET', '/memory-yuan/review');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.ignoredEntries));
  assert.equal(res.json.ignoredEntries[0].id, made.id);
  assert.equal(typeof res.json.counts.expired, 'number');
});

await check('HTTP /review/unignore：恢复后 ignoredEntries 变空', async () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '恢复我', type: 'knowledge', content: 'x' });
  ignoreInReview(vault, made.id);
  const handler = createStateHandler({ vaultPath: vault });
  const res = await call(handler, 'POST', '/memory-yuan/review/unignore', { id: made.id });
  assert.equal(res.status, 200);
  const after = await call(handler, 'GET', '/memory-yuan/review');
  assert.equal(after.json.ignoredEntries.length, 0);
});

await check('findMemory：旧 id（文件名）也能查到——index 没重建时不再 404', () => {
  const vault = tmpVault();
  // 手写一个没有 frontmatter 的文件（旧库导入的形态）
  const dir = path.join(vault, 'Companion');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Behavior Policy.md');
  fs.writeFileSync(file, '# Companion · Behavior Policy\n\npretend_human: false\n', 'utf8');
  const memories = loadMemories(vault);
  const derived = memories.find((m) => m.title === 'Companion · Behavior Policy');
  assert.ok(derived.id.startsWith('mem_derived_'));
  // 新 id 能查到
  assert.equal(findMemory(memories, derived.id)?.title, 'Companion · Behavior Policy');
  // 旧 id（文件名）也能查到
  assert.equal(findMemory(memories, 'Behavior Policy')?.title, 'Companion · Behavior Policy');
  assert.equal(findMemory(memories, 'behavior policy')?.title, 'Companion · Behavior Policy');
});

await check('findMemory：文件路径尾部照旧能查到', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '路径查', type: 'knowledge', content: 'x' });
  const memories = loadMemories(vault);
  const found = findMemory(memories, made.path);
  assert.equal(found?.id, made.id);
});

await check('索引版本号参与指纹：版本变了会强制重建', () => {
  const vault = tmpVault();
  createMemory({ vaultPath: vault, title: 'a', type: 'knowledge', content: 'x' });
  assert.equal(writeIndexIfChanged(vault), true);
  assert.equal(writeIndexIfChanged(vault), false);
  const first = INDEX_SCHEMA_VERSION;
  assert.equal(typeof first, 'number');
  assert.ok(first >= 2);
  // 直接写一次索引，指纹应与 ifChanged 用的口径一致（不会每次刷都重建）
  writeIndex(vault);
  assert.equal(writeIndexIfChanged(vault), false);
});

await check('review 不把 ignored 的过期条目算进 expired', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '过期又忽略', type: 'knowledge', content: 'x' });
  setMemoryExpiry(made.path, stamp(yesterday));
  ignoreInReview(vault, made.id);
  const review = reviewVault(vault, { now: today });
  assert.equal(review.counts.expired, 0);
  assert.equal(review.counts.ignored, 1);
});

await check('superseded 不进体检单', () => {
  const vault = tmpVault();
  const made = createMemory({ vaultPath: vault, title: '废弃了', type: 'knowledge', content: 'x' });
  setMemoryStatus(made.path, 'superseded');
  const review = reviewVault(vault, { now: today });
  const ids = [...review.stale, ...review.unused, ...review.noEvidence, ...review.expired].map((x) => x.id);
  assert.ok(!ids.includes(made.id));
});

await check('buildReview 空库不炸', () => {
  const review = buildReview([], { now: today });
  assert.equal(review.scanned, 0);
  assert.deepEqual(review.ignoredEntries, []);
  assert.equal(review.counts.expired, 0);
});

console.log(`\nselftest28：${passed} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const failure of failures) {
    console.error(`\n✗ ${failure.name}\n${failure.error?.stack ?? failure.error}`);
  }
  process.exit(1);
}
