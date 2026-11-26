/**
 * selftest12：插件内收盘（不依赖自动化任务/工作区）。
 *
 * 覆盖：
 * - parseAt 合法/非法
 * - pickModel：Config 优先、自动挑第一个有模型的 provider、没有模型返回 null
 * - parseSentences：去编号/列表符/标题、截 6 句
 * - runDigest：无流水跳过、正常收句写 summary、已有 summary 幂等跳过、
 *   模型抛错留痕、模型句子不足留痕、没有模型留痕
 * - startDigestScheduler：未到点不跑、到点跑一次、当天不重复、可在启动时补跑、
 *   digestEnabled=false 不跑、state 记录 lastRunDate/lastResult
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseAt,
  parseSentences,
  pickModel,
  readDigestState,
  runDigest,
  startDigestScheduler,
  statePathOf,
} from '../lib/digest-scheduler.js';
import { appendStream, localDateStamp } from '../lib/stream.js';
import { readDaily } from '../lib/digest.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-12-'));
}

function fakeLlm(lines = ['主人要求把收盘写进插件，不再挂到工作区上。', '插件用自己的定时器在 23:00 触发收盘。', '归拢失败会往当天流水里留一行原因。']) {
  return {
    listProviders: () => [{ id: 'prov-a', name: 'Prov A' }],
    listConfigurableProviders: () => [{ provider: 'prov-a', settingsNs: 'ns-a', settingsPath: [] }],
    stream: () =>
      (async function* () {
        for (const line of lines) yield { type: 'text-delta', text: `${line}\n` };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
  };
}

/** settings 服务的假实现：describe() 返回 [{ns, value}]。 */
function fakeSettings(models = [{ id: 'model-a' }]) {
  return {
    describe: () => [{ ns: 'ns-a', value: { models } }],
  };
}

function at(hour, minute, day = new Date()) {
  const value = new Date(day);
  value.setHours(hour, minute, 0, 0);
  return value;
}

console.log('parseAt');

await check('parseAt 接受 23:00 / 7:5', () => {
  assert.deepEqual(parseAt('23:00'), { hour: 23, minute: 0 });
  assert.deepEqual(parseAt('7:5'), { hour: 7, minute: 5 });
});

await check('parseAt 拒绝非法值', () => {
  for (const value of ['', '24:00', '23:60', 'x', '23', '23:0x', null]) {
    assert.equal(parseAt(value), null, `${value} 应当不合法`);
  }
});

console.log('pickModel');

await check('Config 指定 provider/model 时直接用', async () => {
  assert.deepEqual(await pickModel(fakeLlm(), { provider: 'x', model: 'y' }), { provider: 'x', model: 'y' });
});

await check('没配置时自动挑第一个有模型的 provider', async () => {
  assert.deepEqual(await pickModel(fakeLlm(), { settings: fakeSettings() }), { provider: 'prov-a', model: 'model-a' });
});

await check('listProviders 为空返回 null', async () => {
  assert.equal(await pickModel({ listProviders: () => [], listConfigurableProviders: () => [] }, {}), null);
  assert.equal(await pickModel({ listProviders: () => [{ id: 'p' }], listConfigurableProviders: () => [{ provider: 'p', settingsNs: 'x' }], listModels: () => [] }, {}), null);
});

await check('listModels 兜底可用', async () => {
  const llm = {
    listProviders: () => ['pp'],
    listConfigurableProviders: () => [{ provider: 'pp', settingsNs: 'ns-pp' }],
    listModels: (id) => (id === 'pp' ? ['mm'] : []),
  };
  assert.deepEqual(await pickModel(llm, {}), { provider: 'pp', model: 'mm' });
});

console.log('parseSentences');

await check('去编号/列表符/标题，不静默截断', () => {
  const text = ['# 今天', '1. 第一句。', '- 第二句。', '• 第三句。', '4、第四句。', '', '第五句。', '第六句。', '第七句。'].join('\n');
  const sentences = parseSentences(text);
  assert.deepEqual(sentences, ['第一句。', '第二句。', '第三句。', '第四句。', '第五句。', '第六句。', '第七句。']);
});

console.log('runDigest');

await check('没有流水时跳过，不报错', async () => {
  const vault = tempVault();
  const result = await runDigest({ vaultPath: vault, llm: fakeLlm(), settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'empty');
});

await check('有流水时收句并写 summary', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: '做收盘定时器', date: '2026-11-22' });
  await appendStream({ vaultPath: vault, kind: 'daily', content: '删掉旧的自动化任务', date: '2026-11-22' });
  const result = await runDigest({ vaultPath: vault, llm: fakeLlm(), settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
  assert.equal(result.provider, 'prov-a');
  const summary = fs.readFileSync(path.join(vault, 'Daily', '2026-11-22.summary.md'), 'utf8');
  assert.match(summary, /^# 2026-11-22 收盘/);
  assert.match(summary, /- 主人要求把收盘写进插件/);
  assert.match(summary, /- 插件用自己的定时器/);
});

await check('已有 summary 时幂等跳过', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  await runDigest({ vaultPath: vault, llm: fakeLlm(), settings: fakeSettings(), date: '2026-11-22' });
  const again = await runDigest({ vaultPath: vault, llm: fakeLlm(['别的句子。', '另一个。', '第三个。']), date: '2026-11-22' });
  assert.equal(again.ok, true);
  assert.equal(again.skipped, 'already');
  const summary = fs.readFileSync(path.join(vault, 'Daily', '2026-11-22.summary.md'), 'utf8');
  assert.doesNotMatch(summary, /别的句子/);
});

