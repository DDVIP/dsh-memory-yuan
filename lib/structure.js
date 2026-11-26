// 结构体检：只看「文件本身写得对不对」，不看内容好不好。
// 和 memory_review（内容层面的过时/没用/可合并）分开：
//   - review 问「这条还成立吗、还有用吗」；
//   - lint 问「这条的 frontmatter 齐不齐、type 认不认识、tags 是不是脏的、正文是不是空的」。
// 只出单子，不改任何文件。
import { TYPE_DIRS } from './store.js';
import { loadMemories, MEMORY_STATUSES } from './vault.js';
import { scanSensitive } from './sensitive.js';

export const KNOWN_TYPES = Object.keys(TYPE_DIRS);
export const LEVELS = ['error', 'warning', 'info'];

const CORE_MIN_CHARS = 12;
const TITLE_MAX_CHARS = 120;

function codePointLength(text) {
  return [...String(text ?? '')].length;
}

function hasFrontmatter(raw) {
  return /^---\r?\n/.test(String(raw ?? ''));
}

function relDirOf(memory) {
  const dir = String(memory.dir ?? '').replace(/\\/g, '/');
  const parts = dir.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 一条记忆的结构问题（每条 = {code, level, message, fix}）。 */
export function inspectMemory(memory, { idCounts = new Map() } = {}) {
  const problems = [];
  const push = (code, level, message, fix) => problems.push({ code, level, message, fix });

  if (!hasFrontmatter(memory.raw)) {
    push(
      'no-frontmatter',
      'error',
      '文件没有 frontmatter（开头不是 ---），id / type / status 都只能猜',
      '补一段 frontmatter，至少 id、type、status、title、importance',
    );
  }

  const rawId = String(memory.raw ?? '').match(/^---\r?\n[\s\S]*?^id:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!rawId) {
    push(
      'no-id',
      'warning',
      'frontmatter 里没有 id，靠文件路径派生了临时 id',
      '补一个稳定 id（形如 mem_YYYYMMDDtHHMMSS_xxxxxxxx），否则换目录/改名就找不到了',
    );
  }
  if (rawId && (idCounts.get(rawId) ?? 0) > 1) {
    push('dup-id', 'error', `id 重复：${rawId} 在库里出现 ${idCounts.get(rawId)} 次`, '给重复的条目换一个 id，检索才不会串');
  }

  if (!KNOWN_TYPES.includes(String(memory.type ?? ''))) {
    push(
      'bad-type',
      'error',
      `type「${memory.type ?? '(空)'}」不在六类里（${KNOWN_TYPES.join(' / ')}）`,
      '改成六类之一，否则不会进 L0/L1 的分类逻辑',
    );
  }

  // status 要读 frontmatter 原文：读取层会把不认识的 status 归一成 candidate，
  // 只看 memory.status 永远发现不了「写了 archived」这种问题。
  const rawStatus = String(memory.raw ?? '').match(/^---\r?\n[\s\S]*?^status:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const statusText = (rawStatus || String(memory.status ?? '')).toLowerCase();
  // 旧版用的 active 等价于 verified（读取层会归一），不算写错，不要制造噪音。
  if (!MEMORY_STATUSES.includes(statusText) && statusText !== 'active') {
    push('bad-status', 'warning', `status「${rawStatus || memory.status || '(空)'}」不是四态之一`, '改成 candidate / verified / disputed / superseded');
  }

  const title = String(memory.title ?? '').trim();
  if (!title) push('empty-title', 'error', '标题是空的', '补一句能独立看懂的标题');
  else if (codePointLength(title) > TITLE_MAX_CHARS) {
    push('long-title', 'warning', `标题 ${codePointLength(title)} 字，超过 ${TITLE_MAX_CHARS}`, '压成一句话，细节放正文');
  }

  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  if (!tags.length) push('no-tags', 'info', '没有标签，检索时只能靠标题/正文', '加两三个关键词标签');
  const lowerType = String(memory.type ?? '').toLowerCase();
  const dirtyTags = tags.filter((tag) => String(tag).toLowerCase() === lowerType);
  if (dirtyTags.length) {
    push('tag-is-type', 'warning', `tags 里混了类型词「${dirtyTags.join('、')}」`, '删掉这条 tag，类型已经由 type 表达');
  }
  const dupTags = tags.filter((tag, index) => tags.findIndex((other) => String(other).toLowerCase() === String(tag).toLowerCase()) !== index);
  if (dupTags.length) push('dup-tag', 'warning', `标签重复：${[...new Set(dupTags)].join('、')}`, '去重');

  const core = String(memory.core ?? '').trim();
  if (!core) push('empty-core', 'warning', '正文（核心内容）是空的', '至少写一句这条记忆要说明的事');
  else if (codePointLength(core) < CORE_MIN_CHARS) {
    push('short-core', 'info', `正文只有 ${codePointLength(core)} 字`, '如果它确实只是一句话，忽略这条');
  }

  const importance = Number(memory.importance);
  if (!Number.isFinite(importance) || importance < 0 || importance > 100) {
    push('bad-importance', 'warning', `importance「${memory.importance ?? '(空)'}」不在 0–100`, '夹到 0–100');
  }

  const created = String(memory.createdAt ?? '').trim();
  const updated = String(memory.updated ?? '').trim();
  // 用时间戳比，不用字符串比：迁移进来的条目 created_at 是 ISO（UTC），updated_at 是本地时间，
  // 字符串比较会把「05:04Z」判成晚于「15:08」。
  const createdMs = created ? Date.parse(created) : Number.NaN;
  const updatedMs = updated ? Date.parse(updated) : Number.NaN;
  if (Number.isFinite(createdMs) && Number.isFinite(updatedMs) && createdMs > updatedMs) {
    push('time-reversed', 'warning', `created_at（${created}）晚于 updated_at（${updated}）`, '改回正确顺序，否则「最近更新」排序会错');
  }

  // 敏感内容（2026-11-26 第 6 条）：记忆是明文 md，钥匙写进来就落盘了；只提示，不改。
  const sensitiveHits = scanSensitive(memory.core ?? memory.content ?? '');
  if (sensitiveHits.length) {
    push(
      'sensitive',
      'info',
      `正文里有像敏感信息的东西（${sensitiveHits.map((hit) => hit.label).join('、')}），明文落在盘上`,
      '建议存「在哪」而不是「值本身」（比如「key 在 .env 的 XXX」）',
    );
  }

  const dirName = relDirOf(memory);
  const expectedDir = TYPE_DIRS[memory.type];
  // Inbox 是 candidate 的暂存处，不该按类型目录要求它；其余目录放错才报。
  if (expectedDir && dirName && dirName !== 'Inbox' && dirName !== expectedDir.split('/').pop() && dirName !== expectedDir) {
    push('dir-mismatch', 'info', `放在「${dirName}/」但 type 是 ${memory.type}（标准位置是 ${expectedDir}/）`, '不影响读取；整理时可以挪到标准目录');
  }

  return problems;
}

/**
 * 全库结构体检。
 * @param {Array} memories loadMemories 的结果
 * @param {{ max?: number }} options
 */
export function lintMemories(memories, { max = 200, ignoredIds = null } = {}) {
  const skipped = ignoredIds instanceof Map ? ignoredIds : new Set(Array.isArray(ignoredIds) ? ignoredIds : []);
  // 「已忽略」的条目不再进单子：这是人明确说「别管它」的那几条。
  const list = (memories ?? []).filter((memory) => !skipped.has(String(memory.id)));
  const idCounts = new Map();
  for (const memory of list) {
    const rawId = String(memory.raw ?? '').match(/^---\r?\n[\s\S]*?^id:\s*(.+)$/m)?.[1]?.trim();
    if (rawId) idCounts.set(rawId, (idCounts.get(rawId) ?? 0) + 1);
  }

  const rows = [];
  for (const memory of list) {
    const problems = inspectMemory(memory, { idCounts });
    if (!problems.length) continue;
    const worst = problems.some((item) => item.level === 'error')
      ? 'error'
      : problems.some((item) => item.level === 'warning')
        ? 'warning'
        : 'info';
    rows.push({
      id: memory.id,
      title: memory.title,
      type: memory.type,
      status: memory.status,
      path: memory.path,
      level: worst,
      problems,
    });
  }

  const rank = { error: 0, warning: 1, info: 2 };
  rows.sort((a, b) => rank[a.level] - rank[b.level] || String(a.title).localeCompare(String(b.title)));

  const counts = { error: 0, warning: 0, info: 0 };
  const codes = {};
  for (const row of rows) {
    counts[row.level] += 1;
    for (const problem of row.problems) codes[problem.code] = (codes[problem.code] ?? 0) + 1;
  }

  return {
    scanned: list.length,
    flagged: rows.length,
    counts,
    codes,
    rows: rows.slice(0, Math.max(0, max)),
    truncated: rows.length > max,
  };
}

/** 从 vault 读一遍再体检。 */
export function lintVault(vaultPath, options = {}) {
  return lintMemories(loadMemories(vaultPath), options);
}
