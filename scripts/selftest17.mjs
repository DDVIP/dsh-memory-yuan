/**
 * selftest17：第二轮挑边界（「今天流水」数据面）。
 *
 * 覆盖：
 * - 内容里带「- 」不破坏解析
 * - 超长行（5000 字符）能读回完整
 * - 时间乱序时按文件顺序显示（记录行为，不做排序）
 * - 中文标点 / emoji / tab 往返
 * - 23:59 边界
 * - Daily/<date>.md 是目录时不抛错
 * - limit=0 返回空
 * - Projects/ 的流水不影响 today
 * - 同一分钟两行都保留
 * - 只有标题没有流水行 → 空
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readTodayStream } from '../lib/snapshot.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-today2-'));
  fs.mkdirSync(path.join(dir, 'Daily'), { recursive: true });
  return dir;
}

function writeDaily(vault, date, body) {
  fs.writeFileSync(path.join(vault, 'Daily', `${date}.md`), body, 'utf8');
}

async function main() {
  const vault = tempVault();
  const date = '2026-11-23';

  await check('内容里带「- 」不破坏解析', () => {
    writeDaily(vault, '2026-01-01', '- 10:00 说明：- 不是列表项\n');
    const got = readTodayStream(vault, { date: '2026-01-01' });
    assert.deepEqual(got.lines, [{ time: '10:00', by: '家里', text: '说明：- 不是列表项' }]);
  });

  await check('超长行（5000 字符）完整读回', () => {
    const long = '长'.repeat(5000);
    writeDaily(vault, '2026-01-02', `- 10:00 ${long}\n`);
    const got = readTodayStream(vault, { date: '2026-01-02' });
    assert.equal(got.lines.length, 1);
    assert.equal(got.lines[0].text.length, 5000);
  });

  await check('时间乱序按文件顺序显示（不排序）', () => {
    writeDaily(vault, '2026-01-03', '- 15:00 后面写的\n- 09:00 前面写的\n');
    const got = readTodayStream(vault, { date: '2026-01-03' });
    assert.deepEqual(got.lines.map((line) => line.time), ['15:00', '09:00']);
  });

  await check('中文标点 / emoji / tab 往返', () => {
    writeDaily(vault, '2026-01-04', '- 10:00 嗯，这里有个 \t Tab 和 🐟 emoji！\n');
    const got = readTodayStream(vault, { date: '2026-01-04' });
    assert.equal(got.lines[0].text, '嗯，这里有个 \t Tab 和 🐟 emoji！');
  });

  await check('23:59 边界能读', () => {
    writeDaily(vault, '2026-01-05', '- 23:59 最后一分钟\n');
    assert.deepEqual(
      readTodayStream(vault, { date: '2026-01-05' }).lines.map((line) => line.time),
      ['23:59'],
    );
  });

  await check('Daily/<date>.md 是目录时不抛错', () => {
    fs.mkdirSync(path.join(vault, 'Daily', '2026-01-06.md'));
    const got = readTodayStream(vault, { date: '2026-01-06' });
    assert.deepEqual(got.lines, []);
  });

  await check('limit=0 返回空', () => {
    writeDaily(vault, '2026-01-07', '- 10:00 x\n');
    assert.deepEqual(readTodayStream(vault, { date: '2026-01-07', limit: 0 }).lines, []);
  });

  await check('Projects/ 的流水不进 today', () => {
    fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Projects', '项目甲.md'), '- 10:00 项目流水\n', 'utf8');
    writeDaily(vault, '2026-01-08', '- 11:00 每日流水\n');
    const got = readTodayStream(vault, { date: '2026-01-08' });
    assert.deepEqual(got.lines, [{ time: '11:00', by: '家里', text: '每日流水' }]);
  });

  await check('同一分钟两行都保留', () => {
    writeDaily(vault, '2026-01-09', '- 10:00 甲\n- 10:00 乙\n');
    assert.deepEqual(
      readTodayStream(vault, { date: '2026-01-09' }).lines.map((line) => line.text),
      ['甲', '乙'],
    );
  });

  await check('只有标题没有流水行 → 空', () => {
    writeDaily(vault, '2026-01-10', '# 2026-01-10 流水\n\n');
    assert.deepEqual(readTodayStream(vault, { date: '2026-01-10' }).lines, []);
  });

  await check('今天流水含 date 字段（面板标题用）', () => {
    writeDaily(vault, '2026-01-11', '- 10:00 x\n');
    assert.equal(readTodayStream(vault, { date: '2026-01-11' }).date, '2026-01-11');
  });

  await check('真实 vault 的今天流水能读（不抛错）', () => {
    const real = path.join(os.homedir(), '.dsh', 'worlds', 'default', 'memory');
    const got = readTodayStream(real);
    assert.ok(Array.isArray(got.lines));
    assert.ok(typeof got.date === 'string' && got.date.length === 10);
    console.log(`       真实 vault ${got.date}：${got.lines.length} 条`);
  });

  console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
