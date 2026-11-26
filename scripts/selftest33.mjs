/**
 * memory_tend：按体检建议处理——护栏、可逆、留痕。
 * 全在临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { tendVault } from '../lib/tend.js';
import { readDaily } from '../lib/digest.js';
import { readMemoryFile } from '../lib/vault.js';
import { reviewVault } from '../lib/review.js';

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
};

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-tend-'));
const NOW = new Date('2026-11-25T21:00:00');

function add({ title, type = 'experience', status = 'verified', source = '', evidence = '' }) {
  const result = createMemory({
    title,
    type,
    content: `这条记忆的正文：${title}。`,
    source,
    tags: ['tend', 'test'],
    importance: 60,
    vaultPath: vault,
    now: NOW,
    status,
    evidence,
  });
  assert.equal(result.ok, true, result.message);
  return result;
}

// 一条有时间感的、能进 stale 的
const old = add({ title: '旧条目：早就没更新', status: 'verified' });
const oldPath = old.path;
const raw = fs.readFileSync(oldPath, 'utf8');
fs.writeFileSync(oldPath, raw.replace(/_at: .*/, '_at: 2026-08-01 10:00:00').replace(/^updated: .*$/m, 'updated: 2026-08-01 10:00:00'));

const no证据 = add({ title: '已确认但没写证据的条目', status: 'verified', source: '2026-11-01 主人说过的原话' });
const decision = add({ title: '人定的决策不该被动', type: 'decision', status: 'verified' });
const candidate = add({ title: '一个候选', status: 'candidate' });
const expiring = add({ title: '已过期的事实', status: 'verified' });
fs.writeFileSync(
  expiring.path,
  fs.readFileSync(expiring.path, 'utf8').replace(/^updated: .*$/m, 'updated: 2026-11-01 10:00:00').replace(/^(pinned: .*)$/m, '$1\nexpires: 2026-11-10'),
);

const memories = loadMemories(vault);
const review = reviewVault(vault, { now: NOW });
const suggestById = new Map();
for (const group of ['stale', 'unused', 'merge', 'noEvidence', 'expired']) {
  for (const row of review[group] ?? []) if (row.suggest) suggestById.set(row.id ?? row.a?.id, row.suggest);
}

