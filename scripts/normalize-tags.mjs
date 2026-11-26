// 一次性整理：把 tags 里的「类型词」删掉（type 已经由 type 字段表达，留在 tags 里是噪音）。
// 为什么单独写脚本而不是 memory_update：memory_update 会刷新 updated_at，
// 57 条一起刷会把「最近更新」排序和 L1 的保留率一起打乱。这里只动 tags 那一行。
import fs from 'node:fs';
import path from 'node:path';
import { backupFile } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';

const WRITE = process.argv.includes('--write');
const vault = process.argv.find((arg) => arg.startsWith('--vault='))?.slice('--vault='.length)
  ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'worlds', 'default', 'memory');

function yamlItem(value) {
  const text = String(value);
  return /^[^\s,:#"'\\\[\]{}]+$/.test(text) ? text : JSON.stringify(text);
}

function yamlList(values) {
  return `[${values.map(yamlItem).join(', ')}]`;
}

const memories = loadMemories(vault);
const plan = [];
for (const memory of memories) {
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const type = String(memory.type ?? '').toLowerCase();
  const kept = tags.filter((tag) => String(tag).toLowerCase() !== type);
  if (kept.length === tags.length) continue;
  plan.push({ memory, tags, kept });
}

console.log(`扫了 ${memories.length} 条，要删类型 tag 的 ${plan.length} 条${WRITE ? '' : '（dry run，加 --write 才写）'}`);
for (const item of plan.slice(0, 5)) {
  console.log(`  - ${item.memory.title}：${JSON.stringify(item.tags)} → ${JSON.stringify(item.kept)}`);
}

if (!WRITE) process.exit(0);

let written = 0;
const failed = [];
for (const { memory, kept } of plan) {
  try {
    const raw = fs.readFileSync(memory.path, 'utf8');
    const next = raw.replace(/^tags:.*$/m, `tags: ${yamlList(kept)}`);
    if (next === raw) continue;
    backupFile(memory.path, vault);
    const tmp = `${memory.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, memory.path);
    written += 1;
  } catch (error) {
    failed.push({ path: memory.path, message: error?.message ?? String(error) });
  }
}

console.log(`写了 ${written} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`);
for (const item of failed) console.log(`  FAIL ${item.path}: ${item.message}`);