await check('模型抛错时留痕并返回失败', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const llm = {
    ...fakeLlm(),
    stream: () => {
      throw new Error('network down');
    },
  };
  const result = await runDigest({ vaultPath: vault, llm, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /调模型失败：network down/);
  const daily = readDaily(vault, '2026-11-22');
  assert.ok(daily.lines.some((line) => line.includes('调模型失败：network down')));
});

await check('账号型 provider 优先于官方直连', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const called = [];
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'deepseek-account' }],
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', settingsNs: 'ns-official' },
      { provider: 'deepseek-account', settingsNs: 'ns-account' },
    ],
    stream: ({ provider }) => {
      called.push(provider);
      if (provider !== 'deepseek-account') throw new Error('should not reach official');
      return (async function* () {
        for (const line of ['第一句完整的话。', '第二句完整的话。', '第三句完整的话。']) {
          yield { type: 'text-delta', text: `${line}\n` };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const settings = {
    describe: () => [
      { ns: 'ns-official', value: { models: [{ id: 'model-o' }] } },
      { ns: 'ns-account', value: { models: [{ id: 'model-a' }] } },
    ],
  };
  const result = await runDigest({ vaultPath: vault, llm, settings, date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'deepseek-account');
  assert.equal(result.model, 'model-a');
  assert.deepEqual(called, ['deepseek-account']);
});

await check('候选回退：第一个模型抛错时换下一个', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const called = [];
  const llm = {
    listProviders: () => [{ id: 'p1' }, { id: 'p2' }],
    listConfigurableProviders: () => [
      { provider: 'p1', settingsNs: 'ns-1' },
      { provider: 'p2', settingsNs: 'ns-2' },
    ],
    stream: ({ provider }) => {
      called.push(provider);
      if (provider === 'p1') throw new Error('auth failed');
      return (async function* () {
        for (const line of ['第一句完整的话。', '第二句完整的话。', '第三句完整的话。']) {
          yield { type: 'text-delta', text: `${line}\n` };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const settings = {
    describe: () => [
      { ns: 'ns-1', value: { models: [{ id: 'm1' }] } },
      { ns: 'ns-2', value: { models: [{ id: 'm2' }] } },
    ],
  };
  const result = await runDigest({ vaultPath: vault, llm, settings, date: '2026-11-22' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'p2');
  assert.equal(result.model, 'm2');
  assert.deepEqual(called, ['p1', 'p2']);
});

await check('模型句子不足时留痕', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const result = await runDigest({ vaultPath: vault, llm: fakeLlm(['只有一句。']), settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /句子不合格/);
});

await check('没有可用模型时留痕', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const result = await runDigest({ vaultPath: vault, llm: { listProviders: () => [] }, settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有可用的模型/);
});

console.log('scheduler');

await check('未到点不跑', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const dispose = startDigestScheduler({ ctx: { llm: fakeLlm(), settings: fakeSettings() }, vaultPath: vault, config: { digestAt: '23:00' }, log: { log() {}, warn() {} }, now: () => at(10, 0), tickMs: 60_000 });
  dispose();
  assert.equal(readDigestState(vault).lastRunDate, undefined);
});

await check('到点跑一次并写 state', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: '插件定时收盘', date: localDateStamp() });
  const dispose = startDigestScheduler({ ctx: { llm: fakeLlm(), settings: fakeSettings() }, vaultPath: vault, config: { digestAt: '23:00' }, log: { log() {}, warn() {} }, now: () => at(23, 5), tickMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  const state = readDigestState(vault);
  assert.equal(state.lastRunDate, localDateStamp());
  assert.equal(state.lastResult, 'ok');
  assert.ok(fs.existsSync(path.join(vault, 'Daily', `${localDateStamp()}.summary.md`)));
});

await check('当天第二次不重复跑', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const llm = fakeLlm();
  let calls = 0;
  const counting = {
    listProviders: llm.listProviders,
    listConfigurableProviders: llm.listConfigurableProviders,
    stream: (...args) => {
      calls += 1;
      return llm.stream(...args);
    },
  };
  const dispose = startDigestScheduler({ ctx: { llm: counting, settings: fakeSettings() }, vaultPath: vault, config: { digestAt: '23:00' }, log: { log() {}, warn() {} }, now: () => at(23, 5), tickMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  assert.equal(calls, 1);
});

await check('digestEnabled=false 不跑', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const dispose = startDigestScheduler({ ctx: { llm: fakeLlm(), settings: fakeSettings() }, vaultPath: vault, config: { digestEnabled: false }, log: { log() {}, warn() {} }, now: () => at(23, 30) });
  dispose();
  assert.equal(fs.existsSync(statePathOf(vault)), false);
});

await check('启动时补跑（已过点）', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: '补跑', date: localDateStamp() });
  const dispose = startDigestScheduler({ ctx: { llm: fakeLlm(), settings: fakeSettings() }, vaultPath: vault, config: { digestAt: '23:00' }, log: { log() {}, warn() {} }, now: () => at(23, 59), tickMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  assert.equal(readDigestState(vault).lastResult, 'ok');
});

await check('state 原子写，不留 .tmp', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: localDateStamp() });
  const dispose = startDigestScheduler({ ctx: { llm: fakeLlm(), settings: fakeSettings() }, vaultPath: vault, config: { digestAt: '23:00' }, log: { log() {}, warn() {} }, now: () => at(23, 5), tickMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  dispose();
  const dir = path.join(vault, '.dsh-memory');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}（${passed} 通过 / ${failed} 失败）`);
if (failed > 0) process.exit(1);
