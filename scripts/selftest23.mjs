/**
 * 自测 23：L1 热度强化。
 *
 * 排序从「衰减」变成「衰减 + 强化」：被想起（L1 命中）或被读过都会抬高保留率，
 * 但上限 1.25，不能让「用得勤」压过「话对得上」。
 */
import assert from 'node:assert/strict';

import { retentionOf, selectL1, HALF_LIFE_DAYS } from '../lib/l1.js';

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

const now = new Date('2026-11-24T12:00:00+08:00');
const daysAgo = (days) => {
  const d = new Date(now.getTime() - days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const memory = (over = {}) => ({
  id: over.id ?? 'mem_a',
  type: 'experience',
  status: 'verified',
  title: '记忆插件的 L1 打分',
  tags: ['记忆插件'],
  importance: 50,
  pinned: false,
  updated: daysAgo(0),
  reads: 0,
  expires: '',
  core: '测试用。',
  ...over,
});

const ctx = {
  agent: {
    session: {
      eventsSnapshot: [
        { type: 'user/message', data: { content: [{ type: 'text', text: '记忆插件 L1 打分现在怎么排的' }] } },
      ],
    },
  },
};

console.log('L1 热度强化');

await check('刚更新的经验保留率接近 1（无强化）', () => {
  const r = retentionOf(memory(), now, 0);
  assert.ok(r > 0.99 && r <= 1.0001, `应≈1，实际 ${r}`);
});

await check('一个半衰期后衰减到 0.75（下限是 0.5）', () => {
  const r = retentionOf(memory({ updated: daysAgo(HALF_LIFE_DAYS.experience) }), now, 0);
  assert.ok(Math.abs(r - 0.75) < 0.01, `应≈0.75，实际 ${r}`);
});

await check('被想起 4 次会抬高保留率', () => {
  const old = memory({ updated: daysAgo(60) });
  const cold = retentionOf(old, now, 0);
  const warm = retentionOf(old, now, 4);
  assert.ok(warm > cold + 0.1, `强化后应明显更高：${cold} → ${warm}`);
});

await check('强化不会无限涨，上限 1.25', () => {
  const r = retentionOf(memory({ updated: daysAgo(0) }), now, 999);
  assert.ok(r <= 1.25 + 1e-9, `上限 1.25，实际 ${r}`);
});

await check('hits 为负数/NaN 当作 0', () => {
  const base = retentionOf(memory(), now, 0);
  assert.equal(retentionOf(memory(), now, -5), base);
  assert.equal(retentionOf(memory(), now, Number.NaN), base);
});

await check('selectL1 接受 hits 映射，热度高的排前面', () => {
  const hot = memory({ id: 'mem_hot', updated: daysAgo(30) });
  const cold = memory({ id: 'mem_cold', updated: daysAgo(30) });
  const plain = selectL1([cold, hot], ctx, {});
  const boosted = selectL1([cold, hot], ctx, { hits: { mem_hot: { hits: 12 } } });
  assert.equal(plain.rows.length >= 1, true);
  assert.equal(boosted.rows[0].memory.id, 'mem_hot', '有热度的应排第一');
});

await check('reads 也算强化（hits 传数字也一样）', () => {
  const read = memory({ id: 'mem_read', updated: daysAgo(30), reads: 6 });
  const cold = memory({ id: 'mem_cold2', updated: daysAgo(30) });
  const out = selectL1([cold, read], ctx, {});
  assert.equal(out.rows[0].memory.id, 'mem_read', '读过的应排前');
});

await check('retention 在 rows 里可读，且不超过 1.25', () => {
  const out = selectL1([memory({ updated: daysAgo(30) })], ctx, { hits: { mem_a: 3 } });
  assert.ok(out.rows.length === 1);
  assert.ok(out.rows[0].retention > 0 && out.rows[0].retention <= 1.25);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
