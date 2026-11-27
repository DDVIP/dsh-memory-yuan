/**
 * memory_review：只出单子，不动手。
 *
 * 四张单子：
 *   ① 疑似过时：updated 早于 60 天，且所在目录近 30 天没有新条目
 *   ② 可能没用：L1 命中 ≥3 次，但一次都没被 memory_get 读过
 *   ③ 可以合并：同 type 且（tag 交集 ≥2 且标题词重合 ≥50%，或正文 3-gram 重合 ≥60%，或一个共同 tag 且正文重合 ≥45%）
 *   ④ 已确认没出处：verified 但 evidence 是空的
 *   ⑤ 已过期：expires 已经过了（过期后不进 L1）
 *
 * 已忽略的条目不再出现在上面五张单子里，但会以 ignoredEntries 返回，界面上单列一组、可以恢复。
 *
 * 借的是 dsh-memory-doctor 的体检思路：每条都要说「为什么」（why）和「建议怎么处理」（fix），
 * 人一眼能判断，而不是丢一串 id。忽略的单子记在 .dsh-memory/review-ignored.json，不再出现。
 *
 * 为什么不自动归档：过时与否、要不要合并，得人看一眼；模型只能把线索摆出来。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadMemories } from './vault.js';
import { readHits } from './snapshot.js';

const DAY = 24 * 60 * 60 * 1000;
export const STALE_DAYS = 60;
export const PROJECT_IDLE_DAYS = 30;
export const UNUSED_HITS = 3;

/** 解析 frontmatter 里的时间；解析不出来当作 0（不参与过期判断）。 */
export function parseWhen(value) {
  const text = String(value ?? '').trim().replace(' ', 'T');
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : 0;
}

/** 标题的词：英文词 + 中文 2 字片段，够粗但能看出标题是不是在说同一件事。 */
export function titleTerms(title) {
  const out = new Set();
  const text = String(title ?? '').toLowerCase();
  for (const word of text.match(/[a-z][a-z0-9_]{1,}/g) ?? []) out.add(word);
  for (const chunk of text.replace(/[^\u4e00-\u9fa5]+/g, '|').split('|')) {
    if (!chunk) continue;
    for (let i = 0; i + 2 <= chunk.length; i += 1) out.add(chunk.slice(i, i + 2));
  }
  return out;
}

/** 从正文里取某一段（`## 来源与依据` 之类）；取不到返回 ''。 */
export function sectionOf(body, heading) {
  const text = String(body ?? '');
  const pattern = new RegExp(`^##\\s*${heading}\\s*$\\n([\\s\\S]*?)(?=^##\\s|$)`, 'm');
  const match = text.match(pattern);
  return match ? match[1].trim() : '';
}

/** 人定的两类：只列不改，suggest 一律给「不动」。 */
export const LOCKED_TYPES = new Set(['decision', 'preference']);
const isLocked = (memory) => LOCKED_TYPES.has(memory?.type);

const LOCKED_REASON = 'decision / preference 是人定的，工具只列不改';

/** 今天 + days 天，YYYY-MM-DD。 */
function shiftDate(now, days) {
  const date = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 两个标题的重合度：交集 ÷ 较小集合（「一条的标题词有一半出现在另一条」）。 */
export function overlapRatio(a, b) {
  const left = titleTerms(a);
  const right = titleTerms(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** 正文相似度：去空白标点后取前 120 字，按 3-gram 算交集 ÷ 较小集合。 */
function normBody(text, limit = 120) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}]/gu, '').slice(0, limit);
}

export function bodySimilarity(a, b) {
  const left = normBody(a);
  const right = normBody(b);
  if (left.length < 20 || right.length < 20) return 0;
  const grams = (value) => {
    const out = new Set();
    for (let i = 0; i + 3 <= value.length; i += 1) out.add(value.slice(i, i + 3));
    return out;
  };
  const first = grams(left);
  const second = grams(right);
  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared += 1;
  return shared / Math.min(first.size, second.size);
}

export function ignoredPathOf(vaultPath) {
  return path.join(vaultPath, '.dsh-memory', 'review-ignored.json');
}

/** 读已忽略清单：`{ ids: { <id>: 'YYYY-MM-DDTHH:mm:ss' } }`，坏文件当空。 */
export function readIgnored(vaultPath) {
  return new Map(readIgnoredActions(vaultPath));
}

