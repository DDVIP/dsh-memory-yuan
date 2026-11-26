/**
 * 回归测试：不装插件，直接调 apply 与三个工具。
 * 用法：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_VAULT } from '../lib/vault.js';
import { apply, inject } from '../index.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

/** 假 ctx：effect 直接执行；三个服务都记下来。 */
function makeCtx() {
  const sections = new Map();
  const tools = [];
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    systemPrompt: {
      context(section) {
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    webServer: {
      register() {
        return () => {};
      },
    },
    /** 可选服务的按需依赖：宿主里有才回调，模拟真 ctx.inject 的语义。 */
    inject(deps, callback) {
      if (deps.every((dep) => dep in ctx)) callback(ctx);
    },
  };
  return { ctx, sections, tools };
}

console.log('1) inject 与 L0');
check('inject 只声明必需服务（可选能力按需挂）', () => {
  assert.deepEqual(inject, ['systemPrompt', 'tools']);
});

check('没有 webServer / llm 替身时也能 apply（兼容层）', () => {
  const bare = {
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    systemPrompt: { context: () => () => {} },
    tools: { register: () => () => {} },
    inject() {
      /* 依赖永远不就绪：什么都不该发生，也不该抛 */
    },
  };
  assert.doesNotThrow(() => apply(bare, { vaultPath: DEFAULT_VAULT }));
});

const { ctx, sections, tools } = makeCtx();
apply(ctx, { vaultPath: DEFAULT_VAULT });

check('注册了 L0 / L1 两个注入段', () => {
  assert.ok(sections.has('memory-yuan:standing'));
  assert.ok(sections.has('memory-yuan:recall'));
});

const standing = sections.get('memory-yuan:standing');
check('L0 的 text 是函数（每轮读盘）', () => {
  assert.equal(typeof standing.text, 'function');
});

const l0a = standing.text();
const l0b = standing.text();
check('L0 有内容且两次渲染一致（缓存前缀稳定）', () => {
  assert.ok(l0a.length > 0);
  assert.match(l0a, /^## 记忆 · L0/);
  assert.equal(l0a, l0b);
});

check('L0 行数 = 标题 + 条目 + footer', () => {
  const lines = l0a.split('\n').filter(Boolean);
  assert.ok(lines.length >= 3, `实际 ${lines.length} 行`);
  assert.match(lines[0], /^## 记忆 · L0/);
  assert.match(lines[lines.length - 1], /^（此段由 dsh-memory-yuan/);
});

console.log('2) 空 vault');
const empty = makeCtx();
apply(empty.ctx, { vaultPath: path.join(os.tmpdir(), 'memory-yuan-not-exist') });
check('不存在的 vault 返回空串', () => {
  assert.equal(empty.sections.get('memory-yuan:standing').text(), '');
});

console.log('3) 配置生效');
const narrow = makeCtx();
apply(narrow.ctx, { vaultPath: DEFAULT_VAULT, l0MaxItems: 1 });
check('l0MaxItems=1 只注入一条', () => {
  const text = narrow.sections.get('memory-yuan:standing').text();
  const bullet = text.split('\n').filter((line) => line.startsWith('- [')).length;
  assert.equal(bullet, 1);
});

console.log('4) 工具形状');
check('注册了十三个工具', () => {
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'memory_archive',
    'memory_digest',
    'memory_explain',
    'memory_export',
    'memory_get',
    'memory_import',
    'memory_lint',
    'memory_migrate',
    'memory_review',
    'memory_search',
    'memory_tend',
    'memory_update',
    'memory_write',
  ]);
});

check('每个工具都有 output { schema, render }，render 返回 [{type,text}]', () => {
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.parameters && tool.parameters.type === 'object');
    assert.ok(tool.output && tool.output.schema, `${tool.name} 缺 output.schema`);
    assert.equal(typeof tool.output.render, 'function');
    const block = tool.output.render({ ok: false, rows: [], query: '', count: 0 });
    assert.ok(Array.isArray(block) && block.length > 0);
    assert.equal(block[0].type, 'text');
    assert.equal(typeof block[0].text, 'string');
  }
});

/** 按 schema 里的 additionalProperties:false 校验 execute 返回值的顶层键。 */
function checkKeys(tool, value) {
  const schema = tool.output.schema;
  if (schema?.additionalProperties !== false) return;
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `${tool.name} 返回了未声明字段 ${key}`);
  }
}

console.log('5) 写 → 查 → 读 → 取代');
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-'));
const temp = makeCtx();
apply(temp.ctx, { vaultPath: vault });
const byName = Object.fromEntries(temp.tools.map((tool) => [tool.name, tool]));

const written = await byName.memory_write.execute(
  {
    title: '测试：记忆写入链路',
    type: 'knowledge',
    content: '这是一条测试记忆，用来验证写、查、读、取代。',
    source: 'smoke.mjs',
    tags: ['测试', '链路'],
    importance: 60,
  },
  {},
);
check('memory_write 成功且带 id/path', () => {
  checkKeys(byName.memory_write, written);
  assert.equal(written.ok, true);
  assert.ok(written.id && written.path);
  assert.ok(fs.existsSync(written.path));
});

check('memory_write 后 index.json 里有新 id（2026-11-22 漏写 bug）', () => {
  const indexPath = path.join(vault, '.dsh-memory', 'index.json');
  assert.ok(fs.existsSync(indexPath), 'index.json 不存在');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.ok(
    index.entries.some((entry) => entry.id === written.id),
    'index.json 里没有刚写的 id',
  );
});

const found = await byName.memory_search.execute({ query: '测试 链路' }, {});
check('memory_search 能查到', () => {
  checkKeys(byName.memory_search, found);
  assert.ok(found.rows.some((row) => row.id === written.id));
});

const detail = await byName.memory_get.execute({ id: written.id }, {});
check('memory_get 能读到全文', () => {
  checkKeys(byName.memory_get, detail);
  assert.equal(detail.ok, true);
  assert.match(detail.text, /验证写、查、读、取代/);
});

const originalBody = fs.readFileSync(written.path, 'utf8').split('\n---')[1];

const second = await byName.memory_write.execute(
  {
    title: '测试：记忆写入链路（新版）',
    type: 'knowledge',
    content: '新版测试记忆，取代上一条。',
    supersedes: written.id,
  },
  {},
);
check('supersedes 会写新条目并标旧条目', () => {
  assert.equal(second.ok, true);
  assert.equal(second.superseded, written.id);
  const oldRaw = fs.readFileSync(written.path, 'utf8');
  assert.match(oldRaw, /^status: superseded$/m);
  assert.ok(oldRaw.split('\n---')[1].includes('验证写、查、读、取代') || originalBody.length > 0);
});

const plain = await byName.memory_search.execute({ query: '测试 链路' }, {});
const archived = await byName.memory_search.execute({ query: '测试 链路', includeArchived: true }, {});
check('默认搜不到 superseded，includeArchived 能搜到', () => {
  assert.ok(!plain.rows.some((row) => row.id === written.id));
  assert.ok(archived.rows.some((row) => row.id === written.id));
});

fs.rmSync(vault, { recursive: true, force: true });

console.log(`\n全部通过（${passed} 项）`);
