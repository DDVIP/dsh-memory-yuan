/**
 * 自测第七套：流水（Daily / Projects）的边界。
 *
 * 全部在临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendStream,
  isStreamFile,
  localDateStamp,
  readStream,
  safeProjectName,
  streamFile,
} from '../lib/stream.js';
import { loadMemories } from '../lib/vault.js';
import { createTools } from '../lib/tools.js';

let pass = 0;
const fails = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fails.push([name, error?.message ?? String(error)]);
    console.log(`  FAIL ${name} → ${error?.message ?? error}`);
  }
}

function fresh() {
  return mkdtempSync(join(tmpdir(), 'my7-'));
}

const LINE_RE = /^- \d{2}:\d{2} /;

console.log('== 自测 7：流水边界 ==');

await check('多行内容压成一行', () => {
  const vault = fresh();
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: '第一行\n第二行\r\n\n第三行' });
  assert.equal(r.ok, true);
  const text = readFileSync(r.path, 'utf8');
  assert.match(text, /第一行 第二行 第三行/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 1);
});

await check('内容空/全空白 → 拒绝', () => {
  const vault = fresh();
  assert.equal(appendStream({ vaultPath: vault, kind: 'daily', content: '' }).ok, false);
  assert.equal(appendStream({ vaultPath: vault, kind: 'daily', content: '  \n \t ' }).ok, false);
});

await check('同一天连写两行，顺序为写入顺序', () => {
  const vault = fresh();
  appendStream({ vaultPath: vault, kind: 'daily', content: 'A' });
  appendStream({ vaultPath: vault, kind: 'daily', content: 'B' });
  const text = readFileSync(join(vault, 'Daily', `${localDateStamp()}.md`), 'utf8');
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], / A$/);
  assert.match(lines[1], / B$/);
});

await check('项目名里的非法字符被替换', () => {
  assert.equal(safeProjectName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
});

await check('项目名为空 → 拒绝', () => {
  const vault = fresh();
  const r = appendStream({ vaultPath: vault, kind: 'project', content: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /project/);
});

await check('超长项目名被截断到 60 字', () => {
  const name = '项目'.repeat(50);
  const safe = safeProjectName(name);
  assert.ok(safe.length <= 60, `实际 ${safe.length}`);
});

await check('date 格式不对 → 拒绝', () => {
  const vault = fresh();
  for (const bad of ['2026-1-1', '20261122', '2026/11/22', 'x']) {
    assert.equal(appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: bad }).ok, false, bad);
  }
});

await check('假日期（2026-13-45） → 拒绝', () => {
  const vault = fresh();
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-13-45' });
  assert.equal(r.ok, false, '13 月 45 日不是合法日期');
});

await check('不存在的日子（2026-02-30 / 2026-04-31） → 拒绝', () => {
  const vault = fresh();
  for (const bad of ['2026-02-30', '2026-04-31', '2026-00-10']) {
    assert.equal(appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: bad }).ok, false, bad);
  }
  assert.equal(appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026-02-28' }).ok, true);
});

await check('超长内容（10KB）仍然一行', () => {
  const vault = fresh();
  const long = '长'.repeat(5000) + '\n' + '文'.repeat(5000);
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: long });
  assert.equal(r.ok, true);
  const text = readFileSync(r.path, 'utf8');
  assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, 1);
});

await check('vault 目录不存在时自动创建', () => {
  const base = fresh();
  const vault = join(base, 'deep', 'nested');
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: 'x' });
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.path));
});

await check('读不存在的流水 → ok:false 且有提示', () => {
  const vault = fresh();
  const r = readStream(vault, { kind: 'daily', date: '2000-01-01' });
  assert.equal(r.ok, false);
  assert.match(r.message, /还没有/);
});

await check('读流水 kind 非法 → 拒绝', () => {
  const vault = fresh();
  assert.equal(readStream(vault, { kind: 'weekly' }).ok, false);
});

await check('isStreamFile 只认 Daily/ 与 Projects/ 单层', () => {
  assert.equal(isStreamFile('Daily/2026-11-22.md'), true);
  assert.equal(isStreamFile('Daily\\2026-11-22.md'), true);
  assert.equal(isStreamFile('Projects/记忆插件.md'), true);
  assert.equal(isStreamFile('Projects/State/x.md'), false);
  assert.equal(isStreamFile('Decisions/x.md'), false);
  assert.equal(isStreamFile('Projects.md'), false);
});

await check('loadMemories 跳过流水，但保留 Projects/State 条目', () => {
  const vault = fresh();
  appendStream({ vaultPath: vault, kind: 'daily', content: '流水' });
  appendStream({ vaultPath: vault, kind: 'project', project: '测试项目', content: '流水' });
  mkdirSync(join(vault, 'Projects', 'State'), { recursive: true });
  writeFileSync(
    join(vault, 'Projects', 'State', '状态条目.md'),
    '---\nid: mem_x\ntype: project-state\nstatus: active\ntitle: 状态条目\nimportance: 50\n---\n\n## 核心内容\n\n内容\n',
    'utf8',
  );
  const list = loadMemories(vault);
  assert.equal(list.length, 1, `应只有 1 条，实际 ${list.map((m) => m.path).join(' | ')}`);
  assert.equal(list[0].title, '状态条目');
});

await check('工具层：append 缺 stream → 报错清楚', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const out = await tools.memory_write.execute({ mode: 'append', content: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.message, /kind/);
});

await check('工具层：append 成功且 render 说清楚', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const out = await tools.memory_write.execute({ mode: 'append', stream: 'daily', content: '今天做了点事' });
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'daily');
  const rendered = tools.memory_write.output.render({}, out);
  assert.match(rendered[0].text, /已追加 daily 流水/);
  assert.match(rendered[0].text, /今天做了点事/);
});

await check('工具层：memory_get stream 读回整篇', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  await tools.memory_write.execute({ mode: 'append', stream: 'daily', content: '可读回来' });
  const out = await tools.memory_get.execute({ stream: 'daily' });
  assert.equal(out.ok, true);
  assert.match(out.text, /可读回来/);
});

await check('内容以「- 」开头也不破坏列表结构', () => {
  const vault = fresh();
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: '- 本身就是列表项' });
  const text = readFileSync(r.path, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  assert.equal(lines.length, 1, `不该多出一行：${JSON.stringify(lines)}`);
  assert.match(lines[0], LINE_RE);
});

await check('手写过的项目流水文件不会被覆盖标题', () => {
  const vault = fresh();
  const dir = join(vault, 'Projects');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '手写.md');
  writeFileSync(file, '# 我自己的标题\n\n- 09:00 原有内容\n', 'utf8');
  const r = appendStream({ vaultPath: vault, kind: 'project', project: '手写', content: '新的一行' });
  assert.equal(r.ok, true);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.match(/我自己的标题/g).length, 1);
  assert.match(text, /原有内容/);
  assert.match(text, /新的一行/);
});

await check('同一分钟两行时间戳相同但都保留', () => {
  const vault = fresh();
  const at = new Date(2026, 10, 22, 9, 5, 0);
  appendStream({ vaultPath: vault, kind: 'daily', content: '一', at });
  appendStream({ vaultPath: vault, kind: 'daily', content: '二', at });
  const text = readFileSync(join(vault, 'Daily', '2026-11-22.md'), 'utf8');
  const lines = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /- 09:05 一/);
  assert.match(lines[1], /- 09:05 二/);
});

await check('指定 date 写到那一天的文件', () => {
  const vault = fresh();
  const r = appendStream({ vaultPath: vault, kind: 'daily', content: '补记', date: '2026-11-01' });
  assert.equal(r.ok, true);
  assert.match(r.path, /2026-11-01\.md$/);
  assert.equal(r.date, '2026-11-01');
});

await check('append 后 index 里没有流水（工具层）', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  await tools.memory_write.execute({ mode: 'append', stream: 'daily', content: '流水不该进索引' });
  const { readState } = await import('../lib/snapshot.js');
  const state = readState(vault);
  const entries = state.index?.entries ?? [];
  assert.equal(entries.length, 0, `索引里有 ${entries.length} 条`);
});

console.log(`\n自测 7：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('失败详情：');
  for (const [name, message] of fails) console.log(` - ${name}: ${message}`);
  process.exitCode = 1;
}
