// 面板看/改当天收盘：GET /summary 读、POST /summary 写（沿用 writeSummary 的句子校验）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { readSummary, writeSummary } from '../lib/digest.js';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-summary-ui-'));
}

const GOOD = ['今天把星图的位置记忆做完了。', '顺手补了自动认截止时间。', '面板加了看收盘的入口。'];

async function withServer(vaultPath, fn) {
  const server = createServer(createStateHandler({ vaultPath }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await check('没写过的日子：exists=false、sentences 空', () => {
    const vaultPath = emptyVault();
    const result = readSummary(vaultPath, '2026-11-20');
    assert.equal(result.ok, true);
    assert.equal(result.exists, false);
    assert.deepEqual(result.sentences, []);
  });

  await check('写进去再读回来：句子能拆回数组', () => {
    const vaultPath = emptyVault();
    const written = writeSummary(vaultPath, { date: '2026-11-20', sentences: GOOD });
    assert.equal(written.ok, true);
    const read = readSummary(vaultPath, '2026-11-20');
    assert.equal(read.exists, true);
    assert.deepEqual(read.sentences, GOOD);
    assert.ok(read.mtime, 'mtime 应该是时间戳');
  });

  await check('GET /summary 空库：200 且 exists=false', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary?date=2026-11-20`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.exists, false);
      assert.equal(body.date, '2026-11-20');
    });
  });

  await check('POST /summary 三句：200、写盘、再 GET 读得到', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-20', sentences: GOOD }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.sentences, GOOD);
      assert.ok(fs.existsSync(path.join(vaultPath, 'Daily', '2026-11-20.summary.md')));
      const again = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary?date=2026-11-20`);
      assert.deepEqual((await again.json()).sentences, GOOD);
    });
  });

  await check('POST /summary 两句：400（句子不够）', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: '2026-11-20', sentences: GOOD.slice(0, 2) }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.message, /句子/);
    });
  });

  await check('POST /summary 空数组：400', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentences: [] }),
      });
      assert.equal(response.status, 400);
    });
  });

  await check('改写同一天：覆盖 + 先备份旧版', async () => {
    const vaultPath = emptyVault();
    writeSummary(vaultPath, { date: '2026-11-20', sentences: GOOD });
    const next = ['改过的第一句。', '改过的第二句。', '改过的第三句。'];
    const rewritten = writeSummary(vaultPath, { date: '2026-11-20', sentences: next });
    assert.equal(rewritten.ok, true);
    assert.deepEqual(readSummary(vaultPath, '2026-11-20').sentences, next);
    const backups = path.join(vaultPath, '.dsh-memory', 'backups');
    const found = fs.existsSync(backups)
      ? fs.readdirSync(backups).filter((name) => name.includes('2026-11-20'))
      : [];
    assert.ok(found.length >= 1, `重写前应该备份旧版，backups 里没找到：${found.join(',')}`);
  });

  await check('GET /summary 坏日期：400', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary?date=2026-13-40`);
      assert.equal(response.status, 400);
    });
  });

  await check('POST /summary 不传 date：落到今天', async () => {
    const vaultPath = emptyVault();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/summary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentences: GOOD }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.date, body.today);
    });
  });

  console.log(`\n${fail ? '✗' : '✓'} selftest46：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main();
