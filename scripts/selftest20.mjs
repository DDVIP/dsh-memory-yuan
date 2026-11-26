/**
 * 借 dsh-memory-net 的三处优化自测：
 *   ① L1 排序带保留率（按 type 半衰期，越久没更新越靠后）
 *   ② memory_write 查重（同 type、标题归一化相同 → 提示，不阻断）
 *   ③ 体检加「已确认但没出处」（证据门）
 *
 * 全部在 mkdtemp 临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTools } from '../lib/tools.js';
import { createMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { HALF_LIFE_DAYS, retentionOf, selectL1 } from '../lib/l1.js';
import { buildReview } from '../lib/review.js';

const DAY = 24 * 60 * 60 * 1000;
let pass = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

function newVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-20-'));
}

function contextWith(text) {
  return {
    agent: {
      session: {
        eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }],
      },
    },
  };
}

const now = new Date('2026-11-23T12:00:00');
const stale = new Date(now.getTime() - 60 * DAY);

// ---------- ① 保留率 ----------
await check('半衰期表：decision 最久、experience 最短', () => {
  assert.ok(HALF_LIFE_DAYS.decision > HALF_LIFE_DAYS.knowledge);
  assert.ok(HALF_LIFE_DAYS.knowledge > HALF_LIFE_DAYS['project-state']);
  assert.ok(HALF_LIFE_DAYS['project-state'] > HALF_LIFE_DAYS.experience);
});

await check('刚更新的记忆保留率接近 1', () => {
  const m = { type: 'experience', updated: '2026-11-23 11:00:00' };
  const r = retentionOf(m, now);
  assert.ok(r > 0.99 && r <= 1, `retention=${r}`);
});

await check('60 天前的经验刚好半衰（保留率 ≈ 0.75）', () => {
  const m = { type: 'experience', updated: '2026-09-24 12:00:00' };
  const r = retentionOf(m, now);
  assert.ok(Math.abs(r - 0.75) < 0.02, `retention=${r}`);
});

await check('同样 60 天前的 decision 几乎不衰', () => {
  const m = { type: 'decision', updated: '2026-09-24 12:00:00' };
  assert.ok(retentionOf(m, now) > 0.99);
});

await check('updated 缺失或坏掉时保留率按 1 算（不误伤）', () => {
  assert.equal(retentionOf({ type: 'knowledge' }, now), 1);
  assert.equal(retentionOf({ type: 'knowledge', updated: '不是时间' }, now), 1);
});

// ---------- ①' selectL1 排序 ----------
await check('同分两条：更新的排前面', () => {
  const memories = [
    {
      id: 'mem_old',
      title: '记忆插件的排期',
      type: 'experience',
      status: 'verified',
      tags: ['记忆插件'],
      core: '记忆插件的排期定在下周。',
      body: '',
      importance: 50,
      updated: '2026-06-01 12:00:00',
    },
    {
      id: 'mem_new',
      title: '记忆插件的排期',
      type: 'experience',
      status: 'verified',
      tags: ['记忆插件'],
      core: '记忆插件的排期改到明天。',
      body: '',
      importance: 50,
      updated: '2026-11-23 11:00:00',
    },
  ];
  const { rows } = selectL1(memories, contextWith('记忆插件的排期'), { now });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].memory.id, 'mem_new');
  assert.ok(rows[0].retention > rows[1].retention);
});

await check('selectL1 的行里带 retention（0.5–1）', () => {
  const memories = [
    {
      id: 'mem_x',
      title: '记忆插件的保留率',
      type: 'experience',
      status: 'verified',
      tags: ['记忆插件'],
      core: '记忆插件的保留率。',
      body: '',
      importance: 50,
      updated: '2026-09-24 12:00:00',
    },
  ];
  const { rows } = selectL1(memories, contextWith('记忆插件的保留率'), { now });
  assert.ok(rows[0].retention >= 0.5 && rows[0].retention <= 1);
});

// ---------- ② memory_write 查重 ----------
const vault = newVault();
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));

await check('同 type、标题只差标点：返回 duplicate 指向旧条目', async () => {
  const first = await tools.memory_write.execute(
    { title: 'vault 是唯一写入源', type: 'decision', content: '第一版。', status: 'candidate' },
    {},
  );
  assert.equal(first.ok, true);
  const second = await tools.memory_write.execute(
    { title: 'vault 是唯一写入源！', type: 'decision', content: '第二版。', status: 'candidate' },
    {},
  );
  assert.equal(second.ok, true);
  assert.equal(second.duplicate?.id, first.id);
});

await check('查重不阻断：新条目照样写进去', () => {
  const all = loadMemories(vault).filter((m) => m.title.startsWith('vault 是唯一写入源'));
  assert.equal(all.length, 2);
});

await check('type 不同不算重复', async () => {
  const out = await tools.memory_write.execute(
    { title: 'vault 是唯一写入源', type: 'preference', content: '换个类型。', status: 'candidate' },
    {},
  );
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, undefined);
});

await check('传 supersedes 标掉旧条目后，同名再写不再指向被取代的那条', async () => {
  const old = await tools.memory_write.execute(
    { title: '这条会被正式替代', type: 'experience', content: '旧。', status: 'candidate' },
    {},
  );
  const next = await tools.memory_write.execute(
    { title: '这条会被正式替代', type: 'experience', content: '新。', status: 'candidate', supersedes: old.id },
    {},
  );
  assert.equal(next.superseded, old.id);
  const newer = await tools.memory_write.execute(
    { title: '这条会被正式替代', type: 'experience', content: '再写一条。', status: 'candidate' },
    {},
  );
  assert.equal(newer.ok, true);
  // 旧条目已 superseded 不算重复；查重应指向 next（活的同名条目），不是 old
  assert.equal(newer.duplicate?.id, next.id);
});

await check('render 文案里出现 duplicate 提示', async () => {
  const out = await tools.memory_write.execute(
    { title: 'vault 是唯一写入源', type: 'decision', content: '第三版。', status: 'candidate' },
    {},
  );
  const rendered = tools.memory_write.output.render({}, out);
  assert.match(rendered[0].text, /库里已有同标题的/);
  assert.match(rendered[0].text, /supersedes=/);
});

// ---------- ③ 证据门 ----------
function mem(fields) {
  return {
    id: fields.id,
    type: fields.type ?? 'knowledge',
    status: fields.status ?? 'verified',
    title: fields.title,
    dir: fields.dir ?? 'Knowledge',
    importance: fields.importance ?? 60,
    evidence: fields.evidence ?? '',
    reads: fields.reads ?? 0,
    tags: fields.tags ?? [],
    updated: fields.updated ?? '2026-11-20 10:00:00',
  };
}

await check('体检：verified 且没 evidence → 进「缺出处」单', () => {
  const review = buildReview([mem({ id: 'a1', title: '没有出处的结论', status: 'verified' })], { now });
  assert.equal(review.counts.noEvidence, 1);
  assert.equal(review.noEvidence[0].id, 'a1');
});

await check('有 evidence 的 verified 不进单', () => {
  const review = buildReview(
    [mem({ id: 'a2', title: '有出处', evidence: '2026-11-20 对话' })],
    { now },
  );
  assert.equal(review.counts.noEvidence, 0);
});

await check('candidate 不进「缺出处」单（还没确认，不算问题）', () => {
  const review = buildReview([mem({ id: 'a3', title: '候选', status: 'candidate' })], { now });
  assert.equal(review.counts.noEvidence, 0);
});

await check('memory_review 渲染里出现缺出处一节', async () => {
  const rv = newVault();
  const created = createMemory({
    vaultPath: rv,
    title: '没有出处的已确认记忆',
    type: 'knowledge',
    content: '正文。',
    status: 'verified',
  });
  assert.equal(created.ok, true);
  const review = buildReview(loadMemories(rv), { now });
  assert.ok(review.counts.noEvidence >= 1);
});

console.log(`\nselftest20：${pass} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
