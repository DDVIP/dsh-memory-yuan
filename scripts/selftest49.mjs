/**
 * L1 参数的运行期覆盖：读写、范围、清除、HTTP。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { L1_RANGES, clearL1Setting, effectiveL1Options, readL1Settings, writeL1Settings } from '../lib/l1settings.js';
import { createStateHandler } from '../lib/api.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-l1-'));
try {
  check('空库没有覆盖', () => {
    assert.deepEqual(readL1Settings(vault), {});
  });

  check('写一项覆盖', () => {
    const written = writeL1Settings(vault, { maxItems: 6 });
    assert.equal(written.ok, true);
    assert.deepEqual(written.settings, { maxItems: 6 });
    assert.deepEqual(readL1Settings(vault), { maxItems: 6 });
  });

  check('越界拒绝', () => {
    const written = writeL1Settings(vault, { maxItems: 99 });
    assert.equal(written.ok, false);
    assert.match(written.message, /之间/);
    assert.deepEqual(readL1Settings(vault), { maxItems: 6 });
  });

  check('非数字拒绝', () => {
    const written = writeL1Settings(vault, { minHits: 'abc' });
    assert.equal(written.ok, false);
    assert.match(written.message, /数字/);
  });

  check('清掉一项回到默认', () => {
    writeL1Settings(vault, { minScore: 7 });
    const cleared = clearL1Setting(vault, 'maxItems');
    assert.equal(cleared.ok, true);
    assert.deepEqual(readL1Settings(vault), { minScore: 7 });
  });

  check('effectiveL1Options 合并', () => {
    const effective = effectiveL1Options(vault, { maxItems: 4, minHits: 2, minScore: 4 });
    assert.deepEqual(effective, { maxItems: 4, minHits: 2, minScore: 7 });
    assert.equal(L1_RANGES.maxItems[0], 1);
  });

  // ---- HTTP ----
  const server = http.createServer(createStateHandler({ vaultPath: vault, budget: 4000 }));
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const base = `http://127.0.0.1:${port}/memory-yuan`;
  const call = async (method, pathname, body) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const got = await call('GET', '/l1');
    check('GET /l1 带范围与当前值', () => {
      assert.equal(got.status, 200);
      assert.equal(got.body.ok, true);
      assert.equal(got.body.ranges.maxItems[1], 12);
      assert.deepEqual(got.body.settings, { minScore: 7 });
    });

    const saved = await call('POST', '/l1', { maxItems: 8, minStrongHits: '' });
    check('POST /l1 改并清', () => {
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.settings, { maxItems: 8, minScore: 7 });
    });

    const bad = await call('POST', '/l1', { maxItems: 99 });
    check('POST /l1 越界 400', () => {
      assert.equal(bad.status, 400);
      assert.match(bad.body.message, /之间/);
    });
  } finally {
    server.close();
  }
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