/** 读出 { id: { at, action } }（兼容旧格式：值是 ISO 字符串）。 */
export function readIgnoredActions(vaultPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(ignoredPathOf(vaultPath), 'utf8'));
    const ids = raw && typeof raw.ids === 'object' && raw.ids ? raw.ids : {};
    return Object.entries(ids).map(([id, value]) => [
      id,
      typeof value === 'string' ? { at: value, action: 'ignored' } : { at: value?.at ?? '', action: value?.action ?? 'ignored' },
    ]);
  } catch {
    return [];
  }
}

/** 把一条加入忽略清单（原子写）。id 为空返回 ok:false。 */
export function ignoreInReview(vaultPath, id, { now = new Date(), action = 'ignored' } = {}) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, message: '要给 id' };
  try {
    const file = ignoredPathOf(vaultPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let ids = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.ids === 'object' && raw.ids) ids = raw.ids;
    } catch {
      // 坏文件当空，重建
    }
    ids[key] = { at: now.toISOString(), action: action === 'kept' ? 'kept' : 'ignored' };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, id: key, ignored: Object.keys(ids).length };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

/** 把一条从忽略清单里拿出来（恢复显示）。 */
export function unignoreInReview(vaultPath, id) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, message: '要给 id' };
  try {
    const file = ignoredPathOf(vaultPath);
    let ids = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.ids === 'object' && raw.ids) ids = raw.ids;
    } catch {
      return { ok: true, id: key, ignored: 0 };
    }
    delete ids[key];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ids }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, id: key, ignored: Object.keys(ids).length };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

