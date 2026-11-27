/**
 * 备份目录总闸：用量统计 + 超量删最旧。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backupStats, pruneBackups, backupsDirOf } from '../lib/backups.js';

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-yuan-backups-'));
const dir = backupsDirOf(vault);

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

function put(name, size, ageMs) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'x'.repeat(size), 'utf8');
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(full, at, at);
  return full;
}

await check('空目录：0 个文件', () => {
  const stats = backupStats(vault);
  assert.equal(stats.files, 0);
  assert.equal(stats.bytes, 0);
});

await check('统计文件数与字节', () => {
  put('a.md.1.bak', 10, 10000);
  put('b.md.2.bak', 20, 5000);
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');
  const stats = backupStats(vault);
  assert.equal(stats.files, 2);
  assert.equal(stats.bytes, 30);
});

await check('没超量不动手', () => {
  const result = pruneBackups(vault, { maxFiles: 10, maxBytes: 1000 });
  assert.equal(result.removed, 0);
  assert.equal(backupStats(vault).files, 2);
});

await check('超过 maxFiles 时删最旧的', () => {
  for (let i = 0; i < 5; i += 1) put(`c${i}.md.${i}.bak`, 10, 1000 * i + 100);
  const result = pruneBackups(vault, { maxFiles: 4, maxBytes: 1_000_000, keepAtLeast: 1 });
  assert.ok(result.removed >= 3, `删了 ${result.removed}`);
  assert.equal(backupStats(vault).files, 4);
  assert.equal(fs.existsSync(path.join(dir, 'a.md.1.bak')), false);
});

await check('超过 maxBytes 时按旧的删到够', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (let i = 0; i < 6; i += 1) put(`d${i}.md.${i}.bak`, 100, 1000 * (6 - i));
  const result = pruneBackups(vault, { maxFiles: 100, maxBytes: 350, keepAtLeast: 1 });
  assert.ok(result.removed >= 3);
  assert.ok(backupStats(vault).bytes <= 350);
});

await check('保底 keepAtLeast 不被删光', () => {
  const result = pruneBackups(vault, { maxFiles: 1, maxBytes: 1, keepAtLeast: 3 });
  assert.ok(backupStats(vault).files >= 3);
  assert.equal(result.ok, true);
});

console.log(`\n${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
