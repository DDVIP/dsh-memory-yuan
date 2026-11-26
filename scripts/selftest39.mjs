// 结构体检的「修」：只修文件本身，不动内容。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FIXABLE_CODES, fixProblem } from '../lib/fix.js';
import { lintVault } from '../lib/structure.js';
import { loadMemories } from '../lib/vault.js';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fix-'));
}

function writeMd(vault, rel, body) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const goodHead = (id, type, extra = '') =>
  [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    'status: verified',
    `title: 测试条目 ${id}`,
    'created_at: 2026-11-20 10:00:00',
    'updated_at: 2026-11-20 10:00:00',
    'tags: [a, b]',
    'confidence: 0.8',
    'importance: 50',
    'pinned: false',
    '---',
    '',
    '## 核心内容',
    '',
  ].join('\n') + extra;

console.log('selftest39：结构体检的修');

await check('可修清单里没有内容类问题', () => {
  for (const code of ['dup-id', 'empty-core', 'short-core']) {
    assert.equal(FIXABLE_CODES.has(code), false, code);
  }
  assert.equal(FIXABLE_CODES.has('dir-mismatch'), true);
});

await check('dir-mismatch：挪到标准目录', () => {
  const vault = tmpVault();
  const file = writeMd(vault, 'Companion/Behavior Policy.md', goodHead('mem_fix_dir_1', 'knowledge'));
  const result = fixProblem(vault, { id: 'mem_fix_dir_1', code: 'dir-mismatch' });
  assert.equal(result.ok, true, result.message);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(vault, 'Knowledge', 'Behavior Policy.md')), true);
});

await check('no-frontmatter：补一段 frontmatter', () => {
  const vault = tmpVault();
  writeMd(vault, 'Companion/Persona.md', '# Companion · Persona\n\npretend_human: false\n');
  const target = loadMemories(vault).find((m) => !m.id || !/^mem_/.test(m.id)) ?? loadMemories(vault)[0];
  const result = fixProblem(vault, { id: target.id, code: 'no-frontmatter' });
  assert.equal(result.ok, true, result.message);
  const after = loadMemories(vault).find((m) => m.id === target.id);
  assert.equal(after.status, 'candidate');
  assert.equal(after.type, 'knowledge');
  assert.ok(after.title);
});

await check('no-id：补 id', () => {
  const vault = tmpVault();
  const file = writeMd(
    vault,
    'Knowledge/无 id 的条目.md',
    '---\ntype: knowledge\nstatus: candidate\ntitle: 无 id 的条目\ncreated_at: 2026-11-20 10:00:00\nupdated_at: 2026-11-20 10:00:00\ntags: []\nimportance: 50\ntitle: 无 id 的条目\n---\n\n## 核心内容\n\n正文一段。\n',
  );
  const before = loadMemories(vault)[0];
  const result = fixProblem(vault, { id: before.id, code: 'no-id' });
  assert.equal(result.ok, true, result.message);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^id: /m);
});

await check('bad-importance：夹到 0–100', () => {
  const vault = tmpVault();
  writeMd(vault, 'Knowledge/重要度越界.md', goodHead('mem_fix_imp', 'knowledge').replace('importance: 50', 'importance: 250'));
  const result = fixProblem(vault, { id: 'mem_fix_imp', code: 'bad-importance' });
  assert.equal(result.ok, true, result.message);
  const after = loadMemories(vault).find((m) => m.id === 'mem_fix_imp');
  assert.equal(after.importance, 100);
});

await check('tag-is-type：删掉类型词', () => {
  const vault = tmpVault();
  writeMd(
    vault,
    'Knowledge/tags 脏.md',
    goodHead('mem_fix_tag', 'knowledge').replace('tags: [a, b]', 'tags: [knowledge, a]'),
  );
  const result = fixProblem(vault, { id: 'mem_fix_tag', code: 'tag-is-type' });
  assert.equal(result.ok, true, result.message);
  const after = loadMemories(vault).find((m) => m.id === 'mem_fix_tag');
  assert.deepEqual(after.tags, ['a']);
});

await check('内容类问题不给修', () => {
  const vault = tmpVault();
  writeMd(vault, 'Knowledge/空正文.md', goodHead('mem_fix_empty', 'knowledge'));
  const result = fixProblem(vault, { id: 'mem_fix_empty', code: 'empty-core' });
  assert.equal(result.ok, false);
  assert.match(result.message, /人来看/);
});

await check('缺参数 / 找不到都有话说', () => {
  const vault = tmpVault();
  assert.equal(fixProblem(vault, {}).ok, false);
  assert.equal(fixProblem(vault, { id: 'x' }).ok, false);
  const missing = fixProblem(vault, { id: 'mem_not_exist', code: 'dir-mismatch' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /找不到/);
});

await check('修完 lint 该问题消失', () => {
  const vault = tmpVault();
  writeMd(vault, 'History/错位.md', goodHead('mem_fix_lint', 'knowledge'));
  const before = lintVault(vault).rows.find((row) => row.id === 'mem_fix_lint');
  assert.ok(before.problems.some((p) => p.code === 'dir-mismatch'));
  fixProblem(vault, { id: 'mem_fix_lint', code: 'dir-mismatch' });
  const after = lintVault(vault).rows.find((row) => row.id === 'mem_fix_lint');
  assert.equal(after?.problems?.some((p) => p.code === 'dir-mismatch') ?? false, false);
});

console.log(`\nselftest39：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