export function buildReview(memories, { now = new Date(), hits = {}, ignored = new Map() } = {}) {
  // 调用方可能传 Set（老测试）或 Map（带处理方式）；统一成 Map。
  const ignoredMap = ignored instanceof Map ? ignored : new Map([...ignored].map((id) => [id, { action: 'ignored' }]));
  const nowMs = now.getTime();
  const live = (memories ?? []).filter((m) => m.status === 'verified' || m.status === 'candidate');

  const dirLatest = new Map();
  for (const memory of live) {
    const updated = parseWhen(memory.updated);
    if (updated > (dirLatest.get(memory.dir) ?? 0)) dirLatest.set(memory.dir, updated);
  }

  const stale = [];
  const unused = [];
  for (const memory of live) {
    if (ignoredMap.has(memory.id)) continue;
    const updated = parseWhen(memory.updated);
    const ageDays = updated ? Math.floor((nowMs - updated) / DAY) : null;
    const latest = dirLatest.get(memory.dir) ?? 0;
    const idleDays = latest ? Math.floor((nowMs - latest) / DAY) : null;
    if (ageDays !== null && idleDays !== null && ageDays >= STALE_DAYS && idleDays >= PROJECT_IDLE_DAYS) {
      stale.push({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        updated: memory.updated,
        days: ageDays,
        dirIdleDays: idleDays,
        why: `${ageDays} 天没更新，这个目录最近 ${idleDays} 天也没有新条目`,
        fix: '读一遍确认还成立；不成立就标为已废弃',
        locked: isLocked(memory),
        suggest: isLocked(memory)
          ? { action: 'none', reason: LOCKED_REASON }
          : { action: 'supersede', reason: `${ageDays} 天没更新，所在目录也 ${idleDays} 天没动，多半已经不成立了` },
      });
    }
    const stat = hits[memory.id] ?? {};
    const hitCount = Number(stat.hits ?? 0);
    // 只提示还得人拍板的候选：confirmed（verified）或设了过期日的条目，点了「留着」本该从单子上消失，
    // 否则用户会以为按钮没反应。
    if (
      memory.status === 'candidate' &&
      !String(memory.expires ?? '').trim() &&
      hitCount >= UNUSED_HITS &&
      Number(memory.reads ?? 0) === 0
    ) {
      unused.push({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        hits: hitCount,
        reads: 0,
        lastHitAt: stat.lastAt ?? '',
        why: `被 L1 命中 ${hitCount} 次，但一次都没被 memory_get 读过`,
        fix: '要么太泛（改窄），要么其实用不上（标为已废弃）',
        locked: isLocked(memory),
        suggest: { action: 'none', reason: '命中但没读过，可能只是还没到用它的时机；先不动' },
      });
    }
  }

  const merge = [];
  const noEvidence = [];
  for (const memory of live) {
    // 借 dsh-memory-net 的「证据门」：verified 却没有任何出处，只能是印象，不该当结论用。
    if (!ignoredMap.has(memory.id) && memory.status === 'verified' && !String(memory.evidence ?? '').trim()) {
      const sourceSection = sectionOf(memory.body, '来源与依据');
      noEvidence.push({
        id: memory.id,
        type: memory.type,
        title: memory.title,
        importance: memory.importance,
        updated: memory.updated,
        why: '状态是已确认，但没写「证据」（出处）',
        fix: '补上证据（evidence），或降为候选等人确认',
        locked: isLocked(memory),
        suggest: isLocked(memory)
          ? { action: 'none', reason: LOCKED_REASON }
          : sourceSection
            ? { action: 'evidence', value: sourceSection, reason: '正文「来源与依据」那段可以搬过去当证据' }
            : { action: 'demote', reason: '正文里没有来源可搬，先降为候选、等人确认' },
      });
    }
  }
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      if (ignoredMap.has(a.id) || ignoredMap.has(b.id)) continue;
      if (a.type !== b.type) continue;
      const sharedTags = (a.tags ?? []).filter((tag) => (b.tags ?? []).includes(tag));
      const ratio = overlapRatio(a.title, b.title);
      const bodyRatio = bodySimilarity(a.core, b.core);
      // 三条路都算「在讲同一件事」：老判据（标签+标题）、正文高度重合（标题写得不像也没关系）、
      // 标签沾一点边且正文重合（迁移进来的条目标题是整段话，靠这条捞）。
      const byTags = sharedTags.length >= 2 && ratio >= 0.5;
      const byBody = bodyRatio >= 0.6;
      const byTagBody = sharedTags.length >= 1 && bodyRatio >= 0.45;
      if (byTags || byBody || byTagBody) {
        const keepFirst = String(a.core ?? '').length >= String(b.core ?? '').length;
        const keep = keepFirst ? a : b;
        const drop = keepFirst ? b : a;
        merge.push({
          a: { id: a.id, title: a.title },
          b: { id: b.id, title: b.title },
          sharedTags,
          titleOverlap: Math.round(ratio * 100) / 100,
          why: [
            byTags ? `与「${b.title}」共享标签 ${sharedTags.join('、')}，标题词重合 ${Math.round(ratio * 100)}%` : '',
            byBody || byTagBody ? `正文重合 ${Math.round(bodyRatio * 100)}%` : '',
          ].filter(Boolean).join('；'),
          fix: '保留内容全的那条，另一条标为已废弃并在「相关记忆」里写上新的',
          locked: isLocked(a) || isLocked(b),
          suggest: isLocked(a) || isLocked(b)
            ? { action: 'none', reason: LOCKED_REASON }
            : {
                action: 'merge',
                keep: { id: keep.id, title: keep.title },
                drop: { id: drop.id, title: drop.title },
                reason: '两条在讲同一件事，保留内容多的那条，另一条标为已废弃并互相关联',
              },
        });
      }
    }
  }

  // ⑤ 已过期：expires 已经过去了。过期不等于错，是不该再进 L1 了。
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const expired = [];
  for (const memory of live) {
    if (ignoredMap.has(memory.id)) continue;
    const expires = String(memory.expires ?? '').trim();
    if (!expires || expires >= today) continue;
    expired.push({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      expires,
      updated: memory.updated,
      why: `过期了（设的是 ${expires}，今天 ${today}），不再进 L1`,
      fix: '还有用就续期（改 expires），没用就标为已废弃',
      locked: isLocked(memory),
      suggest: isLocked(memory)
        ? { action: 'none', reason: LOCKED_REASON }
        : {
            action: 'supersede',
            reason: `过期了（${expires}），不再是当前事实`,
            alternatives: [{ action: 'renew', value: shiftDate(now, 90), reason: '如果它还成立，可以续期 90 天' }],
          },
    });
  }

  // 已忽略的条目单独返回：主人要能看见「我忽略过什么」，也要能恢复。
  const ignoredEntries = (memories ?? [])
    .filter((memory) => ignoredMap.has(memory.id))
    .map((memory) => ({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      status: memory.status,
      action: ignoredMap.get(memory.id)?.action ?? 'ignored',
    }));

  return {
    stale,
    unused,
    merge,
    noEvidence,
    expired,
    ignoredEntries,
    counts: {
      stale: stale.length,
      unused: unused.length,
      merge: merge.length,
      noEvidence: noEvidence.length,
      expired: expired.length,
      ignored: ignoredEntries.length,
    },
    scanned: live.length,
  };
}

/** 读 vault 现场的体检单（给 HTTP 路由和工具共用）。 */
export function reviewVault(vaultPath, options = {}) {
  return buildReview(loadMemories(vaultPath), {
    hits: readHits(vaultPath),
    ignored: readIgnored(vaultPath),
    ...options,
  });
}
