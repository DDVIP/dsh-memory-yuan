/**
 * L1：按这一轮对话里的线索检索记忆，命中才注入一行摘要。
 *
 * 为什么不用 search.js 的 tokenize：中文没有空格，「按当前对话关键词」切出来
 * 整句是一个 token，includes 几乎不命中。所以这里自己用中文 2/3 字滑窗 n-gram。
 *
 * 文本从哪来（踩坑记录）：宿主 context 里能用的只有
 *   context.agent.session.eventsSnapshot —— 事件数组，文本在 event.data.content[].text。
 * agent.frozenMessages 是 WeakSet（不可枚举），agent.inbox 是 ReactLoopInbox（读它有副作用），
 * 两条路都不能用。
 */
import { clip, textLength } from './l0.js';
import { localDateStamp } from './stream.js';

export const L1_DEFAULTS = {
  maxItems: 4,
  minHits: 2,
  minScore: 4,
  minStrongHits: 1,
  maxCoreChars: 70,
};

const HEADING = '## 记忆 · L1（这轮话里提到了，先给一行；要全文用 memory_get）';
const FOOTER = '（此段由 dsh-memory-yuan 按线索检索，不是全部记忆）';

/** 太泛、不能当线索的词。 */
const STOP_GRAMS = new Set([
  '的', '了', '是', '在', '和', '就', '都', '而', '也', '还', '又', '很', '把', '被', '让', '给', '对', '从', '到',
  '这', '那', '哪', '什么', '怎么', '为什么', '因为', '所以', '但是', '如果', '然后', '可以', '不要', '已经', '就是',
  '一个', '我们', '你们', '他们', '自己', '这个', '那个', '时候', '现在', '东西', '事情', '问题', '需要', '可能',
  '应该', '知道', '觉得', '以及', '或者', '而且', '不过', '还是', '这样', '那样', '起来', '出来', '过来', '下来',
  '上面', '下面', '里面', '外面', '之前', '之后', '一样', '一定', '没有', '不是', '不能', '不会', '一次', '一点',
  'of', 'in', 'on', 'to', 'is', 'it', 'be', 'as', 'at', 'by', 'or', 'if', 'no', 'so', 'do', 'up', 'we', 'he', 'she',
  'my', 'me', 'us', 'an', 'the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'not', 'has', 'had', 'was',
  'were', 'will', 'can', 'all', 'but',
  // 路径与技术噪音：这些词在几乎每条记忆的正文里都出现，命中它们不代表相关。
  'dsh', 'worlds', 'default', 'vault', 'room', 'md', 'json', 'state', 'context', 'api', 'http', 'www', 'com',
  'exe', '文件', '路径', '两个', '了什',
]);

/** 只有 user/message 与 assistant/message 是对话，其余是工具与流程。 */
const CONVERSATION_TYPES = new Set(['user/message', 'assistant/message']);

const TEXT_KEYS = ['text', 'content', 'message', 'body', 'data', 'summary', 'title', 'prompt'];

/** 注入的 system-reminder / skills / 压缩摘要不是用户说的话，别当线索。 */
const INJECTED_PREFIXES = [
  '<',
  '[Compressed conversation section]',
  'The following information describes your current session',
  'PROBE STANDING',
  'DEBUG-CONTEXT',
];

function isInjected(text) {
  const trimmed = String(text ?? '').trimStart();
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** 从任意结构里挖文本（字符串 / 数组 / 对象）。 */
export function textOf(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const key of TEXT_KEYS) {
      if (!(key in value)) continue;
      const part = textOf(value[key], depth + 1);
      if (part) parts.push(part);
    }
    return parts.join('\n');
  }
  return '';
}

/** 收集所有 { type:'text', text } 块的文本。 */
function extractTexts(value, depth = 0, out = []) {
  if (value == null || depth > 6) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTexts(item, depth + 1, out);
    return out;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string' && value.text.trim()) out.push(value.text);
    for (const key of ['content', 'message', 'body', 'parts', 'data']) {
      if (key in value) extractTexts(value[key], depth + 1, out);
    }
  }
  return out;
}

/** Map / Set / 普通对象 / 数组 都转成数组。 */
export function toArray(collection) {
  if (Array.isArray(collection)) return collection;
  if (collection == null) return [];
  if (typeof collection.values === 'function') {
    try {
      return [...collection.values()];
    } catch {
      return [];
    }
  }
  if (typeof collection === 'object') return Object.values(collection);
  return [];
}

