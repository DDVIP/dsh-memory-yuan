/**
 * selftest14：第二轮自测——跨模块与真实使用边界（2026-11-22）。
 *
 * 覆盖：
 * - memory_digest 工具：写收盘后可读回 previous、重复写幂等
 * - 收盘摘要不参与检索/索引（不进 loadMemories、不进 index.json）
 * - memory_write append project 往返（memory_get stream=project）
 * - 同一文件并发写 summary 不损坏
 * - HTTP GET /state 在 .dsh-memory 不存在时自动建目录
 * - supersede 一条记忆不影响当天流水读取
 * - scheduler 在 vault 不存在时不崩，并落下 state
 * - 模型返回空输出（0 句）时留痕失败
 * - dispose 重复调用安全
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { loadMemories } from '../lib/vault.js';
import { appendStream, localDateStamp, readStream } from '../lib/stream.js';
import { readDaily, summaryPathOf, writeSummary } from '../lib/digest.js';
import {
  readDigestState,
  runDigest,
  startDigestScheduler,
  statePathOf,
} from '../lib/digest-scheduler.js';
import { createMemory } from '../lib/store.js';
import { createStateHandler } from '../lib/api.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-14-'));
}

function toolsOf(vaultPath) {
  return Object.fromEntries(createTools({ vaultPath }).map((tool) => [tool.name, tool]));
}

const exec = { sessionId: 'selftest14' };

function fakeLlm({ lines = ['一。', '二。', '三。'] } = {}) {
  return {
    listProviders: () => [{ id: 'p1' }],
    listConfigurableProviders: () => [{ provider: 'p1', settingsNs: 'ns-1' }],
    stream: () => (async function* () {
      for (const line of lines) yield { type: 'text-delta', text: `${line}\n` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  };
}

function fakeSettings() {
  return { describe: () => [{ ns: 'ns-1', value: { models: [{ id: 'm1' }] } }] };
}

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
      return this;
    },
    end(chunk) {
      this.body += chunk ?? '';
    },
  };
  return res;
}

function mockReq(method, url, body) {
  const handlers = {};
  return {
    method,
    url,
    on(event, callback) {
      handlers[event] = callback;
      if (event === 'data' && body !== undefined) callback(Buffer.from(body));
      if (event === 'end') callback();
      return this;
    },
  };
}

const tickOnce = () => new Promise((resolve) => setTimeout(resolve, 20));

console.log('memory_digest 工具');

await check('写收盘后用 memory_digest 读回 previous，重复写幂等', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: '做了一件事', date: '2026-11-22' });
  const tools = toolsOf(vault);
  const first = await tools.memory_digest.execute({ date: '2026-11-22', sentences: ['做了一件事，并写进收盘。', '确认了幂等。', '流水还留着。'] }, exec);
  assert.equal(first.ok, true);
  const firstText = fs.readFileSync(summaryPathOf(vault, '2026-11-22'), 'utf8');
  const readBack = await tools.memory_digest.execute({ date: '2026-11-22' }, exec);
  assert.equal(readBack.ok, true);
  assert.match(readBack.previous, /做了一件事，并写进收盘/);
  const second = await tools.memory_digest.execute({ date: '2026-11-22', sentences: ['做了一件事，并写进收盘。', '确认了幂等。', '流水还留着。'] }, exec);
  assert.equal(second.ok, true);
  assert.equal(fs.readFileSync(summaryPathOf(vault, '2026-11-22'), 'utf8'), firstText);
});

await check('收盘摘要不参与检索、不进 index', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  writeSummary(vault, { date: '2026-11-22', sentences: ['甲。', '乙。', '丙。'] });
  createMemory({ vaultPath: vault, type: 'knowledge', title: '真记忆', content: '真正的条目。' });
  const memories = loadMemories(vault);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].title, '真记忆');
  const res = mockRes();
  const handler = createStateHandler({ vaultPath: vault });
  await handler({ method: 'GET', url: '/memory-yuan/state' }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('收盘'));
});

console.log('流水与条目互不影响');

await check('append project 往返（memory_get stream=project）', async () => {
  const vault = tempVault();
  const tools = toolsOf(vault);
  const written = await tools.memory_write.execute({ mode: 'append', stream: 'project', project: '记忆插件', content: '补了一条项目进展' }, exec);
  assert.equal(written.ok, true);
  const read = await tools.memory_get.execute({ stream: 'project', project: '记忆插件' }, exec);
  assert.equal(read.ok, true);
  assert.match(read.text, /补了一条项目进展/);
});

await check('supersede 一条记忆不影响当天流水读取', async () => {
  const vault = tempVault();
  const created = createMemory({ vaultPath: vault, type: 'decision', title: '旧决定', content: '旧内容。' });
  await appendStream({ vaultPath: vault, kind: 'daily', content: '照旧做事', date: '2026-11-22' });
  const handler = createStateHandler({ vaultPath: vault });
  const okRes = mockRes();
  await handler(mockReq('POST', '/memory-yuan/supersede', JSON.stringify({ id: created.id })), okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(JSON.parse(okRes.body).ok, true);
  const daily = readDaily(vault, '2026-11-22');
  assert.ok(daily.lines.some((line) => line.includes('照旧做事')));
});

await check('同一文件并发写 summary 不损坏', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  await Promise.all([
    Promise.resolve().then(() => writeSummary(vault, { date: '2026-11-22', sentences: ['甲。', '乙。', '丙。'] })),
    Promise.resolve().then(() => writeSummary(vault, { date: '2026-11-22', sentences: ['丁。', '戊。', '己。'] })),
  ]);
  const text = fs.readFileSync(summaryPathOf(vault, '2026-11-22'), 'utf8');
  assert.match(text, /^# 2026-11-22 收盘/);
  assert.ok(text.endsWith('\n\n'));
});

console.log('HTTP 与 scheduler 边界');

await check('GET /state 在 .dsh-memory 不存在时自动建目录', async () => {
  const vault = tempVault();
  const res = mockRes();
  await createStateHandler({ vaultPath: vault })({ method: 'GET', url: '/memory-yuan/state' }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(fs.existsSync(path.join(vault, '.dsh-memory', 'index.json')));
});

await check('scheduler 在 vault 不存在时不崩，并落下 state', async () => {
  const vault = path.join(tempVault(), '不存在', '还是不存在');
  const dispose = startDigestScheduler({
    ctx: { llm: fakeLlm(), settings: fakeSettings() },
    vaultPath: vault,
    config: { digestAt: '23:00' },
    log: { log() {}, warn() {} },
    now: () => {
      const value = new Date();
      value.setHours(23, 5, 0, 0);
      return value;
    },
  });
  await tickOnce();
  assert.equal(typeof dispose, 'function');
  assert.ok(fs.existsSync(statePathOf(vault)));
  dispose();
  dispose();
});

await check('模型返回空输出（0 句）时留痕失败', async () => {
  const vault = tempVault();
  await appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-11-22' });
  const result = await runDigest({ vaultPath: vault, llm: fakeLlm({ lines: [] }), settings: fakeSettings(), date: '2026-11-22' });
  assert.equal(result.ok, false);
  assert.match(result.message, /0 句/);
  const daily = readDaily(vault, '2026-11-22');
  assert.ok(daily.lines.some((line) => line.includes('收盘没跑成')));
});

await check('readStream 读不存在的项目流水返回「还没有」', () => {
  const vault = tempVault();
  const result = readStream(vault, { kind: 'project', project: '没这个项目' });
  assert.equal(result.ok, false);
  assert.match(result.message, /还没有/);
});

console.log(`\nselftest14：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
