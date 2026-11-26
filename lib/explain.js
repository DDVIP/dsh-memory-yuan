/**
 * 解释「这轮为什么带了这几条」。
 *
 * L0 是固定的（pinned 的 decision/preference，没得选）；L1 是检索出来的——
 * 模型只看得到注入的 4 条，看不到命中词、分数、以及「别的为什么没进来」。
 * 这个模块把那条链路摊开：线索词 → 每条候选的分数 → 被哪个阈值挡下。
 *
 * 2026-11-26 第 7 条（memory_explain）引入。
 */
import { loadMemories } from './vault.js';
import { L1_DEFAULTS, buildVocabulary, extractTokens, retentionOf, scoreByTokens } from './l1.js';
import { L0_TYPES, selectL0 } from './l0.js';
import { readState } from './snapshot.js';

const THRESHOLDS = {
  maxItems: L1_DEFAULTS.maxItems,
  minHits: L1_DEFAULTS.minHits,
  minScore: L1_DEFAULTS.minScore,
  minStrongHits: L1_DEFAULTS.minStrongHits,
};

const round1 = (value) => Math.round(Number(value ?? 0) * 10) / 10;
const round2 = (value) => Math.round(Number(value ?? 0) * 100) / 100;

function todayStamp(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function liveCheck(memory, today) {
  const reasons = [];
  if (memory.status !== 'verified' && memory.status !== 'candidate') reasons.push(`status=${memory.status} 不注入`);
  if (memory.expires && String(memory.expires) < today) reasons.push(`已过期（expires=${memory.expires}）`);
  return reasons;
}

/**
 * 本轮注入快照（不传参数时用）。
 */
export function explainState(vaultPath) {
  const memories = loadMemories(vaultPath);
  const state = readState(vaultPath);
  const last = state?.lastInject ?? null;
  return {
    ok: true,
    mode: 'state',
    total: memories.length,
    l0Candidates: selectL0(memories, {}).length,
    at: last?.at ?? '',
    session: last?.session ?? '',
    l0: Array.isArray(last?.l0) ? last.l0 : [],
    l1: Array.isArray(last?.l1) ? last.l1 : [],
    chars: last?.chars ?? { l0: 0, l1: 0, budget: 0 },
  };
}

/**
 * 按一句话预览 L1：会选中谁、谁差在哪。
 * @param {string} vaultPath
 * @param {string} query
 * @param {{ max?: number, now?: Date }} [options]
 */
export function explainRecall(vaultPath, query, { max = 10, now = new Date() } = {}) {
  const text = String(query ?? '').trim();
  const memories = loadMemories(vaultPath);
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens([text], vocabulary);
  const today = todayStamp(now);
  const l0 = selectL0(memories, {});
  const l0Ids = new Set(l0.map((memory) => memory.id));
  const minHits = Math.min(THRESHOLDS.minHits, Math.max(tokens.length, 1));

  const rows = (memories ?? [])
    .map((memory) => {
      const scored = scoreByTokens(memory, tokens, vocabulary);
      const retention = retentionOf(memory, now, Number(memory.reads) || 0);
      const blocked = [...liveCheck(memory, today)];
      if (scored.hits < minHits) blocked.push(`命中词 ${scored.hits} < ${minHits}`);
      if (scored.score < THRESHOLDS.minScore) blocked.push(`分数 ${round1(scored.score)} < ${THRESHOLDS.minScore}`);
      if (scored.strongHits < THRESHOLDS.minStrongHits) blocked.push(`标题/标签命中 ${scored.strongHits} < ${THRESHOLDS.minStrongHits}`);
      return {
        id: memory.id,
        title: memory.title,
        type: memory.type,
        status: memory.status,
        score: round2(scored.score),
        hits: scored.hits,
        strongHits: scored.strongHits,
        retention: round2(retention),
        final: round2(scored.score * retention),
        matched: scored.matched,
        inL0: l0Ids.has(memory.id),
        pass: blocked.length === 0,
        blocked,
      };
    })
    .filter((row) => row.hits > 0 || row.inL0)
    .sort((a, b) => b.final - a.final || b.score - a.score || b.strongHits - a.strongHits)
    .slice(0, max);

  const selected = rows.filter((row) => row.pass).length;
  return {
    ok: true,
    mode: 'recall',
    query: text,
    tokens,
    thresholds: THRESHOLDS,
    selected,
    rows,
  };
}

/**
 * 单条解释：它在 L0/L1 的哪条链上卡住了。
 */
export function explainOne(vaultPath, id, { now = new Date() } = {}) {
  const memories = loadMemories(vaultPath);
  const target = (memories ?? []).find((memory) => String(memory.id) === String(id));
  if (!target) return { ok: false, mode: 'one', message: `库里没有这条：${id}` };

  const today = todayStamp(now);
  const stack = [];
  const pinnedOk = target.pinned === true;
  const typeOk = L0_TYPES.has(target.type);
  if (!typeOk) stack.push(`type=${target.type} 不是 L0 收的两类（decision / preference）`);
  if (!pinnedOk) stack.push('没有 pinned，L0 不收');
  if (target.status !== 'verified') stack.push(`status=${target.status}，L0 只收 verified`);
  const inL0 = typeOk && pinnedOk && target.status === 'verified';
  const dead = liveCheck(target, today);

  // 用它自己的标题当线索：正常情况下应该能把自己检索出来（命中词都在标题里）。
  const probe = explainRecall(vaultPath, target.title ?? '', { max: 20, now });
  const self = probe.rows.find((row) => row.id === target.id) ?? null;

  return {
    ok: true,
    mode: 'one',
    id: target.id,
    title: target.title,
    type: target.type,
    status: target.status,
    pinned: pinnedOk,
    importance: Number(target.importance ?? 0),
    updated: target.updated ?? '',
    expires: target.expires ?? '',
    reads: Number(target.reads ?? 0),
    inL0,
    dead,
    self,
  };
}