/**
 * 只取 user/message，从尾部往前最多 limit 条。
 * 理由（实测）：assistant 的长回复里满是「记忆」「插件」「memory」「js」这类词，会把 vault 里
 * 所有沾边的条目都拉进来（「这台机器底账」「回复漏标签」被命中过），用户说的话才是任务主题。
 */
function pickConversation(events, limit) {
  const picked = [];
  for (let i = events.length - 1; i >= 0 && picked.length < limit; i -= 1) {
    const item = events[i];
    if (item?.type !== 'user/message') continue;
    const parts = extractTexts(item?.data).filter((text) => text.trim() && !isInjected(text));
    if (!parts.length) continue;
    picked.unshift(parts.join('\n').slice(0, 800));
  }
  return picked;
}

/** 取本轮对话文本；拿不到就返回空数组（L1 随之空转）。 */
export function collectConversationTexts(context, { maxMessages = 10 } = {}) {
  const events = toArray(context?.agent?.session?.eventsSnapshot);
  if (!events.length) return [];
  return pickConversation(events, maxMessages);
}

/**
 * 切线索：英文按词（≥2 字符），中文按 2/3 字滑窗。
 * 返回去重后的数组。
 */
export function grams(text, sizes = [2, 3]) {
  const source = String(text ?? '').toLowerCase();
  const out = new Set();

  for (const word of source.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
    if (!STOP_GRAMS.has(word)) out.add(word);
  }

  const chunks = source.replace(/[^\u4e00-\u9fa5]+/g, '|').split('|').filter(Boolean);
  for (const chunk of chunks) {
    const chars = Array.from(chunk);
    for (const size of sizes) {
      for (let i = 0; i + size <= chars.length; i += 1) {
        const token = chars.slice(i, i + size).join('');
        if (!STOP_GRAMS.has(token)) out.add(token);
      }
    }
  }

  return [...out];
}

/**
 * 词表：从所有记忆的「标题 + 标签」里切出 n-gram，并统计每个词出现在多少条记忆里（df）。
 * 这是最省事的「分词」：没有词典就用记忆自己的标题/标签当词典——能当线索的词，本来就该是记忆里有的词。
 */
const VOCABULARY_CACHE = new WeakMap();

