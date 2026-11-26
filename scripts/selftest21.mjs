/**
 * 流水来源标记要可扩展：家里 / 工作 / 记忆插件 / room插件 / 以后新会话。
 * 不设白名单，只限长度、剥方括号；读侧兼容旧行（无标记按家里）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendStream } from '../lib/stream.js';
import { readDaily } from '../lib/digest.js';
import { readTodayStream } from '../lib/snapshot.js';

let pass = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-21-'));
const at = new Date('2026-11-23T09:10:00');

await check('任意来源名都能写：room插件', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '起新会话', by: 'room插件', at });
  assert.equal(out.line, '- 09:10 [room插件] 起新会话');
});

await check('readDaily 原样读回 room插件', () => {
  const daily = readDaily(vault, '2026-11-23');
  const item = daily.items.find((row) => row.text === '起新会话');
  assert.equal(item.by, 'room插件');
});

await check('来源名里的方括号被剥掉（不破坏行格式）', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '带括号', by: '[坏]名字', at });
  assert.equal(out.line, '- 09:10 [坏名字] 带括号');
});

await check('超长来源名截到 24 字', () => {
  const long = '很长的来源名字'.repeat(6);
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '超长', by: long, at });
  const tag = /^\[([^\]]+)\]/.exec(out.line.replace('- 09:10 ', ''))[1];
  assert.ok(tag.length <= 24, `tag=${tag.length}`);
});

await check('不传 by：不写标记（旧格式兼容）', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '没标来源', at });
  assert.equal(out.line, '- 09:10 没标来源');
  const daily = readDaily(vault, '2026-11-23');
  assert.equal(daily.items.find((row) => row.text === '没标来源').by, '家里');
});

await check('面板读今天流水时也带 by', () => {
  const today = readTodayStream(vault, { date: '2026-11-23', limit: 10 });
  const row = today.lines.find((line) => line.text === '起新会话');
  assert.equal(row.by, 'room插件');
});

await check('项目流水同样支持来源标记', () => {
  const out = appendStream({ vaultPath: vault, kind: 'project', project: '记忆插件', content: '进度', by: '记忆插件', at });
  assert.match(out.line, /^- 09:10 \[记忆插件\] 进度$/);
});

console.log(`\nselftest21：${pass} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
