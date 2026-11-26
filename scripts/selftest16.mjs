/**
 * selftest16：面板「今天流水」块的数据（readTodayStream / readState.today）。
 *
 * 覆盖：
 * - 文件不存在 / 空文件 → lines []
 * - 7 条取最后 5 条，顺序保持
 * - 非 `- HH:mm 文本` 行被忽略（标题、无序列表符不对、一位数小时、缺分钟）
 * - 空文本行被过滤
 * - CRLF 兼容
 * - date 参数指定日期
 * - limit 参数生效
 * - readState().today 与 readTodayStream() 一致
 * - HTTP GET /state 带 today
 * - 「昨天有、今天没有」→ 今天空
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readTodayStream, readState } from '../lib/snapshot.js';
import { createStateHandler } from '../lib/api.js';
import { appendStream, localDateStamp } from '../lib/stream.js';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? String(error)}`);
  }
}

function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-today-'));
  fs.mkdirSync(path.join(dir, 'Daily'), { recursive: true });
  return dir;
}

function writeDaily(vault, date, body) {
  fs.writeFileSync(path.join(vault, 'Daily', `${date}.md`), body, 'utf8');
}

async function main() {
  const vault = tempVault();
  const date = '2026-11-23';

  await check('文件不存在时返回空流水', () => {
    const got = readTodayStream(vault, { date: '2026-01-01' });
    assert.deepEqual(got.lines, []);
    assert.equal(got.date, '2026-01-01');
  });

  await check('空文件返回空流水', () => {
    writeDaily(vault, '2026-01-02', '# 2026-01-02 流水\n\n');
    assert.deepEqual(readTodayStream(vault, { date: '2026-01-02' }).lines, []);
  });

  await check('7 条取最后 5 条且顺序保持', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `- 1${i}:00 第${i + 1}条`).join('\n');
    writeDaily(vault, date, `# ${date} 流水\n\n${lines}\n`);
    const got = readTodayStream(vault, { date });
    assert.equal(got.lines.length, 5);
    assert.deepEqual(
      got.lines.map((line) => line.text),
      ['第3条', '第4条', '第5条', '第6条', '第7条'],
    );
    assert.deepEqual(
      got.lines.map((line) => line.time),
      ['12:00', '13:00', '14:00', '15:00', '16:00'],
    );
  });

  await check('非流水行被忽略（标题、一位数小时、缺分钟、星号列表）', () => {
    writeDaily(
      vault,
      '2026-01-03',
      [
        '# 2026-01-03 流水',
        '* 10:00 星号不是流水',
        '- 9:05 一位数小时',
        '- 10:5 缺分钟',
        '- 10:00 这是流水',
        'plain text',
      ].join('\n'),
    );
    const got = readTodayStream(vault, { date: '2026-01-03' });
    assert.deepEqual(got.lines, [{ time: '10:00', by: '家里', text: '这是流水' }]);
  });

  await check('空文本行被过滤', () => {
    writeDaily(vault, '2026-01-04', '- 10:00 有内容\n- 10:01   \n- 10:02 \n');
    const got = readTodayStream(vault, { date: '2026-01-04' });
    assert.deepEqual(got.lines, [{ time: '10:00', by: '家里', text: '有内容' }]);
  });

  await check('CRLF 文件能读', () => {
    writeDaily(vault, '2026-01-05', '# t\r\n- 09:00 甲\r\n- 09:01 乙\r\n');
    const got = readTodayStream(vault, { date: '2026-01-05' });
    assert.deepEqual(got.lines.map((line) => line.text), ['甲', '乙']);
  });

  await check('limit 参数生效（limit=2）', () => {
    writeDaily(vault, '2026-01-06', '- 10:00 a\n- 10:01 b\n- 10:02 c\n');
    assert.deepEqual(
      readTodayStream(vault, { date: '2026-01-06', limit: 2 }).lines.map((line) => line.text),
      ['b', 'c'],
    );
  });

  await check('readState().today 与 readTodayStream 一致', () => {
    const state = readState(vault);
    const direct = readTodayStream(vault, { date: state.today.date });
    assert.deepEqual(state.today, direct);
  });

  await check('HTTP GET /state 带 today', async () => {
    writeDaily(vault, localDateStamp(), '- 11:11 今天这条\n');
    const handler = createStateHandler({ vaultPath: vault });
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(body) {
        this.body = body ?? '';
      },
    };
    await handler({ method: 'GET', url: '/memory-yuan/state' }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.today, 'state 里应有 today');
    assert.equal(body.today.date, localDateStamp());
    assert.deepEqual(body.today.lines, [{ time: '11:11', by: '家里', text: '今天这条' }]);
  });

  await check('昨天有流水、今天没有 → 今天空', async () => {
    const other = tempVault();
    appendStream({ vaultPath: other, kind: 'daily', content: '昨天的事', at: new Date('2026-11-22T20:00:00') });
    const got = readTodayStream(other, { date: '2026-11-23' });
    assert.deepEqual(got.lines, []);
    assert.equal(readTodayStream(other, { date: '2026-11-22' }).lines.length, 1);
  });

  await check('appendStream 写的行能被 readTodayStream 读回（端到端）', () => {
    const endToEnd = tempVault();
    appendStream({ vaultPath: endToEnd, kind: 'daily', content: '端到端一条', at: new Date('2026-11-23T08:30:00') });
    const got = readTodayStream(endToEnd, { date: '2026-11-23' });
    assert.equal(got.lines.length, 1);
    assert.equal(got.lines[0].time, '08:30');
    assert.equal(got.lines[0].text, '端到端一条');
  });

  console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
