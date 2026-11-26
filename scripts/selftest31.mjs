// selftest31：体检「可能没用」的分组口径
// 2026-11-24 主人反馈：体检里点「留着」「30 天后过期」按钮像没反应。
// 根因是分组只看 hits/reads，不看 status / expires —— 点完条目还留在同一张单子上。
// 现在：只列 candidate，且没设过期日的。这个测试守住这条口径。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReview, readIgnored, readIgnoredActions, ignoreInReview } from '../lib/review.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

const now = new Date('2026-11-24T12:00:00+08:00');
const hits = { a: { hits: 9 }, b: { hits: 9 }, c: { hits: 9 }, d: { hits: 9 }, e: { hits: 9 } };
const base = { type: 'experience', evidence: 'e', updated: '2026-11-20 10:00:00', dir: 'Experiences', tags: ['x'] };
const memories = [
  { ...base, id: 'a', status: 'candidate', title: '待确认、命中很多、没读过', reads: 0 },
  { ...base, id: 'b', status: 'verified', title: '已确认、命中很多、没读过', reads: 0 },
  { ...base, id: 'c', status: 'candidate', title: '候选但设了过期日', reads: 0, expires: '2026-12-31' },
  { ...base, id: 'd', status: 'candidate', title: '候选并且读过', reads: 3 },
  { ...base, id: 'e', status: 'candidate', title: '候选只命中两次', reads: 0 },
];
hits.e = { hits: 2 };

const review = buildReview(memories, { now, hits });
const unusedIds = review.unused.map((item) => item.id);

check('候选 + 命中 ≥3 + 没读过 → 进「可能没用」', () => {
  assert.deepEqual(unusedIds, ['a']);
});
check('已确认（verified）的不再列「可能没用」——点「留着」后从单子消失', () => {
  assert.ok(!unusedIds.includes('b'));
});
check('设了过期日的不再列——「暂时有用」不算没用', () => {
  assert.ok(!unusedIds.includes('c'));
});
check('读过的（reads>0）不列', () => {
  assert.ok(!unusedIds.includes('d'));
});
check('命中不足 3 次的不列', () => {
  assert.ok(!unusedIds.includes('e'));
});
check('counts.unused 与数组长度一致', () => {
  assert.equal(review.counts.unused, review.unused.length);
});
check('每条都带 why（人话原因）', () => {
  const item = review.unused[0];
  assert.equal(item.why, '被 L1 命中 9 次，但一次都没被 memory_get 读过');
});

// 2026-11-24 主人第二次反馈：点了「留着」「30 天后过期」条目还留在原地。
// 现在这两种动作都会记一笔 kept，条目立刻从所有单子上消失，能在「已保留」里恢复。
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-review-'));
ignoreInReview(vault, 'a', { action: 'kept' });

check('ignoreInReview 记下处理方式：kept', () => {
  const entries = readIgnoredActions(vault);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], 'a');
  assert.equal(entries[0][1].action, 'kept');
});
check('被「留着」的条目从所有单子上消失', () => {
  const after = buildReview(memories, { now, hits, ignored: readIgnored(vault) });
  assert.deepEqual(after.unused, []);
  assert.ok(!after.noEvidence.some((item) => item.id === 'a'));
});
check('但它出现在 ignoredEntries 里，带 action=kept（可恢复）', () => {
  const after = buildReview(memories, { now, hits, ignored: readIgnored(vault) });
  const entry = after.ignoredEntries.find((item) => item.id === 'a');
  assert.ok(entry);
  assert.equal(entry.action, 'kept');
});
check('旧格式（值是 ISO 字符串）仍读成 ignored', () => {
  const dir = path.join(vault, '.dsh-memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-ignored.json'), JSON.stringify({ ids: { z: '2026-11-20T00:00:00.000Z' } }), 'utf8');
  const entries = readIgnoredActions(vault);
  assert.equal(entries[0][1].action, 'ignored');
});

console.log(`\nselftest31：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
