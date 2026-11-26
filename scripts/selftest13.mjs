/**
 * selftest13：收盘定时器的边界（第二轮自测 2026-11-22）。
 *
 * 覆盖：
 * - parseAt 边界（0:0、23:59、前后空格、非法值）
 * - digest-state 坏 JSON / 原子写不留 .tmp
 * - runDigest：summary 已存在时不调模型、只有标题没有流水行时跳过、
 *   多候选全失败时留痕并汇总、summary 写不进去时返回失败
 * - scheduler：digestAt 非法只 warn 不启动、tickMs 非法用默认、
 *   未到点/今天已跑不跑、昨天跑过今天到点会跑、
 *   失败时 state 记 lastResult=failed + lastError，且当天不重试
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseAt,
  readDigestState,
  runDigest,
  startDigestScheduler,
  statePathOf,
  writeDigestState,
} from '../lib/digest-scheduler.js';
import { appendStream, localDateStamp, localTimeStamp } from '../lib/stream.js';
import { readDaily, summaryPathOf, writeSummary } from '../lib/digest.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-13-'));
}

/** 可控模型：记录被调次数，按脚本返回。 */
function fakeLlm({ providers = [{ id: 'prov-a' }], entries = [{ provider: 'prov-a', settingsNs: 'ns-a' }], lines = ['第一句完整的话。', '第二句完整的话。', '第三句完整的话。'], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => providers,
    listConfigurableProviders: () => entries,
    stream: ({ provider, model }) => {
      calls.push({ provider, model });
      if (fail) throw new Error('network down');
      return (async function* () {
        for (const line of lines) yield { type: 'text-delta', text: `${line}\n` };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

function fakeSettings(models = [{ id: 'model-a' }]) {
  return { describe: () => [{ ns: 'ns-a', value: { models } }] };
}

function at(hour, minute, day = new Date()) {
  const value = new Date(day);
  value.setHours(hour, minute, 0, 0);
  return value;
}

const tickOnce = () => new Promise((resolve) => setTimeout(resolve, 20));

console.log('parseAt 边界');

await check('0:0 合法（午夜），23:59 合法', () => {
  assert.deepEqual(parseAt('0:0'), { hour: 0, minute: 0 });
  assert.deepEqual(parseAt('23:59'), { hour: 23, minute: 59 });
});

await check('前后空格会被 trim', () => {
  assert.deepEqual(parseAt(' 23:00 '), { hour: 23, minute: 0 });
});

await check('24:00 / 23:60 / 负值都不合法', () => {
  for (const value of ['24:00', '23:60', '-1:00', '12:-5']) {
    assert.equal(parseAt(value), null, `${value} 应当不合法`);
  }
});

console.log('digest-state');

await check('坏 JSON 读成空对象', () => {
  const vault = tempVault();
  fs.mkdirSync(path.join(vault, '.dsh-memory'), { recursive: true });
  fs.writeFileSync(statePathOf(vault), '{不是 JSON', 'utf8');
  assert.deepEqual(readDigestState(vault), {});
});

await check('写入后不留 .tmp 残留', () => {
  const vault = tempVault();
  writeDigestState(vault, { lastRunDate: '2026-11-21', lastResult: 'ok' });
  const dir = path.join(vault, '.dsh-memory');
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(readDigestState(vault).lastRunDate, '2026-11-21');
});

console.log('runDigest 边界');

await check('summary 已存在时直接跳过，不调模型', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  fs.mkdirSync(path.dirname(summaryPathOf(vault, '2026-11-22')), { recursive: true });
  fs.writeFileSync(summaryPathOf(vault, '2026-11-22'), '# 已有收盘\n', 'utf8');
  const llm = fakeLlm();
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'already');
  assert.equal(llm.calls.length, 0);
});

await check('只有标题、没有流水行时跳过', async () => {
  const vault = tempVault();
  const dir = path.join(vault, 'Daily');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-11-22.md'), '# 2026-11-22 流水\n\n', 'utf8');
  const llm = fakeLlm();
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'empty');
  assert.equal(llm.calls.length, 0);
});

await check('候选全失败时汇总原因并留痕', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const llm = {
    listProviders: () => [{ id: 'p1' }, { id: 'p2' }],
    listConfigurableProviders: () => [
      { provider: 'p1', settingsNs: 'ns-1' },
      { provider: 'p2', settingsNs: 'ns-2' },
    ],
    stream: ({ provider }) => {
      throw new Error(`${provider} 连不上`);
    },
  };
  const settings = {
    describe: () => [
      { ns: 'ns-1', value: { models: [{ id: 'm1' }] } },
      { ns: 'ns-2', value: { models: [{ id: 'm2' }] } },
    ],
  };
  const result = await runDigest({ vaultPath: vault, llm, settings, date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /p2\/m2 调模型失败：p2 连不上/);
  const daily = readDaily(vault, '2026-11-22');
  assert.ok(daily.lines.some((line) => line.includes('收盘没跑成')));
});

await check('写 summary 的 IO 失败会报原因（Daily 被文件占住）', () => {
  const vault = tempVault();
  // Daily 是文件而不是目录：mkdirSync / writeFileSync 都会失败。
  fs.writeFileSync(path.join(vault, 'Daily'), 'not a directory', 'utf8');
  const result = writeSummary(vault, { date: '2026-11-22', sentences: ['一句。', '二句。', '三句。'] });
  assert.equal(result.ok, false);
  assert.match(result.message, /写收盘摘要失败|EEXIST|ENOTDIR|EPERM|EISDIR/);
});

await check('summary 已存在（哪怕是目录）时 runDigest 跳过而不是报错', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  fs.mkdirSync(summaryPathOf(vault, '2026-11-22'), { recursive: true });
  const result = await runDigest({ vaultPath: vault, llm: fakeLlm(), settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'already');
});

console.log('scheduler 边界');

await check('digestAt 非法只 warn，不启动、不调模型', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const warns = [];
  const llm = fakeLlm();
  const dispose = startDigestScheduler({
    ctx: { llm, settings: fakeSettings() },
    vaultPath: vault,
    config: { digestAt: '25:00' },
    log: { log() {}, warn: (message) => warns.push(message) },
    now: () => at(23, 30),
  });
  await tickOnce();
  assert.equal(typeof dispose, 'function');
  assert.equal(llm.calls.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /digestAt 不合法/);
  dispose();
});

await check('tickMs 非法时用默认值，不抛错', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const dispose = startDigestScheduler({
    ctx: { llm: fakeLlm(), settings: fakeSettings() },
    vaultPath: vault,
    config: { digestTickMs: 'abc' },
    log: { log() {}, warn() {} },
    now: () => at(23, 30),
  });
  await tickOnce();
  assert.equal(typeof dispose, 'function');
  dispose();
});

