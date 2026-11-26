// 写入撞题检测（第 2 条）：只提醒、不改文件、不阻断写入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findConflicts } from '../lib/conflict.js';
import { createMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { createTools } from '../lib/tools.js';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-conflict-'));
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
const write = tools.memory_write;

function mem(over = {}) {
  return {
    id: over.id ?? 'mem_a',
    type: 'decision',
    status: 'verified',
    title: over.title ?? '记忆只写一个地方',
    tags: over.tags ?? ['记忆', '写入'],
    importance: over.importance ?? 80,
    pinned: over.pinned ?? false,
    updated: over.updated ?? '2026-11-20 10:00:00',
    ...over,
  };
}

console.log('1) findConflicts 纯函数');
await check('空库返回空数组', () => {
  assert.deepEqual(findConflicts([], { type: 'decision', title: 'x', tags: [] }), []);
});
await check('同 tag 命中', () => {
  const rows = findConflicts([mem()], { type: 'decision', title: '完全不同的标题', tags: ['记忆'] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sameTags, ['记忆']);
});
await check('标题词重合过半命中（标签完全不同）', () => {
  const rows = findConflicts([mem({ title: '记忆只写一个地方，不写第二处', tags: ['甲'] })], {
    type: 'decision',
    title: '记忆只写一个地方',
    tags: ['乙'],
  });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].overlap >= 0.5);
});
await check('不同 type 不算撞题', () => {
  assert.deepEqual(findConflicts([mem({ type: 'knowledge' })], { type: 'decision', title: '记忆只写一个地方', tags: ['记忆'] }), []);
});
await check('superseded / disputed 跳过', () => {
  assert.deepEqual(
    findConflicts([mem({ status: 'superseded' }), mem({ id: 'mem_b', status: 'disputed' })], {
      type: 'decision',
      title: '记忆只写一个地方',
      tags: ['记忆'],
    }),
    [],
  );
});
await check('pinned 条目标记 hard，且带重合度', () => {
  const rows = findConflicts([mem({ id: 'tight', title: '记忆只写一个地方', pinned: true, importance: 60 })], {
    type: 'decision',
    title: '记忆只写一个地方',
    tags: ['记忆'],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hard, true);
  assert.ok(rows[0].overlap >= 0.5);
});
await check('高重要度也算硬', () => {
  const rows = findConflicts([mem({ id: 'boss', pinned: false, importance: 90 })], {
    type: 'decision',
    title: '记忆只写一个地方',
    tags: ['记忆'],
  });
  assert.equal(rows[0].hard, true);
});
await check('max 限制条数', () => {
  const many = Array.from({ length: 8 }, (_, i) => mem({ id: `m${i}` }));
  assert.equal(findConflicts(many, { type: 'decision', title: '记忆只写一个地方', tags: ['记忆'] }, { max: 3 }).length, 3);
});

console.log('2) 工具层：写的时候把撞题的列出来');
await check('先写一条 decision', async () => {
  const result = await write.execute({
    type: 'decision',
    title: '记忆只写一个地方',
    content: '长期事实写 vault，不写别处。',
    tags: ['记忆', '写入'],
    status: 'verified',
    confirm: true,
    importance: 80,
  });
  assert.equal(result.ok, true);
});
await check('再写同主题 → conflicts 非空且 render 提示', async () => {
  const result = await write.execute({
    type: 'decision',
    title: '记忆只写一个地方',
    content: '换一种说法。',
    tags: ['记忆'],
  });
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.conflicts) && result.conflicts.length >= 1, '应列出撞题条目');
  const rendered = write.output.render({}, result);
  const text = rendered.map((block) => block.text).join('\n');
  assert.match(text, /可能撞题/);
  assert.match(text, /supersedes/);
});
await check('不撞题时没有 conflicts 字段', async () => {
  const result = await write.execute({
    type: 'decision',
    title: '完全另一件事：周报格式',
    content: '周报只写三行。',
    tags: ['周报'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.conflicts, undefined);
});
await check('append 模式不带 conflicts', async () => {
  const result = await write.execute({ mode: 'append', stream: 'daily', content: '撞题检测不影响流水。' });
  assert.equal(result.ok, true);
  assert.equal(result.conflicts, undefined);
});
await check('supersedes 时仍会列出撞题（不阻断，靠人决定）', async () => {
  const first = loadMemories(vault).find((memory) => memory.title === '记忆只写一个地方' && memory.status === 'verified');
  assert.ok(first);
  const result = await write.execute({
    type: 'decision',
    title: '记忆只写一个地方',
    content: '替代版。',
    tags: ['记忆'],
    supersedes: first.id,
  });
  assert.equal(result.ok, true);
  assert.equal(result.superseded, first.id);
  assert.ok(Array.isArray(result.conflicts));
});
await check('output schema 里声明了 conflicts', () => {
  const schema = write.output.schema;
  assert.ok(schema.properties.conflicts, 'schema 要声明 conflicts，否则校验会报未声明属性');
  assert.equal(schema.properties.conflicts.type, 'array');
});

console.log(`\n${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
