// 第 3 条：结构体检（memory_lint）——只看文件写得对不对。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectMemory, lintMemories, lintVault } from '../lib/structure.js';
import { createTools } from '../lib/tools.js';
import { createServer } from 'node:http';
import { createStateHandler } from '../lib/api.js';

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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-lint-'));
const decisions = path.join(vault, 'Decisions');
fs.mkdirSync(decisions, { recursive: true });

function goodFile(name, over = {}) {
  const body = [
    '---',
    `id: ${over.id ?? 'mem_20261125t120000_abcdef01'}`,
    `type: ${over.type ?? 'decision'}`,
    `status: ${over.status ?? 'verified'}`,
    `title: ${over.title ?? '一条正常的记忆'}`,
    'created_at: 2026-11-25 12:00:00',
    `updated_at: ${over.updated ?? '2026-11-25 12:00:00'}`,
    `tags: ${over.tags ?? '[甲, 乙]'}`,
    `importance: ${over.importance ?? 50}`,
    `confidence: ${over.confidence ?? 0.8}`,
    'pinned: false',
    'visibility: desktop-private',
    'schema_version: 1',
    '---',
    '',
    '## 核心内容',
    '',
    over.core ?? '这是一条正常的记忆，正文够长。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(decisions, name), body, 'utf8');
}

goodFile('good.md');
goodFile('bad-type.md', { id: 'mem_20261125t120001_abcdef02', type: 'idea' });
goodFile('bad-status.md', { id: 'mem_20261125t120002_abcdef03', status: 'archived' });
goodFile('no-tags.md', { id: 'mem_20261125t120003_abcdef04', tags: '[]' });
goodFile('tag-type.md', { id: 'mem_20261125t120004_abcdef05', tags: '[decision, 甲]' });
goodFile('short-core.md', { id: 'mem_20261125t120005_abcdef06', core: '短。' });
goodFile('bad-importance.md', { id: 'mem_20261125t120006_abcdef07', importance: 250 });
goodFile('time-ok.md', {
  id: 'mem_20261125t120007_abcdef08',
  updated: '2026-11-25 15:08:04',
});
// 手写「没有 frontmatter」的裸文件（模仿旧库导入的 Companion）
fs.mkdirSync(path.join(vault, 'Companion'), { recursive: true });
fs.writeFileSync(path.join(vault, 'Companion', 'Behavior Policy.md'), '# Companion · Behavior Policy\n\npretend_human: false\n', 'utf8');

console.log('1) 单条检查');
await check('inspectMemory 认 identity：无 frontmatter', () => {
  const memory = {
    id: 'x', title: 'Companion · Behavior Policy', type: 'knowledge', status: 'candidate',
    raw: '# Companion · Behavior Policy\n\npretend_human: false\n', core: 'pretend_human: false', path: 'x',
    tags: [], importance: 50, createdAt: '', updated: '', dir: 'Companion',
  };
  const codes = inspectMemory(memory, { idCounts: new Map() }).map((item) => item.code);
  assert.ok(codes.includes('no-frontmatter'));
  assert.ok(codes.includes('no-id'));
});
await check('读真实文件：time-ok 不误报倒挂（ISO 与本地时间混用）', () => {
  const rows = lintVault(vault).rows.find((row) => row.path.endsWith('time-ok.md'));
  assert.equal(rows, undefined, 'created_at 与 updated_at 都是同一时区时不该报');
});

console.log('2) 全库统计');
const report = lintVault(vault);
await check('扫到全部文件', () => {
  assert.ok(report.scanned >= 8, `scanned=${report.scanned}`);
});
await check('bad-type / bad-status / no-tags / tag-type / bad-importance 都被抓出来', () => {
  for (const code of ['bad-type', 'bad-status', 'no-tags', 'tag-is-type', 'bad-importance']) {
    assert.ok((report.codes[code] ?? 0) >= 1, `缺 ${code}`);
  }
});
await check('无 frontmatter 的文件是 error', () => {
  const row = report.rows.find((item) => item.title === 'Companion · Behavior Policy');
  assert.ok(row);
  assert.equal(row.level, 'error');
});
await check('error 排在 warning / info 前面', () => {
  const levels = report.rows.map((row) => row.level);
  const firstWarn = levels.indexOf('warning');
  const firstError = levels.indexOf('error');
  if (firstError >= 0 && firstWarn >= 0) assert.ok(firstError < firstWarn);
});
await check('max 截断生效', () => {
  const limited = lintMemories([
    { id: 'a', title: 'a', type: 'x', status: 'verified', raw: '', core: 'c', tags: [], path: '/a', importance: 1 },
    { id: 'b', title: 'b', type: 'x', status: 'verified', raw: '', core: 'c', tags: [], path: '/b', importance: 1 },
  ], { max: 1 });
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.truncated, true);
});
await check('id 重复是 error', () => {
  const dup = inspectMemory(
    { id: 'dup', title: 't', type: 'decision', status: 'verified', raw: '---\nid: dup\ntags: [a]\n---\n## 核心内容\n\nok\n', core: 'ok', tags: ['a'], importance: 50, path: '/x', dir: 'Decisions' },
    { idCounts: new Map([['dup', 2]]) },
  );
  assert.ok(dup.some((item) => item.code === 'dup-id'));
});

console.log('3) 工具与 HTTP');
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
await check('注册了 memory_lint（十三个工具）', () => {
  assert.ok(tools.memory_lint);
  assert.equal(Object.keys(tools).length, 13);
});
await check('工具执行 + render', async () => {
  const value = await tools.memory_lint.execute({ max: 3 });
  assert.equal(value.ok, true);
  const text = tools.memory_lint.output.render({}, value)[0].text;
  assert.match(text, /结构体检：扫了/);
  assert.match(text, /只出单子/);
});
await check('GET /lint 返回 200 与 counts', async () => {
  const server = createServer(createStateHandler({ vaultPath: vault }));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/lint?max=5`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.scanned >= 8);
    assert.ok(body.counts.error >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(`\n${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
