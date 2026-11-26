/**
 * 自测 22：vault 读缓存 + 索引按指纹重建。
 *
 * 1 和 2 是「不提速也能用、提速了更省」的优化：
 *   - loadMemories 按「路径+mtime+大小」指纹缓存解析结果，文件没变不重读；
 *   - GET /state 只在 vault 变了才重建 index.json。
 *
 * 关键是不能缓存出陈旧数据：手改 md、删文件、加文件之后必须立刻看得到。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadMemories, vaultFingerprint } from '../lib/vault.js';
import { writeIndex, writeIndexIfChanged } from '../lib/snapshot.js';

const realReadFileSync = fs.readFileSync;
let readCalls = 0;
fs.readFileSync = (...args) => {
  readCalls += 1;
  return realReadFileSync.apply(fs, args);
};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-cache-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Knows'), { recursive: true });

const writeNote = (name, body) => {
  const file = path.join(vault, 'Knows', name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
};

const noteA = writeNote('a.md', '---\ntitle: 甲\nimportance: 50\n---\n\n## 核心内容\n\n第一条。\n');
const noteB = writeNote('b.md', '---\ntitle: 乙\nimportance: 30\n---\n\n## 核心内容\n\n第二条。\n');

console.log('vault 缓存与索引重建');

await check('不存在的 vault 指纹为空串', () => {
  assert.equal(vaultFingerprint(path.join(tmp, 'nope')), '');
});

await check('第一次读会把每个文件都读一遍', () => {
  readCalls = 0;
  const got = loadMemories(vault);
  assert.equal(got.length, 2);
  assert.ok(readCalls >= 2, `应至少读了 2 个文件，实际 ${readCalls}`);
});

await check('内容没变时第二次读不再读文件', () => {
  readCalls = 0;
  const got = loadMemories(vault);
  assert.equal(got.length, 2);
  assert.equal(readCalls, 0, `缓存命中时不该再读文件，实际读了 ${readCalls} 次`);
});

await check('改了文件内容立刻读到新内容（缓存失效）', () => {
  writeNote('a.md', '---\ntitle: 甲\nimportance: 50\n---\n\n## 核心内容\n\n改过的第一条。\n');
  const got = loadMemories(vault);
  const a = got.find((m) => m.title === '甲');
  assert.ok(a, '应找到「甲」');
  assert.match(a.core, /改过的第一条/);
});

await check('新增文件立刻出现', () => {
  writeNote('c.md', '---\ntitle: 丙\nimportance: 10\n---\n\n## 核心内容\n\n第三条。\n');
  const got = loadMemories(vault);
  assert.equal(got.length, 3);
});

await check('删除文件立刻消失', () => {
  fs.unlinkSync(noteB);
  const got = loadMemories(vault);
  assert.equal(got.length, 2);
  assert.ok(!got.some((m) => m.title === '乙'));
});

await check('空目录返回空数组且不炸', () => {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  assert.deepEqual(loadMemories(empty), []);
});

await check('writeIndexIfChanged：第一次重建', () => {
  assert.equal(writeIndexIfChanged(vault), true);
});

await check('writeIndexIfChanged：第二轮不重复重建', () => {
  assert.equal(writeIndexIfChanged(vault), false);
});

await check('writeIndexIfChanged：改了文件就重建', () => {
  writeNote('d.md', '---\ntitle: 丁\nimportance: 5\n---\n\n## 核心内容\n\n第四条。\n');
  assert.equal(writeIndexIfChanged(vault), true);
});

await check('索引被删掉后会重建', () => {
  const indexFile = path.join(vault, '.dsh-memory', 'index.json');
  fs.unlinkSync(indexFile);
  assert.equal(writeIndexIfChanged(vault), true);
  assert.ok(fs.existsSync(indexFile));
});

await check('索引内容与库条数一致', () => {
  writeIndex(vault);
  const index = JSON.parse(realReadFileSync(path.join(vault, '.dsh-memory', 'index.json'), 'utf8'));
  assert.equal(index.entries.length, loadMemories(vault).length);
});

fs.readFileSync = realReadFileSync;

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