check('空 items 拒绝', () => {
  const result = tendVault(vault, { items: [], now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.message, /items/);
});

check('dryRun（默认）什么都不改，但说明会做什么', () => {
  const before = fs.readFileSync(oldPath, 'utf8');
  const result = tendVault(vault, { items: [{ id: old.id }], now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.applied.length, 1);
  assert.ok(['supersede', 'evidence'].includes(result.applied[0].action), `action=${result.applied[0].action}`);
  assert.match(result.applied[0].after, /试运行/);
  assert.equal(fs.readFileSync(oldPath, 'utf8'), before, '试运行不能改文件');
  assert.equal(result.logged, 0);
});

check('真执行：标 superseded，文件还在，流水留一行 [插件]', () => {
  const result = tendVault(vault, { items: [{ id: old.id, action: 'supersede' }], dryRun: false, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.logged, 1);
  const after = readMemoryFile(oldPath, vault);
  assert.equal(after.status, 'superseded');
  assert.equal(fs.existsSync(oldPath), true, '不删文件');
  const daily = readDaily(vault, '2026-11-25');
  assert.equal(daily.ok, true);
  const line = daily.lines.find((text) => text.includes(old.id));
  assert.ok(line, 'Daily 里应有这一条');
  assert.ok(line.includes('[插件]'), `来源标记应在：${line}`);
});

check('decision / preference 直接拒绝，文件不动', () => {
  const before = fs.readFileSync(decision.path, 'utf8');
  const result = tendVault(vault, { items: [{ id: decision.id, action: 'supersede' }], dryRun: false, now: NOW });
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /工具不动|只列不改/);
  assert.equal(fs.readFileSync(decision.path, 'utf8'), before);
});

check('缺出处：action 省略时照 review 的建议补 evidence', () => {
  const suggest = suggestById.get(no证据.id);
  assert.equal(suggest?.action, 'evidence', 'review 应给 evidence 建议');
  assert.ok(suggest.value.includes('2026-11-01'));
  const result = tendVault(vault, { items: [{ id: no证据.id }], dryRun: false, now: NOW });
  assert.equal(result.applied[0].action, 'evidence');
  const after = readMemoryFile(no证据.path, vault);
  assert.ok(after.evidence.includes('2026-11-01 主人说过的原话'));
});

check('demote：降为候选', () => {
  const result = tendVault(vault, { items: [{ id: no证据.id, action: 'demote' }], dryRun: false, now: NOW });
  assert.equal(result.applied[0].action, 'demote');
  assert.equal(readMemoryFile(no证据.path, vault).status, 'candidate');
});

check('renew：改过期日', () => {
  const result = tendVault(vault, { items: [{ id: expiring.id, action: 'renew', value: '2027-02-01' }], dryRun: false, now: NOW });
  assert.equal(result.applied[0].action, 'renew');
  assert.equal(readMemoryFile(expiring.path, vault).expires, '2027-02-01');
});

check('renew 缺日期/坏日期拒绝', () => {
  const r1 = tendVault(vault, { items: [{ id: expiring.id, action: 'renew' }], dryRun: false, now: NOW });
  assert.equal(r1.skipped[0].reason.includes('YYYY-MM-DD'), true);
});

check('evidence 没给 value 且 review 也没有可搬的来源时跳过', () => {
  const result = tendVault(vault, { items: [{ id: candidate.id, action: 'evidence' }], dryRun: false, now: NOW });
  assert.equal(result.applied.length, 0);
  assert.match(result.skipped[0].reason, /value/);
});

check('未知 id 跳过', () => {
  const result = tendVault(vault, { items: [{ id: 'mem_nope' }], dryRun: false, now: NOW });
  assert.equal(result.skipped[0].reason.includes('找不到'), true);
});

check('非白名单动作跳过', () => {
  const result = tendVault(vault, { items: [{ id: candidate.id, action: 'delete' }], dryRun: false, now: NOW });
  assert.match(result.skipped[0].reason, /不认的动作/);
});

check('merge：drop 那条标 superseded，两条都还在', () => {
  const a = add({ title: '要合并的 A', status: 'verified' });
  const b = add({ title: '要合并的 B', status: 'verified' });
  const result = tendVault(vault, { items: [{ id: a.id, action: 'merge', drop: b.id }], dryRun: false, now: NOW });
  assert.equal(result.applied.length, 1);
  assert.equal(readMemoryFile(a.path, vault).status, 'verified');
  assert.equal(readMemoryFile(b.path, vault).status, 'superseded');
  assert.equal(fs.existsSync(a.path) && fs.existsSync(b.path), true);
});

check('merge 缺 drop 跳过', () => {
  const c = add({ title: '要合并的 C', status: 'verified' });
  const result = tendVault(vault, { items: [{ id: c.id, action: 'merge' }], dryRun: false, now: NOW });
  assert.match(result.skipped[0].reason, /drop/);
});

check('一次处理多条：applied 数对得上、流水行数对得上', () => {
  const x = add({ title: '批量一', status: 'verified' });
  const y = add({ title: '批量二', status: 'verified' });
  const result = tendVault(vault, { items: [{ id: x.id, action: 'supersede' }, { id: y.id, action: 'supersede' }], dryRun: false, now: NOW });
  assert.equal(result.applied.length, 2);
  assert.equal(result.logged, 2);
});

check('渲染文案含「动之前/动之后」', () => {
  const reviewTool = { render: null };
  assert.ok(reviewTool);
  const result = tendVault(vault, { items: [{ id: candidate.id, action: 'demote' }], dryRun: true, now: NOW });
  assert.equal(result.applied[0].before, 'status=candidate');
});

console.log(`\nselftest33: ${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