export function buildVocabulary(memories) {
  const list = memories ?? [];
  // loadMemories 有指纹缓存，库没变时返回同一个数组引用：词表按数组引用缓存，库变了自然重建。
  if (list.length && VOCABULARY_CACHE.has(list)) return VOCABULARY_CACHE.get(list);
  const df = new Map();
  for (const memory of list) {
    const text = `${memory?.title ?? ''} ${(memory?.tags ?? []).join(' ')}`;
    for (const token of grams(text, [2, 3, 4, 5, 6])) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const vocabulary = { df, size: list.length };
  if (list.length) VOCABULARY_CACHE.set(list, vocabulary);
  return vocabulary;
}

/**
 * 把对话里的 n-gram 候选收敛成「词」：
 * 1) 只留词表里有的（没在任何记忆标题/标签里出现过的字串，不当线索）；
 * 2) 按长度从长到短，若一个词是已保留词的子串就丢掉（「记忆」「忆插」「记忆插」只留「记忆插件」）。
 */
export function filterByVocabulary(candidates, vocabulary) {
  const df = vocabulary?.df;
  if (!df || !df.size) return [];
  const accepted = [];
  for (const token of [...candidates].sort((a, b) => textLength(b) - textLength(a))) {
    if (!df.has(token)) continue;
    if (accepted.some((kept) => kept.includes(token))) continue;
    accepted.push(token);
  }
  return accepted;
}

/**
 * 从对话里抽线索词：中文按词表做最长匹配（1 个词只算一次），英文按词。
 * 为什么不用 n-gram 滑窗：滑窗会把「记忆」「忆插」「记忆插」「忆插件」当成 4 个不同命中，
 * 撑满 L1、界面「命中：」也像乱码（2026-11-22 主人报的）。词表来自记忆标题/标签，天然是「词」。
 */
export function extractTokens(texts, vocabulary) {
  const df = vocabulary?.df;
  if (!df || !df.size) return [];
  const out = new Set();
  for (const text of texts ?? []) {
    const source = String(text ?? '').toLowerCase();
    for (const word of source.match(/[a-z][a-z0-9_]{1,}/g) ?? []) {
      if (!STOP_GRAMS.has(word) && df.has(word)) out.add(word);
    }
    const chunks = source.replace(/[^\u4e00-\u9fa5]+/g, '|').split('|').filter(Boolean);
    for (const chunk of chunks) {
      const chars = Array.from(chunk);
      let i = 0;
      while (i < chars.length) {
        let found = '';
        const maxSize = Math.min(8, chars.length - i);
        for (let size = maxSize; size >= 2; size -= 1) {
          const candidate = chars.slice(i, i + size).join('');
          if (!STOP_GRAMS.has(candidate) && ![...candidate].some((ch) => SKIP_CHARS.has(ch)) && df.has(candidate)) {
            found = candidate;
            break;
          }
        }
        if (found) {
          out.add(found);
          i += Array.from(found).length;
        } else {
          i += 1;
        }
      }
    }
  }
  return [...out];
}

/** 词的区分度：在这批记忆里越少见越值钱（df 越小 idf 越大）。 */
export function idfOf(token, vocabulary) {
  const total = Math.max(vocabulary?.size ?? 0, 1);
  const df = vocabulary?.df?.get(token) ?? 0;
  const raw = Math.log((total + 1) / (Math.max(df, 1) + 0.5));
  const maxRaw = Math.log((total + 1) / 1.5);
  if (!(maxRaw > 0)) return 1.6;
  // 归一化到 0.6–1.6：只在这一条记忆里出现 → 1.6；到处都有 → 0.6。
  const ratio = Math.max(0, Math.min(raw, maxRaw)) / maxRaw;
  return 0.6 + ratio;
}

/** 虚词：候选词里带这些字就跳过（避免「记忆插件的」「按线索命中」这类跨虚词片段当选）。 */
const SKIP_CHARS = new Set([...'的了是和与就该要按把被也都而及或']);

/** 字段权重：标题和 tag 命中比正文命中更有意义。 */
const FIELD_WEIGHT = { title: 2, tags: 2, core: 1.5, body: 0.5 };

/**
 * 半衰期（天）：借的是 dsh-memory-net 的「越久没想起越糊」，但只借排序那一层。
 * 长期事实不该衰（decision 十年、preference/profile 五年），经验最该衰（60 天）。
 * 我们不真的删、不真的降档，只让老条目在 L1 里让位给新条目。
 */
export const HALF_LIFE_DAYS = {
  decision: 3650,
  preference: 1825,
  profile: 1825,
  knowledge: 365,
  'project-state': 90,
  experience: 60,
};

/**
 * 保留率：衰减 + 强化。只用于排序，不用来过滤。
 *
 * 衰减沿用半衰期（一个半衰期后 0.75，越老越靠近下限 0.5，刚更新时接近 1）；
 * 强化借 @wilshi/dsh-memory-engine 的做法：被想起（L1 命中 / 被读过）就往上抬，
 * 4 次左右到半饱和，最多 +0.3。上限 1.25 —— 不让「用得勤」压过「话对得上」。
 */
export function retentionOf(memory, now = new Date(), boosts = 0) {
  const halfLife = HALF_LIFE_DAYS[memory?.type] ?? 180;
  const updated = Date.parse(String(memory?.updated ?? '').replace(' ', 'T'));
  const count = Number.isFinite(Number(boosts)) ? Math.max(0, Number(boosts)) : 0;
  if (!Number.isFinite(updated)) return Math.min(1.25, 1 + 0.3 * (1 - Math.exp(-count / 4)));
  const ageDays = Math.max(0, (now.getTime() - updated) / 86400000);
  const freshness = Math.exp((-Math.LN2 * ageDays) / halfLife);
  const decay = 0.5 + 0.5 * freshness;
  const boost = 0.3 * (1 - Math.exp(-count / 4));
  return Math.min(1.25, decay + boost);
}

/** 线索词权重：中文 3 字以上更有指向性，2 字泛词只给基础分，英文保持 1。 */
function tokenWeight(token) {
  if (!/^[\u4e00-\u9fa5]+$/.test(token)) return 1;
  return textLength(token) >= 3 ? 1.5 : 1;
}

/**
 * 字段里有没有这个词。
 * 英文按词边界（`js` 不该命中 `json`，自测 8 发现的假阳性）；中文没有空格，仍用 includes。
 */
function hasToken(text, token) {
  if (!/^[a-z0-9_]+$/.test(token)) return text.includes(token);
  return new RegExp(`(?:^|[^a-z0-9_])${token}(?![a-z0-9_])`).test(text);
}

/** 打分：每个线索词取它命中的最高权重字段，累加；strongHits 统计落在标题/tag 的词。 */
export function scoreByTokens(memory, tokens, vocabulary = null) {
  if (!tokens || tokens.length === 0) return { score: 0, hits: 0, strongHits: 0, matched: [] };

  const fields = {
    title: String(memory?.title ?? '').toLowerCase(),
    tags: (memory?.tags ?? []).join(' ').toLowerCase(),
    core: String(memory?.core ?? '').toLowerCase(),
    body: String(memory?.body ?? '').toLowerCase(),
  };

  let score = 0;
  let hits = 0;
  let strongHits = 0;
  const contributions = [];
  for (const token of tokens) {
    let best = 0;
    let strong = false;
    for (const [field, weight] of Object.entries(FIELD_WEIGHT)) {
      if (hasToken(fields[field], token)) {
        best = Math.max(best, weight);
        if (field === 'title' || field === 'tags') strong = true;
      }
    }
    if (best > 0) {
      const gain = best * tokenWeight(token) * (vocabulary ? idfOf(token, vocabulary) : 1);
      score += gain;
      hits += 1;
      if (strong) strongHits += 1;
      contributions.push({ token, gain });
    }
  }
  // 命中词只给得分最高的 1–2 个（界面「命中：」不该列一串重叠子串）。
  const matched = contributions
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 2)
    .map((item) => item.token);
  return { score, hits, strongHits, matched };
}

