/**
 * 流水（append）专项自测：Daily/YYYY-MM-DD.md 与 Projects/<项目名>.md。
 * 全部在临时 vault 里跑，不碰真实库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendStream, localDateStamp, readStream } from '../lib/stream.js';
import { createTools } from '../lib/tools.js';
import { loadMemories } from '../lib/vault.js';
import { writeIndex } from '../lib/snapshot.js';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✓ ${name}` + (detail === undefined ? '' : ` → ${JSON.stringify(detail)}`));
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name} → ${error?.message ?? error}`);
  }
}

function tempVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-stream-'));
}

const vault = tempVault();
const today = localDateStamp();

console.log('\n【1】追加 daily');
await check('写第一条', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '写记忆插件流水', at: new Date(2026, 10, 22, 15, 40) });
  assert.equal(out.ok, true);
  assert.match(out.path, /Daily[\\/]\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(fs.readFileSync(out.path, 'utf8'), /^- 15:40 写记忆插件流水$/m);
  return { line: out.line };
});
await check('同一天再追加：往后接，不覆盖', () => {
  appendStream({ vaultPath: vault, kind: 'daily', content: '第二条', at: new Date(2026, 10, 22, 16, 5) });
  const text = fs.readFileSync(path.join(vault, 'Daily', '2026-11-22.md'), 'utf8');
  assert.equal(text.match(/^- /gm).length, 2);
  assert.match(text, /^- 16:05 第二条$/m);
  return { lines: text.match(/^- .*$/gm) };
});
await check('多行内容压成一行', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '第一行\n第二行', at: new Date(2026, 10, 22, 17, 0) });
  assert.ok(!fs.readFileSync(out.path, 'utf8').includes('\n第二行'));
  return out.line;
});

console.log('\n【2】追加 project');
await check('写项目流水', () => {
  const out = appendStream({ vaultPath: vault, kind: 'project', project: '记忆插件', content: '流水接上了', at: new Date(2026, 10, 22, 15, 41) });
  assert.equal(out.ok, true);
  assert.ok(out.path.endsWith(path.join('Projects', '记忆插件.md')));
  return { path: out.path };
});
await check('项目名里的非法字符被替换', () => {
  const out = appendStream({ vaultPath: vault, kind: 'project', project: 'a/b:c*', content: 'x' });
  assert.equal(out.ok, true);
  assert.ok(!out.path.includes('/b:'));
  return { path: path.basename(out.path) };
});

console.log('\n【3】报错要直说');
await check('缺 content', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: '  ' });
  assert.equal(out.ok, false);
  assert.match(out.message, /content/);
  return out.message;
});
await check('date 不是 YYYY-MM-DD', () => {
  const out = appendStream({ vaultPath: vault, kind: 'daily', content: 'x', date: '2026/11/22' });
  assert.equal(out.ok, false);
  assert.match(out.message, /YYYY-MM-DD/);
  return out.message;
});
await check('kind 不认', () => {
  const out = appendStream({ vaultPath: vault, kind: 'week', content: 'x' });
  assert.equal(out.ok, false);
  return out.message;
});
await check('project 模式缺项目名', () => {
  const out = appendStream({ vaultPath: vault, kind: 'project', content: 'x' });
  assert.equal(out.ok, false);
  return out.message;
});

console.log('\n【4】流水不当记忆');
await check('loadMemories 跳过 Daily/ 与 Projects/*.md', () => {
  const memories = loadMemories(vault);
  assert.equal(memories.length, 0);
  return { count: memories.length };
});
await check('Projects/State/ 里的条目仍然算记忆', () => {
  const dir = path.join(vault, 'Projects', 'State');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '底账.md'),
    '---\nid: mem_state_1\ntype: project-state\nstatus: active\ntitle: 底账\nimportance: 70\n---\n\n## 核心内容\n\n房间里有五个文件。\n',
    'utf8',
  );
  const memories = loadMemories(vault);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].id, 'mem_state_1');
  return { count: memories.length };
});
await check('index.json 里不出现流水文件', () => {
  writeIndex(vault);
  const index = JSON.parse(fs.readFileSync(path.join(vault, '.dsh-memory', 'index.json'), 'utf8'));
  const paths = index.entries.map((entry) => entry.path);
  assert.ok(paths.every((file) => !/Daily[\\/]|Projects[\\/][^\\/]+\.md$/.test(file)));
  return { entries: index.entries.length };
});

console.log('\n【5】整篇读回');
await check('readStream 读 daily', () => {
  const out = readStream(vault, { kind: 'daily', date: '2026-11-22' });
  assert.equal(out.ok, true);
  assert.match(out.text, /写记忆插件流水/);
  return { chars: out.text.length };
});
await check('readStream 读不存在的项目', () => {
  const out = readStream(vault, { kind: 'project', project: '从来没有的项目' });
  assert.equal(out.ok, false);
  return out.message;
});

console.log('\n【6】工具层');
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
await check('memory_write mode=append stream=daily', async () => {
  const value = await tools.memory_write.execute({ mode: 'append', stream: 'daily', content: '从工具追加的一行' });
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'append');
  assert.match(value.line, /^- \d{2}:\d{2} 从工具追加的一行$/);
  return { path: value.path, line: value.line };
});
await check('memory_write mode=append stream=project', async () => {
  const value = await tools.memory_write.execute({ mode: 'append', stream: 'project', project: '记忆插件', content: '工具里写项目流水' });
  assert.equal(value.ok, true);
  assert.equal(value.kind, 'project');
  return { path: value.path };
});
await check('memory_write 认不出的 mode', async () => {
  const value = await tools.memory_write.execute({ mode: 'replace', title: 'x', type: 'knowledge', content: 'y' });
  assert.equal(value.ok, false);
  return value.message;
});
await check('memory_get 用 stream=daily 整篇读', async () => {
  const value = await tools.memory_get.execute({ stream: 'daily', date: today });
  assert.equal(value.ok, true);
  assert.equal(value.kind, 'daily');
  assert.match(value.text, /从工具追加的一行/);
  return { chars: value.text.length };
});
await check('memory_get 既没 id 也没 stream', async () => {
  const value = await tools.memory_get.execute({});
  assert.equal(value.ok, false);
  assert.match(value.message, /stream/);
  return value.message;
});
await check('memory_write 的 append 渲染不报错', () => {
  const value = { ok: true, mode: 'append', kind: 'daily', date: today, line: '- 15:40 x', path: 'p' };
  const out = tools.memory_write.output.render({}, value);
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /已追加/);
  return out[0].text.split('\n')[0];
});
await check('memory_write 的 create 渲染把 md / index 分开说', () => {
  const out = tools.memory_write.output.render(
    {},
    { ok: true, mode: 'create', type: 'knowledge', title: 'x', path: 'p', md: 'ok', index: 'failed', indexError: 'EACCES: permission denied' },
  );
  assert.match(out[0].text, /md：ok；索引：failed/);
  assert.match(out[0].text, /EACCES/);
  return 'ok';
});

console.log('\n【7】索引失败不冒充写失败');
const brokenVault = tempVault();
fs.writeFileSync(path.join(brokenVault, '.dsh-memory'), 'not a dir', 'utf8');
const brokenTools = Object.fromEntries(createTools({ vaultPath: brokenVault }).map((tool) => [tool.name, tool]));
await check('md 写成、index 失败：ok=true + index=failed + 带原始错误', async () => {
  const value = await brokenTools.memory_write.execute({ title: '索引坏了也要能写', type: 'knowledge', content: 'md 落盘优先。' });
  assert.equal(value.ok, true);
  assert.equal(value.md, 'ok');
  assert.equal(value.index, 'failed');
  assert.match(String(value.indexError), /\S/);
  assert.ok(fs.existsSync(value.path));
  return { indexError: String(value.indexError).slice(0, 60) };
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exitCode = 1;
