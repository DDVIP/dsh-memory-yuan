/**
 * 流水（append-only）：一天/一个项目一个文件，往后接，不建 id、不进 index、不参与 L1。
 *
 * - Daily/YYYY-MM-DD.md：一条一行 `- HH:mm 内容`
 * - Projects/<项目名>.md：同上
 *
 * 为什么单开一层：那是「今天干了什么」「这个项目到哪了」的时间线，
 * 用「一条一个 md」的条目去存会碎成一地；也不能进 L1，否则流水会挤占线索。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { tryLock } from './lock.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STREAM_KINDS = new Set(['daily', 'project']);

/** 格式对不代表日期真：2026-13-45、2026-02-30 都要拒（自测 7 发现）。 */
export function isRealDate(stamp) {
  if (!DATE_RE.test(stamp)) return false;
  const [year, month, day] = stamp.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(year, month - 1, day);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/** 本地日期 YYYY-MM-DD（不是 UTC，流水按本机作息算）。 */
export function localDateStamp(at = new Date()) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 本地时间 HH:mm。 */
export function localTimeStamp(at = new Date()) {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** 项目名当文件名用：去掉 Windows 非法字符、压空白、限长。 */
export function safeProjectName(name) {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 算流水文件路径（不落盘）。 */
export function streamFile(vaultPath, { kind, date, project } = {}) {
  if (!vaultPath) return { ok: false, message: '缺少 vaultPath' };
  if (!STREAM_KINDS.has(kind)) return { ok: false, message: `kind 只能是 daily 或 project，收到：${kind ?? '(空)'}` };
  if (kind === 'daily') {
    const stamp = date ?? localDateStamp();
    if (!isRealDate(stamp)) return { ok: false, message: `date 要 YYYY-MM-DD 且是真实日期，收到：${stamp}` };
    return { ok: true, path: join(vaultPath, 'Daily', `${stamp}.md`), kind, date: stamp };
  }
  const name = safeProjectName(project);
  if (!name) return { ok: false, message: '写项目流水要带 project（项目名）' };
  return { ok: true, path: join(vaultPath, 'Projects', `${name}.md`), kind, project: name };
}

/**
 * 追加一行流水。
 * 文件不存在就先写标题；同一天/同一项目多次调用就是往后接。
 */
export function appendStream({ vaultPath, kind, content, date, project, by, at = new Date() } = {}) {
  const text = String(content ?? '').replace(/\r?\n+/g, ' ').trim();
  if (!text) return { ok: false, message: 'content 不能为空' };
  // 日期要跟着 at 走：补记昨天的事时 at 传昨天，文件也必须落昨天。
  const target = streamFile(vaultPath, { kind, date: date ?? localDateStamp(at), project });
  if (!target.ok) return target;

  const outcome = tryLock(vaultPath, () => {
    try {
      mkdirSync(dirname(target.path), { recursive: true });
      if (!existsSync(target.path)) {
        const heading = kind === 'daily' ? `# ${target.date} 流水` : `# 项目流水：${target.project}`;
        writeFileSync(target.path, `${heading}\n\n`, 'utf8');
      }
      // 来源标记不设白名单：家里 / 工作 / 记忆插件 / room插件 / 以后新开的会话都行。
      // 只限制长度（markdown 里方括号不能跨行、别把整段话塞进去）。
      const source = typeof by === 'string' ? by.trim().replace(/[[\]]/g, '').slice(0, 24) : '';
      const mark = source ? `[${source}] ` : '';
      const line = `- ${localTimeStamp(at)} ${mark}${text}`;
      appendFileSync(target.path, `${line}\n`, 'utf8');
      return {
        ok: true,
        kind,
        path: target.path,
        line,
        ...(target.date ? { date: target.date } : {}),
        ...(target.project ? { project: target.project } : {}),
      };
    } catch (error) {
      return { ok: false, message: `写流水失败：${error?.message ?? String(error)}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/** 读整篇流水（按天或按项目）；不存在时 ok:false。 */
export function readStream(vaultPath, { kind, date, project } = {}) {
  const target = streamFile(vaultPath, { kind, date, project });
  if (!target.ok) return target;
  try {
    if (!existsSync(target.path)) return { ok: false, message: `还没有：${target.path}` };
    return { ok: true, kind, path: target.path, text: readFileSync(target.path, 'utf8') };
  } catch (error) {
    return { ok: false, message: `读流水失败：${error?.message ?? String(error)}` };
  }
}

/**
 * 判断一个 vault 内的相对路径是不是流水文件。
 * loadMemories 用它跳过：流水不是「一条一个 md」的记忆条目，不该进检索与索引。
 */
export function isStreamFile(relativePath) {
  const rel = String(relativePath ?? '').replace(/\\/g, '/');
  if (rel.startsWith('Daily/')) return true;
  // Projects/ 下直接放的 .md 是流水；Projects/State/ 里的仍然是记忆条目。
  return /^Projects\/[^/]+\.md$/.test(rel);
}
