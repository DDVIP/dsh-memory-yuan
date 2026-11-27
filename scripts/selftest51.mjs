/**
 * 写入时查重（findSimilar + memory_write 的 similar 字段）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { loadMemories } from '../lib/vault.js';
import { createMemory } from '../lib/store.js';
import { findSimilar } from '../lib/similar.js';

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-similar-'));
const list = createTools({ vaultPath: vault, sessionId: 'test' });
const tools = Object.fromEntries(list.map((tool) => [tool.name, tool]));

const body = '收盘读当天流水写摘要，失败只在流水留一行，面板看不见，这条要重做成可见的。';
const body2 = '收盘读当天流水写摘要，失败只在流水里留一行，面板看不见，这条得重做成可见的。';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

await check('findSimilar：同 type 正文高度重合能捞出来', () => {
  const a = createMemory({ vaultPath: vault, type: 'experience', title: '收盘失败要可见', content: body, status: 'verified', confirm: true });
  const memories = loadMemories(vault);
  const rows = findSimilar(memories, { type: 'experience', content: body2, excludeId: '' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, a.id);
  assert.ok(rows[0].ratio >= 0.6);
});

await check('findSimilar：不同 type 不算重复', () => {
  const memories = loadMemories(vault);
  assert.equal(findSimilar(memories, { type: 'preference', content: body2 }).length, 0);
});

await check('findSimilar：excludeId 排除自己', () => {
  const one = loadMemories(vault)[0];
  assert.equal(findSimilar(loadMemories(vault), { type: 'experience', content: body2, excludeId: one.id }).length, 0);
});

await check('findSimilar：太短的正文不判重', () => {
  assert.equal(findSimilar(loadMemories(vault), { type: 'experience', content: '太短' }).length, 0);
});

await check('findSimilar：superseded 不算重复', () => {
  const memories = loadMemories(vault).map((m) => ({ ...m, status: 'superseded' }));
  assert.equal(findSimilar(memories, { type: 'experience', content: body2 }).length, 0);
});

await check('memory_write 真的会带 similar', async () => {
  const out = await tools.memory_write.execute({ type: 'experience', title: '收盘失败要看得见', content: body2, tags: ['记忆插件'] });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.similar) && out.similar.length === 1, JSON.stringify(out));
  const rendered = tools.memory_write.output.render({}, out).map((block) => block.text).join('\n');
  assert.match(rendered, /可能和这几条重复/);
});

await check('memory_write 不重复时没有 similar 字段', async () => {
  const out = await tools.memory_write.execute({ type: 'knowledge', title: '另一件事', content: '这条讲的是完全不一样的另一件事，跟上面任何一条都不重合，长度也够。' });
  assert.equal(out.ok, true);
  assert.equal(out.similar, undefined);
});

console.log(`\n${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
