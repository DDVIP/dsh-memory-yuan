// 自测 34：memory_update（改单条记忆）——不新建文件、只改传了的字段、冲突不覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { createMemory } from '../lib/store.js';
import { loadMemories, readMemoryFile } from '../lib/vault.js';
import { readState } from '../lib/snapshot.js';

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

function makeVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'my-update-'));
}

const vault = makeVault();
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
const update = tools.memory_update;

let id;
await check('工具注册了 memory_update', () => {
  assert.ok(update, '没有 memory_update');
  assert.equal(typeof update.execute, 'function');
  assert.equal(typeof update.output.render, 'function');
});

await check('先造一条', async () => {
  const created = await tools.memory_write.execute({
    title: '更新测试：原始标题',
    type: 'knowledge',
    content: '原始正文第一句。',
    tags: ['更新', '测试'],
    importance: 40,
    source: '自测造的数据',
  });
  assert.equal(created.ok, true);
  id = created.id;
});

await check('只改标题，正文与标签不动', async () => {
  const original = loadMemories(vault).find((m) => m.id === id);
  assert.ok(original, '读不到原始条目');
  const before = readMemoryFile(original.path);
  const result = await update.execute({ id, title: '更新测试：改过的标题' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed, ['title']);
  const after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.equal(after.title, '更新测试：改过的标题');
  assert.equal(after.core, before.core);
  assert.deepEqual(after.tags, before.tags);
  assert.equal(after.importance, before.importance);
});

await check('改标签（整体替换）', async () => {
  const result = await update.execute({ id, tags: ['新标签', '第二个'] });
  assert.equal(result.ok, true);
  const after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.deepEqual(after.tags, ['新标签', '第二个']);
});

await check('改重要度并夹取', async () => {
  const result = await update.execute({ id, importance: 250 });
  assert.equal(result.ok, true);
  const after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.equal(after.importance, 100);
});

await check('改正文只替换「核心内容」段', async () => {
  const result = await update.execute({ id, content: '新正文。' });
  assert.equal(result.ok, true);
  const after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.equal(after.core, '新正文。');
  assert.match(after.raw, /## 核心内容/);
});

await check('写出处与过期日', async () => {
  let result = await update.execute({ id, evidence: '2026-11-25 自测会话：「改一下」', expires: '2026-12-31' });
  assert.equal(result.ok, true);
  let after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.equal(after.evidence, '2026-11-25 自测会话：「改一下」');
  assert.equal(after.expires, '2026-12-31');
  result = await update.execute({ id, evidence: '', expires: '' });
  assert.equal(result.ok, true);
  after = readMemoryFile(loadMemories(vault).find((m) => m.id === id).path);
  assert.equal(after.evidence, '');
  assert.equal(after.expires, '');
});

await check('坏过期日拒绝', async () => {
  const result = await update.execute({ id, expires: '2026-13-45' });
  assert.equal(result.ok, false);
  assert.match(result.message, /YYYY-MM-DD/);
});

await check('空标题 / 空正文拒绝', async () => {
  assert.equal((await update.execute({ id, title: '  ' })).ok, false);
  assert.equal((await update.execute({ id, content: '' })).ok, false);
});

await check('没传字段要说清楚', async () => {
  const result = await update.execute({ id });
  assert.equal(result.ok, false);
  assert.match(result.message, /没给要改的字段/);
});

await check('找不到 id', async () => {
  const result = await update.execute({ id: 'mem_nope' });
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到/);
});

await check('expectedUpdatedAt 不一致 → 冲突且文件不变', async () => {
  const target = loadMemories(vault).find((m) => m.id === id);
  const snapshot = readMemoryFile(target.path);
  const result = await update.execute({ id, title: '不该写进去', expectedUpdatedAt: '1999-01-01 00:00:00' });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  const after = readMemoryFile(target.path);
  assert.equal(after.title, snapshot.title);
});

await check('expectedUpdatedAt 一致 → 正常改', async () => {
  const target = loadMemories(vault).find((m) => m.id === id);
  const result = await update.execute({ id, title: '按版本号改的标题', expectedUpdatedAt: target.updated });
  assert.equal(result.ok, true);
  assert.equal(readMemoryFile(target.path).title, '按版本号改的标题');
});

await check('改动后索引同步', async () => {
  const state = readState(vault);
  const entry = (state.index?.entries ?? []).find((item) => item.id === id);
  assert.ok(entry, '索引里找不到');
  assert.equal(entry.title, '按版本号改的标题');
});

const passed = results.filter((line) => line.startsWith('  ok')).length;
const failed = results.length - passed;
console.log(results.join('\n'));
console.log(`\nselftest34：${passed} 通过，${failed} 失败`);
if (failed) process.exitCode = 1;
