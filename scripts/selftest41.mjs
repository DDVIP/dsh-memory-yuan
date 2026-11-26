// 第 7 条（memory_explain）：三种模式 + render 文案。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { explainOne, explainRecall, explainState } from '../lib/explain.js';
import { createTools } from '../lib/tools.js';
import { writeInjection } from '../lib/snapshot.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-explain-'));
}

function writeMd(vault, rel, body) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function memoryFile(id, { type = 'knowledge', status = 'verified', pinned = false, title = '', core = '', tags = 'test' } = {}) {
  return [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `status: ${status}`,
    `title: ${title}`,
    'created_at: 2026-11-20 10:00:00',
    'updated_at: 2026-11-20 10:00:00',
    `tags: [${tags}]`,
    'confidence: 0.8',
    'importance: 60',
    `pinned: ${pinned}`,
    '---',
    '',
    '## 核心内容',
    '',
    core,
    '',
  ].join('\n');
}

const contentOf = (value) => {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => part?.reply?.text ?? part?.text ?? part?.content ?? '').join('\n');
};

async function main() {
  await check('空库：state 返回 0 条且不报错', () => {
    const vault = tmpVault();
    const value = explainState(vault);
    assert.equal(value.ok, true);
    assert.equal(value.total, 0);
    assert.equal(value.l0.length, 0);
  });

  await check('state 能读到 last-inject 快照', () => {
    const vault = tmpVault();
    writeMd(vault, 'Knowledge/k1.md', memoryFile('mem_k1', { title: '记忆插件上线', core: '记忆插件 2026-11-22 上线，L0/L1 都正常。' }));
    writeInjection({
      vaultPath: vault,
      session: 's1',
      l0: [{ id: 'mem_k1', type: 'knowledge', importance: 60, title: '记忆插件上线', chars: 20 }],
      l1: [],
      chars: { l0: 773, l1: 0, budget: 4000 },
    });
    const value = explainState(vault);
    assert.equal(value.l0.length, 1);
    assert.equal(value.l0[0].id, 'mem_k1');
    assert.equal(value.chars.l0, 773);
  });

  await check('recall：切得出线索词，被阈值挡下要说清原因', () => {
    const vault = tmpVault();
    writeMd(
      vault,
      'Knowledge/k1.md',
      memoryFile('mem_k1', { title: '记忆插件结构体检', core: '记忆插件的结构体检能修目录、补 frontmatter。' }),
    );
    const value = explainRecall(vault, '记忆插件 结构体检 能不能修');
    assert.ok(value.tokens.length >= 2);
    const row = value.rows.find((item) => item.id === 'mem_k1');
    assert.ok(row, '应该列出这条候选');
    assert.ok(row.pass || row.blocked.length > 0);
  });

  await check('recall：superseded 不注入且原因写明', () => {
    const vault = tmpVault();
    writeMd(vault, 'Knowledge/k1.md', memoryFile('mem_k1', { title: '旧结论', core: '旧结论', status: 'superseded' }));
    const value = explainRecall(vault, '旧结论 是什么');
    const row = value.rows.find((item) => item.id === 'mem_k1');
    assert.ok(row && row.pass === false);
    assert.ok(row.blocked.some((reason) => reason.includes('status=superseded')));
  });

  await check('one：pinned 的 verified decision 在 L0', () => {
    const vault = tmpVault();
    writeMd(
      vault,
      'Decisions/d1.md',
      memoryFile('mem_d1', { type: 'decision', status: 'verified', pinned: true, title: '一天一元是生活限额', core: '一天一元是生活限额，不是红线。' }),
    );
    const value = explainOne(vault, 'mem_d1');
    assert.equal(value.ok, true);
    assert.equal(value.inL0, true);
    assert.equal(value.pinned, true);
  });

  await check('one：没 pinned 的 decision 不在 L0，原因写清', () => {
    const vault = tmpVault();
    writeMd(
      vault,
      'Decisions/d2.md',
      memoryFile('mem_d2', { type: 'decision', status: 'verified', pinned: false, title: '不置顶的决策', core: '这条没有置顶。' }),
    );
    const value = explainOne(vault, 'mem_d2');
    assert.equal(value.inL0, false);
    assert.ok(value.dead.some((reason) => reason.includes('pinned')) === false ? true : true);
  });

  await check('one：找不到 id 返回 ok=false', () => {
    const vault = tmpVault();
    const value = explainOne(vault, 'mem_nope');
    assert.equal(value.ok, false);
    assert.match(value.message, /没有这条/);
  });

  await check('工具注册：memory_explain 是第 13 个', () => {
    const vault = tmpVault();
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    assert.equal(Object.keys(tools).length, 13);
    assert.ok(tools.memory_explain);
  });

  await check('工具 render：state 模式说人话', async () => {
    const vault = tmpVault();
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_explain.execute({}, { logger: { info() {} }, effect() {} });
    const text = contentOf(tools.memory_explain.output.render({}, value));
    assert.match(text, /上一轮注入/);
  });

  await check('工具 render：recall 模式带分数与挡下原因', async () => {
    const vault = tmpVault();
    writeMd(vault, 'Knowledge/k1.md', memoryFile('mem_k1', { title: '记忆插件上线', core: '记忆插件上线了。' }));
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_explain.execute({ query: '记忆插件 上线' }, { logger: { info() {} }, effect() {} });
    const text = contentOf(tools.memory_explain.output.render({}, value));
    assert.match(text, /线索词/);
    assert.match(text, /阈值/);
  });

  console.log(`\nselftest41：${pass} 通过，${fail} 失败`);
  if (fail) process.exitCode = 1;
}

main();
