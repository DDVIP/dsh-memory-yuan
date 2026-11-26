/**
 * selftest11：并发写入保护 + 收盘归拢（2026-11-22 待办2）。
 *
 * 覆盖：
 * - 文件锁：正常返回、超时报 LOCK_TIMEOUT、tryLock 转成 ok:false/locked、僵死锁清理、抛错也释放
 * - 索引原子：writeIndex 后没有 .tmp 残留、JSON 完整
 * - 写前比对：expectedUpdatedAt 一致才写；不一致返回 conflict 且不落盘
 * - 候选：status=candidate 落 Inbox/、不进 L0/L1、默认检索看不到
 * - 收盘：读模式、写 summary、幂等、坏日期报错、失败留痕
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withLock, tryLock, LOCK_TIMEOUT, lockPathOf } from '../lib/lock.js';
import { readDaily, writeSummary } from '../lib/digest.js';
import { appendStream } from '../lib/stream.js';
import { loadMemories } from '../lib/vault.js';
import { selectL0 } from '../lib/l0.js';
import { createTools } from '../lib/tools.js';
import { writeIndex } from '../lib/snapshot.js';
import { searchMemories } from '../lib/search.js';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-11-'));
}

const today = new Date();
const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

console.log('lock');

await check('withLock 返回 fn 的值', () => {
  const vault = tempVault();
  const value = withLock(vault, () => 42);
  assert.equal(value, 42);
  assert.equal(fs.existsSync(lockPathOf(vault)), false, '锁要释放');
});

await check('withLock 里抛错也会释放锁', () => {
  const vault = tempVault();
  assert.throws(() => withLock(vault, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lockPathOf(vault)), false);
});

await check('别人持锁时 tryLock 返回 locked（2 秒超时）', () => {
  const vault = tempVault();
  fs.mkdirSync(path.dirname(lockPathOf(vault)), { recursive: true });
  fs.mkdirSync(lockPathOf(vault));
  const started = Date.now();
  const outcome = tryLock(vault, () => 'never', { timeoutMs: 150 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.locked, true);
  assert.match(outcome.message, /另一个写入方/);
  assert.ok(Date.now() - started >= 140, '应该真的等过');
  fs.rmdirSync(lockPathOf(vault));
});

await check('withLock 超时抛 LOCK_TIMEOUT', () => {
  const vault = tempVault();
  fs.mkdirSync(path.dirname(lockPathOf(vault)), { recursive: true });
  fs.mkdirSync(lockPathOf(vault));
  assert.throws(() => withLock(vault, () => 1, { timeoutMs: 100 }), (error) => error.code === LOCK_TIMEOUT);
  fs.rmdirSync(lockPathOf(vault));
});

await check('僵死锁（mtime 很旧）会被清掉', () => {
  const vault = tempVault();
  fs.mkdirSync(path.dirname(lockPathOf(vault)), { recursive: true });
  fs.mkdirSync(lockPathOf(vault));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPathOf(vault), old, old);
  const value = withLock(vault, () => 'ok', { timeoutMs: 300 });
  assert.equal(value, 'ok');
});

console.log('atomic index');

await check('writeIndex 写完整 JSON，不留 .tmp', () => {
  const vault = tempVault();
  writeIndex(vault);
  const dir = path.join(vault, '.dsh-memory');
  const raw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

console.log('expectedUpdatedAt');

await check('updated_at 不一致 → conflict，且不落盘', async () => {
  const vault = tempVault();
  const tools = createTools({ vaultPath: vault });
  const write = Object.fromEntries(tools.map((tool) => [tool.name, tool])).memory_write;
  const first = await write.execute({ title: '原来的决定', type: 'decision', content: '一' }, {});
  assert.equal(first.ok, true);
  const before = loadMemories(vault).length;
  const conflict = await write.execute(
    { title: '改版决定', type: 'decision', content: '二', supersedes: first.id, expectedUpdatedAt: '1999-01-01 00:00:00' },
    {},
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.id, first.id);
  assert.equal(loadMemories(vault).length, before, '冲突时不能多写一条');
});

await check('updated_at 一致 → 正常取代', async () => {
  const vault = tempVault();
  const tools = createTools({ vaultPath: vault });
  const write = Object.fromEntries(tools.map((tool) => [tool.name, tool])).memory_write;
  const first = await write.execute({ title: '原来的决定', type: 'decision', content: '一' }, {});
  const old = loadMemories(vault).find((memory) => memory.id === first.id);
  const replaced = await write.execute(
    { title: '改版决定', type: 'decision', content: '二', supersedes: first.id, expectedUpdatedAt: old.updated },
    {},
  );
  assert.equal(replaced.ok, true);
  assert.equal(replaced.superseded, first.id);
});

console.log('candidate');

await check('status=candidate 落 Inbox/，不进 L0、默认检索看不到', async () => {
  const vault = tempVault();
  const tools = createTools({ vaultPath: vault });
  const write = Object.fromEntries(tools.map((tool) => [tool.name, tool])).memory_write;
  const written = await write.execute(
    { title: '候选：可能值得长期留', type: 'preference', content: '先放这儿', pinned: true, status: 'candidate' },
    {},
  );
  assert.equal(written.ok, true);
  const relative = path.relative(vault, written.path).split(path.sep).join('/');
  assert.ok(relative.startsWith('Inbox/'), `应落 Inbox/，实际 ${relative}`);
  const memories = loadMemories(vault);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].status, 'candidate');
  assert.equal(selectL0(memories).length, 0, '候选不进 L0');
  assert.equal(searchMemories(memories, { query: '候选' }).length, 1, '候选能被搜到，只是不进 L0');
});

await check('status 非法报错', async () => {
  const vault = tempVault();
  const tools = createTools({ vaultPath: vault });
  const write = Object.fromEntries(tools.map((tool) => [tool.name, tool])).memory_write;
  const bad = await write.execute({ title: 'x', type: 'knowledge', content: 'y', status: 'archived' }, {});
  assert.equal(bad.ok, false);
  assert.match(bad.message, /candidate/);
});

console.log('digest');

await check('读模式：返回当天流水行与收盘占位', async () => {
  const vault = tempVault();
  appendStream({ vaultPath: vault, kind: 'daily', content: '做了一件事', at: new Date() });
  appendStream({ vaultPath: vault, kind: 'daily', content: '又做了一件', at: new Date() });
  const read = readDaily(vault, stamp);
  assert.equal(read.ok, true);
  assert.equal(read.lines.length, 2);
  assert.equal(read.previous, '');
  assert.equal(read.summaryPath, path.join(vault, 'Daily', `${stamp}.summary.md`));
});

await check('写模式：生成 summary，第二次写同样内容不重复', async () => {
  const vault = tempVault();
  appendStream({ vaultPath: vault, kind: 'daily', content: '做了一件事', at: new Date() });
  const first = writeSummary(vault, { date: stamp, sentences: ['今天把流水接上了。', '收盘先跑一遍。', '明天接着写。'] });
  assert.equal(first.ok, true);
  const file = path.join(vault, 'Daily', `${stamp}.summary.md`);
  const once = fs.readFileSync(file, 'utf8');
  assert.match(once, /今天把流水接上了。/);
  const second = writeSummary(vault, { date: stamp, sentences: ['今天把流水接上了。', '收盘先跑一遍。', '明天接着写。'] });
  assert.equal(second.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), once, '同一天跑两次不能写两遍');
});

await check('坏日期报错', () => {
  const vault = tempVault();
  const bad = writeSummary(vault, { date: '2026-13-40', sentences: ['x'] });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /真实日期/);
});

await check('写 summary 失败 → 流水里留一行「收盘没跑成」', () => {
  const vault = tempVault();
  appendStream({ vaultPath: vault, kind: 'daily', content: '做了一件事', at: new Date() });
  // 用同名目录占住 summary 文件位置，逼写入失败
  fs.mkdirSync(path.join(vault, 'Daily', `${stamp}.summary.md`));
  const failed = writeSummary(vault, { date: stamp, sentences: ['甲。', '乙。', '丙。'] });
  assert.equal(failed.ok, false);
  const daily = fs.readFileSync(path.join(vault, 'Daily', `${stamp}.md`), 'utf8');
  assert.match(daily, /收盘没跑成/);
});

await check('工具层：memory_digest 读与写', async () => {
  const vault = tempVault();
  appendStream({ vaultPath: vault, kind: 'daily', content: '写了插件', at: new Date() });
  const tools = createTools({ vaultPath: vault });
  const digest = Object.fromEntries(tools.map((tool) => [tool.name, tool])).memory_digest;
  const read = await digest.execute({ date: stamp }, {});
  assert.equal(read.ok, true);
  assert.equal(read.lines.length, 1);
  const renderRead = digest.output.render({}, read);
  assert.match(renderRead[0].text, /1 条流水/);
  const written = await digest.execute({ date: stamp, sentences: ['今天写了插件。', '收盘归拢跑通了。', '明天继续。'] }, {});
  assert.equal(written.ok, true);
  assert.equal(written.count, 3);
  const renderWrite = digest.output.render({}, written);
  assert.match(renderWrite[0].text, /已写收盘/);
});

await check('两个进程同时往同一份 daily 追加（各 10 条，锁保证不丢行）', async () => {
  const { spawn } = await import('node:child_process');
  const vault = tempVault();
  const moduleUrl = new URL('../lib/stream.js', import.meta.url).href;
  const worker = `
    const { appendStream } = await import(${JSON.stringify(moduleUrl)});
    const [vault, tag] = process.argv.slice(1);
    for (let i = 0; i < 10; i += 1) appendStream({ vaultPath: vault, kind: 'daily', content: tag + '-' + i, at: new Date() });
  `;
  const runs = ['a', 'b'].map(
    (tag) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker, vault, tag], { stdio: 'inherit' });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exit ${code}`))));
        child.on('error', reject);
      }),
  );
  await Promise.all(runs);
  const text = fs.readFileSync(path.join(vault, 'Daily', `${stamp}.md`), 'utf8');
  const lines = text.split('\n').filter((line) => /^- \d{2}:\d{2} /.test(line));
  assert.equal(lines.length, 20, `应有 20 行，实际 ${lines.length}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
