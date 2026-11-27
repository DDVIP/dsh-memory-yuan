// 自测 45：写入时自动认截止时间（lib/expiry.js + memory_write 的 expiresAuto）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { detectExpiry } from '../lib/expiry.js';
import { loadMemories } from '../lib/vault.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const NOW = new Date('2026-11-27T12:00:00+08:00');

await check('认 11-29 截止', () => {
  const found = detectExpiry('AI 全民制作人活动，投稿 11-29 截止', { now: NOW });
  assert.equal(found?.date, '2026-11-29');
});

await check('认完整日期的截止', () => {
  const found = detectExpiry('2026-11-29 24:00 截止', { now: NOW });
  assert.equal(found?.date, '2026-11-29');
});

await check('认中文日期的截止', () => {
  const found = detectExpiry('2026年11月29日截止投稿', { now: NOW });
  assert.equal(found?.date, '2026-11-29');
});

await check('没有截止语义就不标', () => {
  assert.equal(detectExpiry('今天是 2026-11-27，更新了一条记忆', { now: NOW }), null);
});

await check('已经过去的日期不标', () => {
  assert.equal(detectExpiry('活动 2020-01-01 截止', { now: NOW }), null);
});

await check('区间取结束日', () => {
  const found = detectExpiry('投稿 9月28日 到 11月29日 截止', { now: NOW });
  assert.equal(found?.date, '2026-11-29');
});

await check('跨年补明年', () => {
  const found = detectExpiry('12 月底的活动 1月5日 截止', { now: new Date('2026-12-20T12:00:00+08:00') });
  assert.equal(found?.date, '2027-01-05');
});

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'my-expiry-'));
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));

let autoId;
await check('写入时自动标过期日', async () => {
  const result = await tools.memory_write.execute({
    title: 'AI 全民制作人活动',
    type: 'project-state',
    content: '投稿 11-29 截止，要求 60 秒以上。',
    tags: ['视频', '活动'],
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.expiresAuto, true);
  assert.equal(result.expires, '2026-11-29');
  autoId = result.id;
  const memory = loadMemories(vault).find((item) => item.id === autoId);
  assert.equal(memory.expires, '2026-11-29');
  const text = fs.readFileSync(memory.path, 'utf8');
  assert.match(text, /^expires: 2026-11-29$/m);
});

await check('render 说明是自动认的', async () => {
  const result = await tools.memory_write.execute({
    title: '活动二',
    type: 'project-state',
    content: '投稿 12-15 截止。',
  });
  assert.equal(result.ok, true);
  assert.equal(result.expiresAuto, true);
  assert.equal(result.expires, '2026-12-15');
  const rendered = tools.memory_write.output.render({}, result);
  const text = rendered.map((part) => part.text).join('\n');
  assert.match(text, /自动认出了截止时间/);
  assert.match(text, /2026-12-15/);
});

await check('显式传的 expires 优先', async () => {
  const result = await tools.memory_write.execute({
    title: '带显式过期日',
    type: 'knowledge',
    content: '11-29 截止，但我知道其实是 12-01。',
    expires: '2026-12-01',
  });
  assert.equal(result.ok, true);
  assert.equal(result.expires, '2026-12-01');
  assert.equal(result.expiresAuto, undefined);
});

await check('没有截止词就不带 expires', async () => {
  const result = await tools.memory_write.execute({
    title: '普通记录',
    type: 'knowledge',
    content: '2026-11-27 今天修了星图缩放。',
  });
  assert.equal(result.ok, true);
  assert.equal(result.expires, undefined);
  assert.equal(result.expiresAuto, undefined);
});

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('  FAIL')).length;
console.log(`\n${results.length - failed} 通过，${failed} 失败`);
