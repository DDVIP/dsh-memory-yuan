import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { grams } from './l1.js';

/**
 * 出处回溯：从 DSH 的会话存档里找「这条记忆是哪次对话说的」。
 *
 * 存档在 ~/.dsh/sessions/<cwd-slug>/session-<uuid>/session.v4.jsonl.zstd。
 * 文件不是单个 zstd 流，而是「每批事件一帧」的**帧拼接**：按魔数切开逐帧解压
 * （直接 zstdDecompressSync 整文件只会得到第一帧，流式解压到第二帧会报
 * "Unknown frame descriptor"）。每帧里可能有多行 JSON，按行拆。
 *
 * 这一步只读、不改任何东西；它算的是「候选出处」，由人确认后写进 evidence。
 */

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MIN_HITS = 2;
const MAX_QUOTE_CHARS = 160;
const MAX_FILES = 60;

export function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions');
}

/** 按 zstd 魔数切帧的起点。 */
export function frameStarts(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (
      buffer[i] === ZSTD_MAGIC[0] &&
      buffer[i + 1] === ZSTD_MAGIC[1] &&
      buffer[i + 2] === ZSTD_MAGIC[2] &&
      buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  return starts;
}

/** 列出所有会话文件，按最近修改倒序。 */
export function listSessionFiles(root = sessionsRoot()) {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return out;
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const session of sessions) {
      const file = path.join(projectDir, session.name, 'session.v4.jsonl.zstd');
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      out.push({ file, project: project.name, sessionId: session.name, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 逐帧解压一个会话文件，按行 yield 事件对象。 */
export function* readEvents(filePath) {
  const buffer = fs.readFileSync(filePath);
  const starts = frameStarts(buffer);
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buffer.length;
    let text = '';
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(from, to)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // 半截行/非 JSON：跳过，不让一行坏掉整份存档
      }
    }
  }
}

/** 一条事件里用户真正说的话（注入的 system-reminder / runtime-context 等不算）。 */
export function userTexts(event) {
  if (!event || event.type !== 'user/message') return [];
  const content = event?.data?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter((text) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      // '<' 开头的是 system-reminder 一类；另外几个是宿主/插件的注入块
      // （runtime-context、压缩摘要、探针），它们不是用户说的话，不该算出处。
      if (trimmed.startsWith('<')) return false;
      if (/^(Current runtime context|PROBE STANDING|\[Compressed conversation section\]|DEBUG-CONTEXT|This complete catalog)/.test(trimmed)) return false;
      if (trimmed.includes('【我写过的认识】')) return false;
      // 压缩摘要不是人说的话：它把所有关键词都抄了一遍，任何记忆都会被它「命中」。
      if (/^(【上下文压缩摘要】|【历史压缩摘要】|\[上下文压缩摘要\])/.test(trimmed)) return false;
      // 定时任务注入（reminders_json）与渊自己写的生活流水（【我的时间】）也不是「主人说的原话」。
      if (/^(\[SCHEDULE REMINDER|\[reminder|【我的时间】)/.test(trimmed)) return false;
      if (trimmed.includes('reminders_json')) return false;
      return true;
    });
}

/** 从标题里取线索词：中文 2–4 字片段 + 英文词，去停用词。 */
export function keywordsOf(title) {
  const raw = String(title ?? '');
  const set = new Set();
  for (const gram of grams(raw, [2, 3, 4])) set.add(gram);
  for (const word of raw.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) set.add(word);
  return [...set].slice(0, 24);
}

/** 在一句话里数命中了几个线索词，并给命中的词。 */
export function matchScore(text, keywords) {
  const lower = String(text ?? '').toLowerCase();
  const hits = keywords.filter((keyword) => lower.includes(keyword));
  return { hits: hits.length, keywords: hits };
}

/**
 * 泛词 = 在很多条记忆标题里都出现的词（记忆、插件、写入…）。
 * 这种词谁都能对上，不能拿它当「就是这条的出处」的证据。
 */
export function genericKeywords(memories, keywords) {
  if (!Array.isArray(memories) || !memories.length) return new Set();
  const df = new Map();
  for (const memory of memories) {
    const seen = new Set(grams(String(memory?.title ?? ''), [2, 3, 4]));
    for (const key of seen) df.set(key, (df.get(key) ?? 0) + 1);
  }
  const limit = Math.max(8, Math.floor(memories.length * 0.15));
  return new Set(keywords.filter((keyword) => (df.get(keyword) ?? 0) > limit));
}

/**
 * 找候选出处：扫最近的会话存档，挑「用户说过的话里命中 ≥2 个线索词」的。
 * - createdAt 给了就只认「这条记忆写下来之前」说的话（之后的对话是结果不是来源）；
 * - 泛词不计入特征；长句命中多词会被句长压一下；
 * - 返回按 rank、时间倒序排好的前 maxResults 条，带 rank 方便调用方排序。
 */
export function findEvidence(
  { title, createdAt, memories = [] } = {},
  { root = sessionsRoot(), maxResults = 5, maxFiles = MAX_FILES, now = Date.now() } = {},
) {
  const keywords = keywordsOf(title);
  if (keywords.length < MIN_HITS) return [];
  const generic = genericKeywords(memories, keywords);
  const createdAtMs = createdAt ? Date.parse(createdAt) : 0;
  const files = listSessionFiles(root).slice(0, maxFiles);
  const candidates = [];
  for (const meta of files) {
    for (const event of readEvents(meta.file)) {
      const at = new Date(Number(event.time) || now).toISOString();
      if (createdAtMs && Date.parse(at) > createdAtMs + 10 * 60_000) continue;
      for (const text of userTexts(event)) {
        if (text.length < 8) continue;
        const score = matchScore(text, keywords);
        if (score.hits < MIN_HITS) continue;
        const specific = score.keywords.filter((keyword) => !generic.has(keyword));
        if (!specific.length) continue;
        let rank = specific.length + Math.min(1.5, specific.length / Math.max(20, text.length / 40));
        if (createdAtMs) {
          const gapHours = (createdAtMs - Date.parse(at)) / 36e5;
          if (gapHours >= 0 && gapHours <= 12) rank += 1;
          else if (gapHours > 12 && gapHours <= 48) rank += 0.5;
        }
        candidates.push({
          sessionId: meta.sessionId,
          project: meta.project,
          at,
          rank: Math.round(rank * 100) / 100,
          hits: score.hits,
          specific: specific.slice(0, 4),
          keywords: score.keywords.slice(0, 3),
          quote: text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE_CHARS),
        });
      }
    }
  }
  candidates.sort((a, b) => b.rank - a.rank || b.hits - a.hits || (a.at < b.at ? 1 : -1));
  return candidates.slice(0, maxResults);
}
