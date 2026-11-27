// 第 3 项（收盘失败可见性）：digest-state 记失败原因 + 面板手动重跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { readDigestState, recordDigestResult, runDigestNow } from '../lib/digest-scheduler.js';
import { createStateHandler } from '../lib/api.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function emptyVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-digest-ui-'));
}

// llm 的假实现：listProviders 给出一个「可用」的 provider，stream 吐一句话。
function fakeLlm(text) {
  return {
    listProviders: () => ['fake-x'],
    listConfigurableProviders: () => [{ provider: 'fake-x', settingsNs: 'fake-x' }],
    stream: () =>
      (async function* () {
        yield { type: 'text-delta', text };
      })(),
  };
}

const fakeSettings = () => ({ get: () => ({ models: [{ id: 'fake-model' }] }) });

async function main() {
  await check('没跑过：state 里没有结果字段', () => {
    const vaultPath = emptyVault();
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult ?? '', '');
    assert.equal(state.lastError ?? '', '');
  });

  await check('记失败：原因与时间都落下', () => {
    const vaultPath = emptyVault();
    const now = new Date('2026-11-27T23:05:00+08:00');
    recordDigestResult(vaultPath, '2026-11-27', now, { ok: false, message: '模型 502，试了两次都没成' });
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult, 'failed');
    assert.match(state.lastError, /模型 502/);
    assert.equal(state.lastRunDate, '2026-11-27');
    assert.ok(state.lastRunAt);
  });

  await check('记成功：清掉上一次的错误', () => {
    const vaultPath = emptyVault();
    const now = new Date('2026-11-27T23:05:00+08:00');
    recordDigestResult(vaultPath, '2026-11-27', now, { ok: false, message: '第一次失败' });
    recordDigestResult(vaultPath, '2026-11-27', now, { ok: true, path: '/x/Daily/2026-11-27.summary.md' });
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult, 'ok');
    assert.equal(state.lastError, '');
    assert.equal(state.lastRunDate, '2026-11-27');
  });

  await check('当天没流水：跳过（不算失败），state 记 empty', async () => {
    const vaultPath = emptyVault();
    const result = await runDigestNow({ vaultPath, llm: fakeLlm('x'), settings: fakeSettings(), date: '2026-11-27' });
    assert.equal(result.skipped, 'empty');
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult, 'empty');
    assert.equal(state.lastError, '');
  });

  await check('没有可用模型：失败原因写进 state', async () => {
    const vaultPath = emptyVault();
    const daily = path.join(vaultPath, 'Daily');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, '2026-11-27.md'), '- 21:31 [记忆插件] 一条\n');
    const result = await runDigestNow({ vaultPath, llm: { listProviders: () => [], stream: null }, settings: fakeSettings(), date: '2026-11-27' });
    assert.equal(result.ok, false);
    assert.match(result.message, /没有可用的模型/);
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult, 'failed');
    assert.match(state.lastError, /没有可用的模型/);
  });

  await check('force 重跑：已有的摘要也会重新生成', async () => {
    const vaultPath = emptyVault();
    const daily = path.join(vaultPath, 'Daily');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, '2026-11-27.md'), '- 21:31 [记忆插件] 今天改了几个地方\n- 21:40 [记忆插件] 又改了一个\n');
    fs.writeFileSync(path.join(daily, '2026-11-27.summary.md'), '旧摘要\n');

    const text = [
      '今天把记忆插件的收盘失败做成面板可见，失败时能看到原因。',
      '还给失败条加了手动重跑按钮。',
      '改完跑了全套测试，没有回归。',
    ].join('\n');
    const result = await runDigestNow({ vaultPath, llm: fakeLlm(text), settings: fakeSettings(), date: '2026-11-27', force: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const summary = fs.readFileSync(path.join(daily, '2026-11-27.summary.md'), 'utf8');
    assert.match(summary, /面板可见/);
    const state = readDigestState(vaultPath);
    assert.equal(state.lastResult, 'ok');
    // 手动重跑不能把当天标记成「已收盘」——否则晚上 23:00 的自动收盘会以为跑过了。
    assert.equal(state.lastRunDate ?? '', '');
  });

  await check('不加 force：已有摘要直接跳过', async () => {
    const vaultPath = emptyVault();
    const daily = path.join(vaultPath, 'Daily');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, '2026-11-27.md'), '- 21:31 [记忆插件] 一条\n');
    fs.writeFileSync(path.join(daily, '2026-11-27.summary.md'), '旧摘要\n');
    const result = await runDigestNow({ vaultPath, llm: fakeLlm('x'), settings: fakeSettings(), date: '2026-11-27', force: false });
    assert.equal(result.skipped, 'already');
  });

  await check('GET /state 带 digest（没失败时为空串）', async () => {
    const vaultPath = emptyVault();
    const server = createServer(createStateHandler({ vaultPath }));
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/state`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.ok(body.digest);
      assert.equal(body.digest.lastResult ?? '', '');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('GET /state 带 digest（有失败时能看到原因）', async () => {
    const vaultPath = emptyVault();
    recordDigestResult(vaultPath, '2026-11-27', new Date(), { ok: false, message: '模型超时' });
    const server = createServer(createStateHandler({ vaultPath }));
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/state`);
      const body = await response.json();
      assert.equal(body.digest.lastResult, 'failed');
      assert.match(body.digest.lastError, /模型超时/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('POST /digest/run 没模型能力：501', async () => {
    const vaultPath = emptyVault();
    const server = createServer(createStateHandler({ vaultPath, digest: { run: null } }));
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/digest/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      assert.equal(response.status, 501);
      assert.match(body.message, /没有模型能力/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('POST /digest/run 有模型能力：调 run 并返回结果', async () => {
    const vaultPath = emptyVault();
    const calls = [];
    const digest = {
      run: async (opts) => {
        calls.push(opts);
        return { ok: true, path: '/x/summary.md', skipped: false };
      },
    };
    const server = createServer(createStateHandler({ vaultPath, digest }));
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/digest/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-27', force: false }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].date, '2026-11-27');
      assert.equal(calls[0].force, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check('POST /digest/run 抛错：500 带原因', async () => {
    const vaultPath = emptyVault();
    const digest = {
      run: async () => {
        throw new Error('模型 502');
      },
    };
    const server = createServer(createStateHandler({ vaultPath, digest }));
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/digest/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.match(body.message, /502/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
