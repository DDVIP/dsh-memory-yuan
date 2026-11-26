/**
 * selftest15：按 room/给插件会话-待办3.md 修的四处（2026-11-23）。
 *
 * 覆盖：
 * - 句子完整性：半句、超长、条数不足/过多都被 writeSummary 拒
 * - runDigest：第一次半句 → 重试 → 第二次合格才落盘；两次都不合格 → 不写 summary、流水留痕
 * - writeSummary 原子写：无 .tmp 残留；tmp 写失败不留垃圾
 * - 锁：同进程嵌套 withLock 不死锁；外部进程持锁时 tryLock 按时超时
 * - appendStream 用 at 推导日期（补记昨天落昨天，2026-11-23 修）
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateSentences, writeSummary, readDaily, summaryPathOf } from '../lib/digest.js';
import { runDigest } from '../lib/digest-scheduler.js';
import { appendStream, localDateStamp } from '../lib/stream.js';
import { withLock, tryLock } from '../lib/lock.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-15-'));
}

function fakeLlm({ rounds = [] } = {}) {
  let index = 0;
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'p1' }],
    listConfigurableProviders: () => [{ provider: 'p1', settingsNs: 'ns-1' }],
    stream: ({ provider, model }) => {
      const lines = rounds[Math.min(index, rounds.length - 1)] ?? [];
      index += 1;
      calls.push({ provider, model, round: index });
      return (async function* () {
        for (const line of lines) yield { type: 'text-delta', text: `${line}\n` };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

function fakeSettings() {
  return { describe: () => [{ ns: 'ns-1', value: { models: [{ id: 'm1' }] } }] };
}

console.log('句子完整性');

await check('半句（没有句号）被拒', () => {
  const result = writeSummary(tempVault(), { date: '2026-11-22', sentences: ['甲。', '乙。', '写到一半'] });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有以 。！？ 结尾/);
});

await check('超长句（>80 字）被拒', () => {
  const long = `${'字'.repeat(81)}。`;
  const result = writeSummary(tempVault(), { date: '2026-11-22', sentences: ['甲。', '乙。', long] });
  assert.equal(result.ok, false);
  assert.match(result.message, /超过 80 字/);
});

await check('条数不足/过多都被拒', () => {
  assert.equal(writeSummary(tempVault(), { date: '2026-11-22', sentences: ['甲。', '乙。'] }).ok, false);
  assert.equal(writeSummary(tempVault(), { date: '2026-11-22', sentences: ['甲。', '乙。', '丙。', '丁。', '戊。', '己。', '庚。'] }).ok, false);
  assert.deepEqual(validateSentences(['甲。', '乙。', '丙。']).ok, true);
});

console.log('runDigest 重试与拒绝');

await check('第一次半句、第二次合格 → 重试后落盘', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const llm = fakeLlm({ rounds: [['甲。', '乙。', '写到一半'], ['甲。', '乙。', '丙。']] });
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(llm.calls.length, 2);
  assert.ok(fs.existsSync(summaryPathOf(vault, '2026-11-22')));
});

await check('两次都不合格 → 不写 summary，流水留痕', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const llm = fakeLlm({ rounds: [['甲。', '乙。', '写到一半'], ['甲。', '乙。', '还是半句']] });
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /句子不合格/);
  assert.equal(fs.existsSync(summaryPathOf(vault, '2026-11-22')), false);
  const daily = readDaily(vault, '2026-11-22');
  assert.ok(daily.lines.some((line) => line.includes('收盘没跑成')));
});

await check('模型只给标题行/空行 → 视为 0 句并留痕', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const llm = fakeLlm({ rounds: [['# 今天', '', ''], ['# 今天', '', '']] });
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /0 句/);
});

console.log('原子写与锁');

await check('writeSummary 不留 .tmp 残留', () => {
  const vault = tempVault();
  const result = writeSummary(vault, { date: '2026-11-22', sentences: ['甲。', '乙。', '丙。'] });
  assert.equal(result.ok, true);
  const leftovers = fs.readdirSync(path.join(vault, 'Daily')).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

await check('同进程嵌套 withLock 不死锁', () => {
  const vault = tempVault();
  const value = withLock(vault, () => withLock(vault, () => 'inner-ok'));
  assert.equal(value, 'inner-ok');
});

await check('外部进程持锁时 tryLock 按时超时', async () => {
  const vault = tempVault();
  const lockDir = path.join(vault, '.dsh-memory', 'lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const started = Date.now();
    const outcome = tryLock(vault, () => 'never', { timeoutMs: 120, pollMs: 10 });
    const elapsed = Date.now() - started;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.locked, true);
    assert.ok(elapsed >= 100 && elapsed < 1500, `等了 ${elapsed}ms`);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
    child.kill();
  }
});

console.log('appendStream 日期');

await check('at 传昨天 → 落昨天文件（2026-11-23 修）', () => {
  const vault = tempVault();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const result = appendStream({ vaultPath: vault, kind: 'daily', content: '补记', at: yesterday });
  assert.equal(result.ok, true);
  const stamp = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  assert.equal(result.date, stamp);
  assert.ok(fs.existsSync(path.join(vault, 'Daily', `${stamp}.md`)));
  assert.notEqual(localDateStamp(yesterday), localDateStamp());
});

console.log(`\nselftest15：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
