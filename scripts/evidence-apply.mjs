#!/usr/bin/env node
/**
 * 把「能确定」的出处写回 vault（默认只 dry-run 打印）。
 *
 * 判定「能确定」：
 *   - 候选的第一条 rank ≥ MIN_RANK；
 *   - 并且第一条与第二条拉开 ≥ MIN_GAP（或只有一条候选）。
 * 这两条都满足才写，其余留空等人看。
 *
 * 用法：
 *   node scripts/evidence-apply.mjs            # 只看会写哪些
 *   node scripts/evidence-apply.mjs --write    # 真写
 */
import os from 'node:os';
import path from 'node:path';
import { loadMemories } from '../lib/vault.js';
import { findEvidence } from '../lib/evidence.js';
import { setMemoryEvidence } from '../lib/store.js';

const VAULT = process.env.MEMORY_YUAN_VAULT
  || path.join(os.homedir(), '.dsh', 'worlds', 'default', 'memory');
const WRITE = process.argv.includes('--write');
const MIN_RANK = 7;
const MIN_GAP = 0.5;

const memories = loadMemories(VAULT);
const pending = memories.filter((m) => m.status === 'verified' && !m.evidence);

console.log(`待补出处：${pending.length} 条（vault ${memories.length} 条）`);
if (!WRITE) console.log('（dry run：加 --write 才写）\n');

const stampOf = (iso) => String(iso).slice(0, 10);
const sessionOf = (id) => String(id).replace(/^session-/, '').slice(0, 8);

let planned = 0;
let skipped = 0;
const written = [];

for (const memory of pending) {
  const candidates = findEvidence(
    { title: memory.title, createdAt: memory.createdAt || memory.updated, memories },
    { maxResults: 3 },
  );
  const first = candidates[0];
  if (!first) {
    skipped += 1;
    console.log(`· 无候选  ${memory.title}`);
    continue;
  }
  const second = candidates[1];
  const gap = second ? first.rank - second.rank : Infinity;
  const confident = first.rank >= MIN_RANK && gap >= MIN_GAP;

  console.log(
    `${confident ? '✓' : '·'} ${memory.title}\n` +
      `    rank ${first.rank} / 次条 ${second ? second.rank : '—'} · ${stampOf(first.at)} 会话 ${sessionOf(first.sessionId)}\n` +
      `    ${String(first.quote).slice(0, 90)}`,
  );

  if (!confident) {
    skipped += 1;
    continue;
  }

  planned += 1;
  if (WRITE) {
    const evidence = `${stampOf(first.at)} 会话 ${sessionOf(first.sessionId)}：「${String(first.quote).slice(0, 120)}」`;
    const result = setMemoryEvidence(memory.path, evidence, { now: new Date() });
    if (result.ok) written.push(memory.id);
    else console.log(`    写失败：${result.message}`);
  }
}

console.log(`\n可确定：${planned} 条 / 留空：${skipped} 条 / ${WRITE ? '实际写入：' + written.length : 'dry run'}`);
