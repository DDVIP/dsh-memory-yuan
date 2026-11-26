/**
 * 工具侧检索：memory_search / memory_get 用。
 *
 * 与 L1 不同，这里的关键词来自模型自己填的 query（有空格、有分隔符），
 * 所以按分隔符切词就够，不需要中文滑窗。
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'not', 'a', 'an', 'of', 'in', 'on', 'to', 'is', 'it',
  '的', '了', '是', '在', '和', '就', '也', '有', '我', '你', '他', '她', '它', '们',
]);

/** 切词：小写、按空白与常见分隔符切开。 */
export function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[\s,，、;；/|·]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** 打分：标题 5 / tag 4 / 核心 3 / 正文 1。 */
export function scoreMemory(memory, tokens) {
  if (!tokens || tokens.length === 0) return { score: 0, hits: [] };

  const fields = {
    title: { text: String(memory?.title ?? ''), weight: 5 },
    tags: { text: (memory?.tags ?? []).join(' '), weight: 4 },
    core: { text: String(memory?.core ?? ''), weight: 3 },
    body: { text: String(memory?.body ?? ''), weight: 1 },
  };

  let score = 0;
  const hits = [];
  for (const token of tokens) {
    let best = 0;
    for (const field of Object.values(fields)) {
      if (field.text.includes(token)) best = Math.max(best, field.weight);
    }
    if (best > 0) {
      score += best;
      hits.push(token);
    }
  }
  return { score, hits };
}

/** 给工具/UI 的一行摘要。tags 里去掉与 type 重复的那一项。 */
export function summarize(memory) {
  const type = String(memory.type ?? '').toLowerCase();
  return {
    id: memory.id,
    title: memory.title,
    type: memory.type,
    status: memory.status,
    importance: memory.importance,
    pinned: memory.pinned,
    tags: (memory.tags ?? []).filter((tag) => String(tag).toLowerCase() !== type),
    updated: memory.updated,
    path: memory.path,
    excerpt: String(memory.core ?? '').slice(0, 120),
  };
}

/**
 * 检索：默认只看 active；可选 tag 全部包含、type 不区分大小写。
 * 命中越多分越高，同分按 importance。
 * 注意返回形状：**每行是 { memory, score, hits }，不是记忆对象本身**——
 * 直接调这里时用 row.memory.id，别写成 row.id（2026-11-22 自测踩过）。
 */
export function searchMemories(memories, { query = '', tags = [], type = '', includeArchived = false, limit = 8 } = {}) {
  const tokens = tokenize(query);
  const wantedTags = (tags ?? []).map((tag) => String(tag).toLowerCase()).filter(Boolean);
  const max = Number.isFinite(limit) ? limit : 8;

  const rows = (memories ?? [])
    // verified 与 candidate 都能被搜到（candidate 是「等人确认」，不是「不许用」）；
    // disputed / superseded 默认不出现，includeArchived 时才全出。
    .filter((memory) => includeArchived || memory.status === 'verified' || memory.status === 'candidate')
    .filter((memory) => !type || String(memory.type ?? '').toLowerCase() === String(type).toLowerCase())
    .filter((memory) => {
      if (wantedTags.length === 0) return true;
      const own = (memory.tags ?? []).map((tag) => String(tag).toLowerCase());
      return wantedTags.every((tag) => own.includes(tag));
    })
    .map((memory) => ({ memory, ...scoreMemory(memory, tokens) }))
    .filter((row) => (tokens.length === 0 ? true : row.score > 0))
    .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance)
    .slice(0, max);

  return rows.map((row) => ({ memory: row.memory, score: row.score, hits: row.hits }));
}

/** 按 id 或路径找一条（路径用 endsWith，允许只给文件名）。 */
export function findMemory(memories, key) {
  const needle = String(key ?? '').trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();

  return (
    (memories ?? []).find((memory) => String(memory.id).toLowerCase() === lower) ??
    (memories ?? []).find((memory) => String(memory.path).toLowerCase().endsWith(lower)) ??
    // 兜底：老 index 里可能是按文件名派生的 id（没有 frontmatter 的文件）。
    // 文件名不带目录，可能撞车，所以只在前两种都落空时才用。
    (memories ?? []).find((memory) =>
      String(memory.path)
        .toLowerCase()
        // Windows 路径是反斜杠：先统一成正斜杠，否则 endsWith('/行为策略') 永远不成立。
        .replace(/\\/g, '/')
        .replace(/\.md$/, '')
        .endsWith(`/${lower}`),
    ) ??
    null
  );
}
