/**
 * 收盘归拢：把一天的流水收成几行「有主语的完整句子」，写进 Daily/YYYY-MM-DD.summary.md。
 *
 * 边界（主人 2026-11-22 定，2026-11-23 补强）：
 *   - 只归拢流水，不自动改长期记忆；配得上长期的写成 Inbox/ 候选（status: candidate）；
 *   - 同一天跑两次不能写两遍：直接覆盖同名 summary 文件（幂等）；
 *   - 归拢失败不要静默：在当天流水文件末尾留一行「收盘没跑成，原因：X」。
 *   - 句子完整性校验：3–6 句、每条以 。！？ 结尾、单条 ≤80 字；半句不落盘。
 *   - 写盘走 tmp + rename（原子替换），并套 .dsh-memory/lock 文件锁。
 *
 * 句子本身由模型写（插件不调模型），这里只管读流水、写摘要、记失败。
 */
import fs from 'node:fs';
import path from 'node:path';

import { localDateStamp, streamFile } from './stream.js';
import { tryLock } from './lock.js';
import { backupFile } from './store.js';

const MIN_SENTENCES = 3;
const MAX_SENTENCES = 6;
const MAX_SENTENCE_CHARS = 80;

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function summaryPathOf(vaultPath, date) {
  return path.join(vaultPath, 'Daily', `${date}.summary.md`);
}

function isRealDate(stamp) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(stamp ?? ''))) return false;
  const [year, month, day] = String(stamp).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 读某天的流水：返回原文与逐行清单（- HH:mm 开头的行）。 */
export function readDaily(vaultPath, date = localDateStamp()) {
  if (!isRealDate(date)) return { ok: false, message: `date 要 YYYY-MM-DD 且是真实日期，收到：${date}` };
  const target = streamFile(vaultPath, { kind: 'daily', date });
  if (!target.ok) return target;
  let text = '';
  try {
    text = fs.existsSync(target.path) ? fs.readFileSync(target.path, 'utf8') : '';
  } catch (error) {
    return { ok: false, message: `读流水失败：${error?.message ?? String(error)}` };
  }
  const items = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line) => {
      const match = /^- (\d{2}:\d{2})\s+(?:\[([^\]]{1,24})\]\s*)?(.+)$/.exec(line);
      if (!match) return null;
      // 没标来源的行按「家里」算（兼容旧行）；标记只认短方括号，别把正文吃掉。
      // 来源不设白名单（家里/工作/记忆插件/room插件/以后新会话都行），只限方括号内长度。
      return { line, time: match[1], by: (match[2] || '家里').trim(), text: match[3].trim() };
    })
    .filter((item) => item && item.text);
  const lines = items.map((item) => item.line);
  const summaryPath = summaryPathOf(vaultPath, date);
  let previous = '';
  try {
    if (fs.existsSync(summaryPath)) previous = fs.readFileSync(summaryPath, 'utf8');
  } catch {
    previous = '';
  }
  if (!text && !previous) return { ok: false, message: `这一天还没有流水，也没有收盘：${target.path}` };
  return { ok: true, date, path: target.path, text, lines, items, summaryPath, previous };
}

/**
 * 句子完整性校验（主人 2026-11-23 要求）：
 * 3–6 条、每条以 。！？ 结尾、单条 ≤80 字。半句、超长句一律不落盘。
 */
export function validateSentences(sentences, { min = MIN_SENTENCES, max = MAX_SENTENCES, maxChars = MAX_SENTENCE_CHARS } = {}) {
  if (!Array.isArray(sentences)) return { ok: false, reason: 'sentences 要是字符串数组' };
  const clean = sentences.map(oneLine).filter(Boolean);
  if (clean.length < min) return { ok: false, reason: `只有 ${clean.length} 句，要 ${min}–${max} 句` };
  if (clean.length > max) return { ok: false, reason: `有 ${clean.length} 句，要 ${min}–${max} 句` };
  for (const [index, line] of clean.entries()) {
    if (!/[。！？]$/.test(line)) {
      return { ok: false, reason: `第 ${index + 1} 句没有以 。！？ 结尾：${line.slice(0, 30)}` };
    }
    const length = [...line].length;
    if (length > maxChars) {
      return { ok: false, reason: `第 ${index + 1} 句有 ${length} 字，超过 ${maxChars} 字` };
    }
  }
  return { ok: true, count: clean.length };
}

/** 失败留痕：往当天流水末尾追加一行，别再静默。 */
export function noteFailure(vaultPath, date, reason) {
  try {
    const target = streamFile(vaultPath, { kind: 'daily', date });
    if (!target.ok) return false;
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    const stamp = localDateStamp() === date ? new Date() : new Date(`${date}T23:59:00`);
    const hour = String(stamp.getHours()).padStart(2, '0');
    const minute = String(stamp.getMinutes()).padStart(2, '0');
    fs.appendFileSync(target.path, `- ${hour}:${minute} [插件] 收盘没跑成，原因：${oneLine(reason)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 写收盘摘要（覆盖同名文件，幂等；tmp + rename 原子替换）。
 * sentences 是模型/人写完的 3–6 句完整句子；这里先校验完整性，再落盘。
 */
export function writeSummary(vaultPath, { date = localDateStamp(), sentences = [], at = new Date() } = {}) {
  if (!isRealDate(date)) return { ok: false, message: `date 要 YYYY-MM-DD 且是真实日期，收到：${date}` };
  if (!Array.isArray(sentences)) return { ok: false, message: 'sentences 要是字符串数组（每项一句完整句子）' };
  const clean = sentences
    .map((sentence) => oneLine(String(sentence).replace(/^\s*\[[^\]]{1,24}\]\s*/, '')))
    .filter(Boolean);
  if (!clean.length) {
    return { ok: false, message: '没有任何句子可写；要么给 3–6 句，要么先读流水再写' };
  }
  const shape = validateSentences(clean);
  if (!shape.ok) return { ok: false, date, message: `收盘句子不合格：${shape.reason}` };

  const target = summaryPathOf(vaultPath, date);
  const heading = `# ${date} 收盘`;
  const body = [`${heading}`, '', ...clean.map((line) => `- ${line}`), '', ''].join('\n');

  const outcome = tryLock(vaultPath, () => {
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // 覆盖已有的收盘摘要之前先备份：同一天重跑时还能看到上一版。
      if (fs.existsSync(target)) backupFile(target, vaultPath);
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, target);
      return { ok: true, date, path: target, count: clean.length, at: at.toISOString() };
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 临时文件可能根本没建出来
      }
      const reason = error?.message ?? String(error);
      const noted = noteFailure(vaultPath, date, `写摘要失败：${reason}`);
      return {
        ok: false,
        date,
        message: `写收盘摘要失败：${reason}${noted ? '（已在当天流水里留了一行）' : '（失败留痕也没写成）'}`,
      };
    }
  });
  if (outcome?.locked) return { ok: false, date, message: outcome.message };
  return outcome;
}

export { summaryPathOf, isRealDate, MIN_SENTENCES, MAX_SENTENCES, MAX_SENTENCE_CHARS };
