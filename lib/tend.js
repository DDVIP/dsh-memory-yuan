/**
 * memory_tend：按体检单子的建议动手，但只做可逆动作、每条留一行痕迹。
 *
 * 三条护栏（2026-11-23 定的，不能少）：
 *   ① 只做可逆动作：标 superseded（文件还在）、补 evidence、降为 candidate、续期、合并时两边都保留。不删文件。
 *   ② 每次动留一行记录：写进 Daily/YYYY-MM-DD.md 的流水，带 [插件] 来源标记。
 *   ③ decision / preference 两类只列不改——那两类是人定的，工具不动。
 *
 * 输入是「要处理哪几条、怎么处理」：items 里每条 { id, action?, value? }，
 * action 省略时用体检单上那条建议（suggest.action）。
 */
import path from 'node:path';

import { loadMemories } from './vault.js';
import { setMemoryEvidence, setMemoryExpiry, setMemoryStatus } from './store.js';
import { appendStream } from './stream.js';
import { reviewVault } from './review.js';

const LOCKED_TYPES = new Set(['decision', 'preference']);
const ALLOWED = new Set(['supersede', 'evidence', 'demote', 'renew', 'merge', 'none']);

function collectSuggests(review) {
  const map = new Map();
  const groups = [
    ['stale', review?.stale],
    ['unused', review?.unused],
    ['merge', review?.merge],
    ['noEvidence', review?.noEvidence],
    ['expired', review?.expired],
  ];
  for (const [group, rows] of groups) {
    for (const row of rows ?? []) {
      const id = row?.id ?? row?.a?.id;
      if (id && !map.has(id)) map.set(id, { group, suggest: row.suggest });
    }
  }
  return map;
}

function describeBefore(memory, action) {
  if (action === 'supersede') return `status=${memory.status}`;
  if (action === 'evidence') return memory.evidence ? `evidence=${memory.evidence}` : 'evidence 空';
  if (action === 'demote') return `status=${memory.status}`;
  if (action === 'renew') return `expires=${memory.expires || '空'}`;
  return `status=${memory.status}`;
}

/**
 * 按建议处理一批记忆。
 * @returns {{ok:boolean,dryRun:boolean,applied:Array,skipped:Array,logged:number,message?:string}}
 */
export function tendVault(vaultPath, { items = [], dryRun = true, now = new Date() } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, dryRun: Boolean(dryRun), applied: [], skipped: [], logged: 0, message: '要给 items（要处理哪几条）' };
  }
  const memories = loadMemories(vaultPath);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const suggests = collectSuggests(reviewVault(vaultPath, { now }));
  const applied = [];
  const skipped = [];
  let logged = 0;

  for (const raw of items) {
    const id = String(raw?.id ?? '').trim();
    if (!id) {
      skipped.push({ id: '', reason: '缺 id' });
      continue;
    }
    const memory = byId.get(id);
    if (!memory) {
      skipped.push({ id, reason: '库里找不到这条（id 不对或文件已不在）' });
      continue;
    }
    if (LOCKED_TYPES.has(memory.type)) {
      skipped.push({ id, title: memory.title, reason: 'decision / preference 是人定的，工具不动' });
      continue;
    }
    const planned = suggests.get(id)?.suggest;
    let action = String(raw?.action ?? planned?.action ?? '').toLowerCase();
    if (!action || action === 'none') {
      skipped.push({ id, title: memory.title, reason: '这条的建议是「不动」' });
      continue;
    }
    if (!ALLOWED.has(action)) {
      skipped.push({ id, title: memory.title, reason: `不认的动作：${action}` });
      continue;
    }
    const value = raw?.value !== undefined ? String(raw.value) : String(planned?.value ?? '');
    const reason = String(raw?.reason ?? planned?.reason ?? '');

    let result = { ok: true };
    let after = '';
    if (!dryRun) {
      if (action === 'supersede') {
        result = setMemoryStatus(memory.path, 'superseded', { now });
        after = 'status=superseded';
      } else if (action === 'evidence') {
        if (!value.trim()) {
          skipped.push({ id, title: memory.title, reason: '补证据需要 value（要写什么出处）' });
          continue;
        }
        result = setMemoryEvidence(memory.path, value, { now });
        after = `evidence=${value.slice(0, 60)}${value.length > 60 ? '…' : ''}`;
      } else if (action === 'demote') {
        result = setMemoryStatus(memory.path, 'candidate', { now });
        after = 'status=candidate';
      } else if (action === 'renew') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
          skipped.push({ id, title: memory.title, reason: '续期要给 YYYY-MM-DD' });
          continue;
        }
        result = setMemoryExpiry(memory.path, value.trim(), { now });
        after = `expires=${value.trim()}`;
      } else if (action === 'merge') {
        const dropId = String(raw?.drop ?? planned?.drop?.id ?? '').trim();
        const drop = dropId ? byId.get(dropId) : null;
        if (!drop) {
          skipped.push({ id, title: memory.title, reason: '合并要指明 drop（哪条让位）' });
          continue;
        }
        if (LOCKED_TYPES.has(drop.type)) {
          skipped.push({ id, title: memory.title, reason: '要并掉的那条是 decision / preference，工具不动' });
          continue;
        }
        const dropResult = setMemoryStatus(drop.path, 'superseded', { now });
        result = dropResult.ok ? { ok: true } : dropResult;
        after = `把「${drop.title}」标为 superseded`;
      }
    } else {
      after = `（试运行）${action}${value ? `：${value.slice(0, 60)}` : ''}`;
    }

    if (!result.ok) {
      skipped.push({ id, title: memory.title, reason: result.message ?? '写入失败' });
      continue;
    }
    applied.push({
      id,
      title: memory.title,
      action,
      before: describeBefore(memory, action),
      after,
      path: path.basename(memory.path),
    });
    if (!dryRun) {
      const note = appendStream({
        vaultPath,
        kind: 'daily',
        content: `处理 ${id}「${memory.title}」：${action}${after ? `（${after}）` : ''}${reason ? `，因为 ${reason}` : ''}`,
        by: '插件',
        at: now,
      });
      if (note.ok) logged += 1;
    }
  }

  return { ok: true, dryRun: Boolean(dryRun), applied, skipped, logged };
}