await check('未到点时不跑（即使昨天跑过）', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  writeDigestState(vault, { lastRunDate: '2026-11-21', lastResult: 'ok' });
  const llm = fakeLlm();
  const dispose = startDigestScheduler({
    ctx: { llm, settings: fakeSettings() },
    vaultPath: vault,
    config: { digestAt: '23:00' },
    log: { log() {}, warn() {} },
    now: () => at(22, 59),
  });
  await tickOnce();
  assert.equal(llm.calls.length, 0);
  dispose();
});

await check('昨天跑过、今天到点会跑，并记 lastRunDate', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  writeDigestState(vault, { lastRunDate: '2026-11-21', lastResult: 'ok' });
  const llm = fakeLlm();
  const dispose = startDigestScheduler({
    ctx: { llm, settings: fakeSettings() },
    vaultPath: vault,
    config: { digestAt: '23:00' },
    log: { log() {}, warn() {} },
    now: () => at(23, 5),
  });
  await tickOnce();
  assert.equal(llm.calls.length, 1);
  const state = readDigestState(vault);
  assert.equal(state.lastRunDate, localDateStamp());
  assert.equal(state.lastResult, 'ok');
  assert.equal(state.lastModel, 'prov-a/model-a');
  dispose();
});

await check('跑失败时记 lastResult=failed + lastError，当天不再重试', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const llm = fakeLlm({ fail: true });
  const dispose = startDigestScheduler({
    ctx: { llm, settings: fakeSettings() },
    vaultPath: vault,
    config: { digestAt: '23:00' },
    log: { log() {}, warn() {} },
    now: () => at(23, 5),
  });
  await tickOnce();
  const state = readDigestState(vault);
  assert.equal(state.lastResult, 'failed');
  assert.match(state.lastError, /network down/);
  assert.equal(state.lastRunDate, localDateStamp());
  await tickOnce();
  assert.equal(llm.calls.length, 1, '同一天失败后不应重复调模型');
  dispose();
});

console.log(`\nselftest13：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
