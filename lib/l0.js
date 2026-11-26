/**
 * L0：pinned 的硬规矩与长期偏好，每轮全量注入。
 *
 * 只认 decision / preference 两种 type —— 事实类（knowledge、project-state）
 * 再重要也不该每轮占位置，它们归 L1 检索。
 */
import { flatten } from './vault.js';

export const L0_TYPES = new Set(['decision', 'preference']);

export const L0_DEFAULTS = {
  maxItems: 12,
  maxChars: 800,
  maxCoreChars: 140,
};

/** 某些类型全文更长，截断阶段给宽一点。 */
export const PER_TYPE_CORE_CHARS = {
  decision: 240,
};

const HEADING = '## 记忆 · L0（每轮全量：pinned 的硬规矩与长期偏好，不是全部记忆）';

function footer(vaultPath) {
  return `（此段由 dsh-memory-yuan 从 vault 生成，改记忆＝改文件）库：${vaultPath ?? ''}`;
}

/** 按码点数字数，跟中文习惯一致。 */
export function textLength(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * 截断：优先断在句末标点之后，断不了就硬切并补省略号。
 * limit 为 Infinity 时不截。
 */
export function clip(text, limit) {
  const source = flatten(text);
  if (!Number.isFinite(limit) || limit <= 0) return source;
  if (source.length <= limit) return source;

  const slice = Array.from(source).slice(0, limit).join('');
  const lastStop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('.'), slice.lastIndexOf(';'));
  if (lastStop >= limit * 0.4) return slice.slice(0, lastStop + 1);
  return `${slice.replace(/[，、,;；\s]+$/, '')}…`;
}

/** 选出 L0 条目：active + pinned + decision/preference，按 importance、更新时间排序。 */
export function selectL0(memories, options = {}) {
  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : L0_DEFAULTS.maxItems;
  return (memories ?? [])
    .filter((memory) => memory.status === 'verified' && memory.pinned && L0_TYPES.has(memory.type))
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return String(b.updated).localeCompare(String(a.updated));
    })
    .slice(0, maxItems);
}

function renderLine(memory, coreLimit) {
  const core = coreLimit === Infinity ? flatten(memory.core) : clip(memory.core, coreLimit);
  return `- [${memory.type}·${memory.importance}] ${memory.title}：${core}`;
}

/**
 * 渲染 L0 段。放不下时先丢整条（不切半条），footer 报丢了几条。
 * 同一份 vault 两次渲染必须完全一致 —— 系统提示词靠这个保住缓存前缀。
 */
export function renderL0(selected, options = {}) {
  if (!Array.isArray(selected) || selected.length === 0) return '';

  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : L0_DEFAULTS.maxChars;
  const maxCoreChars = Number.isFinite(options.maxCoreChars) ? options.maxCoreChars : L0_DEFAULTS.maxCoreChars;
  const tail = footer(options.vaultPath);

  // 先试全文：放得下就一个字不切（三条规矩那种短文靠这个整段进）。
  const fullLines = selected.map((memory) => renderLine(memory, Infinity));
  const full = [HEADING, ...fullLines, tail].join('\n');
  if (textLength(full) <= maxChars) return full;

  // 超预算：按条截断并丢放不下的整条。
  const kept = [];
  let used = textLength(HEADING) + textLength(tail) + 2;
  for (const memory of selected) {
    const limit = PER_TYPE_CORE_CHARS[memory.type] ?? maxCoreChars;
    const line = renderLine(memory, limit);
    const cost = textLength(line) + 1;
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }

  const dropped = selected.length - kept.length;
  const tailText = dropped > 0 ? `（另有 ${dropped} 条因篇幅未注入）\n${tail}` : tail;
  return [HEADING, ...kept, tailText].join('\n');
}

/** L0 的候选总数（不受 maxItems 限制），用来告诉用户「还有几条没进来」。 */
export function countL0Candidates(memories) {
  return (memories ?? []).filter((memory) => memory.status === 'active' && memory.pinned && L0_TYPES.has(memory.type)).length;
}

/** 一步到位：读好的 memories 进，注入文本出。 */
export function buildL0(memories, options = {}) {
  const selected = selectL0(memories, options);
  const text = renderL0(selected, options);
  if (!text) return text;
  // maxItems 也会截断：被条数上限挡在前面的要说一声，否则「还有几条没注入」是隐形的。
  const extra = countL0Candidates(memories) - selected.length;
  if (extra <= 0) return text;
  const lines = text.split('\n');
  const tail = lines.pop();
  return [...lines, `（另有 ${extra} 条合格的 pinned 记忆受条数上限未注入）`, tail].join('\n');
}
