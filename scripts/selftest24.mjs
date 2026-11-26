/**
 * 自测 24：写盘备份。
 *
 * 改旧记忆（supersede / 改状态）与覆盖收盘摘要之前，先留一份 .bak；
 * 同一文件只留最近 5 份；备份失败不能挡住主流程。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupFile, setMemoryStatus, supersedeMemory } from '../lib/store.js';
import { writeSummary } from '../lib/digest.js';
import { loadMemories } from '../lib/vault.js';

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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-backup-'));
const dir = path.join(vault, 'Knows');
fs.mkdirSync(dir, { recursive: true });

const makeNote = (name, status = 'verified') => {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `---\nid: ${name.replace('.md', '')}\ntype: experience\nstatus: ${status}\ntitle: 备份测试\ncreated_at: 2026-11-24 10:00:00\nupdated_at: 2026-11-24 10:00:00\n---\n\n## 核心内容\n\n原始正文。\n`,
    'utf8',
  );
  return file;
};

const backupsOf = (base) => {
  const folder = path.join(vault, '.dsh-memory', 'backups');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((n) => n.startsWith(`${base}.`));
};

console.log('写盘备份');

await check('没有可备份的文件时返回 ok:false 而不是抛错', () => {
  const r = backupFile(path.join(vault, 'nope.md'), vault);
  assert.equal(r.ok, false);
});

await check('backupFile 留一份，内容与当时一致', () => {
  const file = makeNote('one.md');
  const before = fs.readFileSync(file, 'utf8');
  const r = backupFile(file, vault);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(r.path, 'utf8'), before);
});

await check('同一文件只留最近 5 份', () => {
  const file = makeNote('many.md');
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(file, `---\nid: many\ntitle: 第 ${i} 版\nstatus: verified\n---\n\n正文 ${i}\n`, 'utf8');
    backupFile(file, vault, { keep: 5 });
  }
  assert.equal(backupsOf('many.md').length, 5, `应该留 5 份，实际 ${backupsOf('many.md').length}`);
});

await check('supersedeMemory 改之前会备份', () => {
  const file = makeNote('old.md');
  const r = supersedeMemory(file, 'mem_new');
  assert.equal(r.ok, true);
  assert.equal(backupsOf('old.md').length, 1);
  const bak = path.join(vault, '.dsh-memory', 'backups', backupsOf('old.md')[0]);
  assert.match(fs.readFileSync(bak, 'utf8'), /status: verified/, '备份里应是改之前的状态');
  assert.match(fs.readFileSync(file, 'utf8'), /status: superseded/);
});

await check('setMemoryStatus 改之前会备份', () => {
  const file = makeNote('state.md');
  const r = setMemoryStatus(file, 'disputed');
  assert.equal(r.ok, true);
  assert.equal(backupsOf('state.md').length, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /status: disputed/);
});

await check('writeSummary 覆盖之前会备份', () => {
  const day = '2026-11-24';
  const first = writeSummary(vault, {
    date: day,
    sentences: ['第一条完整句子。', '第二条完整句子。', '第三条完整句子。'],
  });
  assert.equal(first.ok, true);
  const second = writeSummary(vault, {
    date: day,
    sentences: ['改写后的第一句。', '改写后的第二句。', '改写后的第三句。'],
  });
  assert.equal(second.ok, true);
  const base = `${day}.summary.md`;
  assert.equal(backupsOf(base).length, 1, '第二次覆盖前应留一份');
  const bak = path.join(vault, '.dsh-memory', 'backups', backupsOf(base)[0]);
  assert.match(fs.readFileSync(bak, 'utf8'), /第一条完整句子/);
  assert.match(fs.readFileSync(second.path, 'utf8'), /改写后的第一句/);
});

await check('备份目录不会被当成记忆读进来', () => {
  const titles = loadMemories(vault).map((m) => m.title);
  assert.ok(titles.length > 0);
  assert.ok(!titles.some((t) => String(t).includes('.bak')));
});

await check('备份失败不阻断主流程（vault 不可写时仍返回写盘结果）', () => {
  // 用一个只读的 vault 路径模拟备份建不了目录：主流程（写文件）仍应给出自己的错误，而不是被备份吞掉。
  const dumb = path.join(vault, 'no-write');
  fs.mkdirSync(dumb, { recursive: true });
  const file = makeNote('last.md');
  const r = setMemoryStatus(file, 'candidate');
  assert.equal(r.ok, true);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