/**
 * 选出 L1 命中的记忆（结构化，给 UI 用命中词）。
 * options: { maxItems, minHits, minScore, maxMessages, excludeIds }
 */
export function selectL1(memories, context, options = {}) {
  const texts = collectConversationTexts(context, { maxMessages: options.maxMessages ?? 10 });
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens(texts, vocabulary);
  // 线索太短（只有 1 个词）容易被一个泛词带偏，宁可不注入。
  if (tokens.length < 2) return { tokens, texts, vocabulary, rows: [] };

  const excludeIds = options.excludeIds instanceof Set ? options.excludeIds : new Set(options.excludeIds ?? []);
  const hitIndex = options.hits && typeof options.hits === 'object' ? options.hits : {};
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : L1_DEFAULTS.maxItems;
  const minHits = Math.min(Number.isFinite(options.minHits) ? options.minHits : L1_DEFAULTS.minHits, tokens.length);
  const minScore = Number.isFinite(options.minScore) ? options.minScore : L1_DEFAULTS.minScore;
  const minStrongHits = Number.isFinite(options.minStrongHits) ? options.minStrongHits : L1_DEFAULTS.minStrongHits;

  const today = localDateStamp(options.today ? new Date(options.today) : new Date());
  const now = options.now ? new Date(options.now) : new Date();
  // disputed / superseded 不注入；candidate 可以（还没被确认，但可能有用）；过期的不要。
  const isLive = (memory) => {
    if (memory.status !== 'verified' && memory.status !== 'candidate') return false;
    if (memory.expires && memory.expires < today) return false;
    return true;
  };

  const boostsOf = (memory) => {
    const entry = hitIndex?.[memory.id];
    const hitCount = typeof entry === 'number' ? entry : Number(entry?.hits ?? 0);
    return (Number.isFinite(hitCount) ? hitCount : 0) + (Number(memory.reads) || 0);
  };

  const rows = (memories ?? [])
    .filter((memory) => isLive(memory) && !excludeIds.has(memory.id))
    .map((memory) => ({ memory, retention: retentionOf(memory, now, boostsOf(memory)), ...scoreByTokens(memory, tokens, vocabulary) }))
    .filter((row) => row.hits >= minHits && row.score >= minScore && row.strongHits >= minStrongHits)
    .sort((a, b) => b.score * b.retention - a.score * a.retention || b.memory.importance - a.memory.importance)
    .slice(0, maxItems);

  return { tokens, texts, vocabulary, rows };
}

/** 渲染 L1 段：每条一行，一句话摘要。 */
export function buildL1(memories, context, options = {}) {
  const { rows } = selectL1(memories, context, options);
  if (!rows.length) return '';

  const maxCoreChars = Number.isFinite(options.maxCoreChars) ? options.maxCoreChars : L1_DEFAULTS.maxCoreChars;
  const lines = rows.map((row) => {
    const memory = row.memory;
    return `- [${memory.type}·${memory.id}] ${memory.title}：${clip(memory.core, maxCoreChars)}`;
  });

  return [HEADING, ...lines, FOOTER].join('\n');
}

export { HEADING as L1_HEADING, FOOTER as L1_FOOTER, textLength };
