/**
 * 从一段话里认出「明确的过期时间」。
 *
 * 只认带截止语义的写法：日期附近 40 字内有 截止 / 截至 / 到期 / 结束 / 过期 / 有效期 / 失效 / deadline / until / due。
 * 光有个日期（发布日、更新日、会话日期）不算——误标过期日比漏标更糟：条目会悄悄消失。
 *
 * 支持：
 *   2026-11-29 / 2026/11/29 / 2026年11月29日 / 2026.11.29
 *   11月29日 / 11月29号 / 11-29 / 11.29 / 11/29
 * 没有年份时，先看同一窗口里有没有 4 位年份，没有才补当年；补出来已经过去的，补明年（跨年的活动）。
 */
const DEADLINE_WORDS = /(截止|截至|到期|结束|过期|有效期|失效|deadline|until|due)/i;
const WINDOW = 40;

const pad = (value) => String(value).padStart(2, '0');

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isRealDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function nearby(text, index, length) {
  const from = Math.max(0, index - WINDOW);
  const to = Math.min(text.length, index + length + WINDOW);
  return text.slice(from, to);
}

/** 窗口里有 4 位年份就用它，否则补当年（已过去的补明年）。 */
function resolveYear(window, month, day, today) {
  const explicit = window.match(/(20\d{2})\s*[-/.年]/);
  if (explicit) return Number(explicit[1]);
  const current = today.getFullYear();
  return new Date(current, month - 1, day) < today ? current + 1 : current;
}

/**
 * 认出一个过期日；认不出返回 null。
 * 返回 { date: 'YYYY-MM-DD', matched: 原文里那段 }。
 */
export function detectExpiry(text, { now = new Date() } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const today = startOfDay(now);
  const hits = [];

  const collect = (regex, parse) => {
    for (const match of text.matchAll(regex)) {
      const window = nearby(text, match.index, match[0].length);
      if (!DEADLINE_WORDS.test(window)) continue;
      const date = parse(match, window);
      if (date) hits.push({ index: match.index, date, matched: match[0] });
    }
  };

  // 完整日期（带年）
  collect(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g, (match) => {
    const [, y, m, d] = match;
    if (!isRealDate(Number(y), Number(m), Number(d))) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  });

  // 月日（无年）
  collect(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g, (match, window) => {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (!isRealDate(today.getFullYear(), month, day)) return null;
    const year = resolveYear(window, month, day, today);
    return `${year}-${pad(month)}-${pad(day)}`;
  });

  // 11-29 / 11.29 / 11/29
  collect(/(?<![\d\-/.])(\d{1,2})\s*[-/.]\s*(\d{1,2})(?![\d\-.])/g, (match, window) => {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (!isRealDate(today.getFullYear(), month, day)) return null;
    const year = resolveYear(window, month, day, today);
    return `${year}-${pad(month)}-${pad(day)}`;
  });

  if (!hits.length) return null;

  // 多个候选时取最后出现的那个（「9-28 到 11-29 截止」里，结束日才是过期日）
  hits.sort((a, b) => a.index - b.index);
  const picked = hits[hits.length - 1];
  // 已经过去的日期不当过期日
  if (new Date(`${picked.date}T00:00:00`) < today) return null;
  return { date: picked.date, matched: picked.matched };
}
