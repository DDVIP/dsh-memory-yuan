/**
 * 写入时查重：正文高度重合的旧条目（同一个 type）列出来提示，不阻断写入。
 *
 * 和 memory_review 的合并判据共用 bodySimilarity（3-gram 重合率），
 * 区别是这里在「写入那一刻」就算，避免重复条目进了库才在体检里被捞出来。
 */
import { bodySimilarity } from './review.js';

/** 重合率到这个数才算「可能在说同一件事」。 */
export const SIMILAR_THRESHOLD = 0.6;

/**
 * @param {Array} memories loadMemories 的结果
 * @param {{ type?: string, content?: string, excludeId?: string, max?: number }} options
 * @returns {Array<{ id: string, title: string, status: string, ratio: number }>}
 */
export function findSimilar(memories, { type = '', content = '', excludeId = '', max = 3 } = {}) {
  const text = String(content ?? '');
  if (!type || text.trim().length < 20) return [];

  return (memories ?? [])
    .filter((memory) => memory && memory.id !== excludeId)
    .filter((memory) => memory.type === type)
    .filter((memory) => memory.status !== 'superseded' && memory.status !== 'disputed')
    .map((memory) => ({
      id: memory.id,
      title: memory.title,
      status: memory.status,
      ratio: Number(bodySimilarity(text, memory.core ?? '').toFixed(2)),
    }))
    .filter((row) => row.ratio >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, max);
}
