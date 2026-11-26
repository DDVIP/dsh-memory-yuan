// 写入时「撞题」检测：新条目和库里已有的同类型条目说的是同一件事时提醒。
// 不阻断写入、不改任何文件——改不改由人决定，这里只把可能性摆出来。
//
// 为什么要它：decision / preference 是「人定的」，最怕的是同一件事前后写了两条结论相反的记忆，
// 两条都 active、都进 L0，模型每轮看到两份相反的话。这里在写入那一刻把「可能撞」的旧条目列出来，
// 提示用 supersedes 明确替代，而不是让两份一起留着。
import { titleTerms, overlapRatio } from './review.js';

/** 越「硬」的类型越值得提醒：人定的规矩。 */
export const CONFLICT_TYPES = new Set(['decision', 'preference']);

/** 标题词重合到多少算「说的是同一件事」。 */
export const CONFLICT_TITLE_OVERLAP = 0.5;

/** 最多列几条，别把返回撑爆。 */
export const CONFLICT_MAX = 5;

/**
 * 找出可能和新条目撞题的旧记忆。
 *
 * @param {Array} memories 库里的全部记忆（loadMemories 的结果）
 * @param {{ id?: string, type?: string, title?: string, tags?: string[] }} candidate 准备写的条目
 * @param {{ max?: number }} options
 * @returns {Array<{id,title,type,importance,pinned,updated,hard,sameTags,overlap}>}
 */
export function findConflicts(memories, candidate = {}, { max = CONFLICT_MAX } = {}) {
  const type = String(candidate.type ?? '');
  if (!type) return [];
  const tags = new Set((candidate.tags ?? []).map((tag) => String(tag).toLowerCase()));
  // overlapRatio 自己会切词，这里必须传原始标题字符串（传 Set 会被 String() 成 "[object Set]"）。
  const titleText = String(candidate.title ?? '');
  const rows = [];

  for (const memory of memories ?? []) {
    if (!memory || memory.id === candidate.id) continue;
    if (memory.type !== type) continue;
    // 已经退役/有争议的不算撞题，那是历史
    if (memory.status === 'superseded' || memory.status === 'disputed') continue;

    const sharedTags = (memory.tags ?? [])
      .map((tag) => String(tag).toLowerCase())
      .filter((tag) => tags.has(tag));
    const overlap = overlapRatio(titleText, String(memory.title ?? ''));
    if (!sharedTags.length && overlap < CONFLICT_TITLE_OVERLAP) continue;

    const importance = Number(memory.importance) || 0;
    const hard = CONFLICT_TYPES.has(memory.type) || memory.pinned === true || importance >= 85;
    rows.push({
      id: memory.id,
      title: memory.title,
      type: memory.type,
      importance,
      pinned: memory.pinned === true,
      updated: String(memory.updated ?? ''),
      hard,
      sameTags: sharedTags.slice(0, 4),
      overlap: Math.round(overlap * 100) / 100,
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      b.overlap - a.overlap ||
      b.importance - a.importance ||
      String(b.updated).localeCompare(String(a.updated)),
  );
  return rows.slice(0, Math.max(0, max));
}
