/**
 * UI 快照：给 client 面板看的两个 JSON。
 *
 *   <vault>/.dsh-memory/last-inject.json —— 每轮 L1 渲染时现写，记录这轮带了什么
 *   <vault>/.dsh-memory/index.json       —— 全量索引，给「最近写入」用
 *
 * 这是 host 与 client 之间唯一的通信方式：文件，不走 IPC。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadMemories, vaultFingerprint } from './vault.js';
import { findMemory } from './search.js';
import { stamp, supersedeMemory } from './store.js';
import { localDateStamp } from './stream.js';

/** 按码点数字数，跟中文习惯一致。 */
export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}

export function stateDir(vaultPath) {
  return path.join(vaultPath, '.dsh-memory');
}

function ensureDir(vaultPath) {
  const dir = stateDir(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, payload) {
  // 先写临时文件再 rename：两个进程同时写索引时，读到的要么是旧版、要么是新版，不会是半截 JSON。
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** L0 快照：每条一行，带 core 字数。 */
export function l0Snapshot(selected) {
  return (selected ?? []).map((memory) => ({
    id: memory.id,
    type: memory.type,
    importance: memory.importance,
    title: memory.title,
    chars: charCount(memory.core),
  }));
}

/** L1 快照：多带 hits / score / matched（UI 要显示「命中：xx、yy」）。 */
export function l1Snapshot(rows) {
  return (rows ?? []).map((row) => ({
    id: row.memory.id,
    type: row.memory.type,
    title: row.memory.title,
    hits: row.hits,
    score: row.score,
    matched: (row.matched ?? []).slice(0, 6),
  }));
}

/** 写本轮注入快照。 */
export function writeInjection({ vaultPath, session = '', l0 = [], l1 = [], chars = {} }) {
  const dir = ensureDir(vaultPath);
  const payload = {
    at: new Date().toISOString(),
    session,
    l0,
    l1,
    chars: {
      l0: Number(chars.l0 ?? 0),
      l1: Number(chars.l1 ?? 0),
      budget: Number(chars.budget ?? 4000),
    },
  };
  writeJson(path.join(dir, 'last-inject.json'), payload);
  recordHits(dir, l1);
  return payload;
}

/**
 * 累计 L1 命中次数（memory_review 判断「注入了但没人读」用）。
 * 数据量很小：id → {hits, lastAt}，只增不减，删掉的记忆留着也不碍事。
 */
export function recordHits(dir, l1 = []) {
  const file = path.join(dir, 'hits.json');
  let stats = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stats = parsed;
    }
  } catch {
    stats = {};
  }
  const at = new Date().toISOString();
  for (const row of l1 ?? []) {
    if (!row?.id) continue;
    const prev = stats[row.id] ?? { hits: 0, lastAt: '' };
    stats[row.id] = { hits: Number(prev.hits ?? 0) + 1, lastAt: at };
  }
  writeJson(file, stats);
  return stats;
}

export function readHits(vaultPath) {
  const file = path.join(ensureDir(vaultPath), 'hits.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 全量索引。 */
export function writeIndex(vaultPath) {
  const dir = ensureDir(vaultPath);
  const entries = loadMemories(vaultPath).map((memory) => ({
    id: memory.id,
    type: memory.type,
    status: memory.status,
    title: memory.title,
    importance: memory.importance,
    pinned: memory.pinned,
    updated: memory.updated,
    tags: memory.tags,
    path: memory.path,
    chars: charCount(memory.core),
    evidence: memory.evidence ?? '',
    expires: memory.expires ?? '',
    reads: memory.reads ?? 0,
  }));
  const payload = { at: new Date().toISOString(), entries };
  writeJson(path.join(dir, 'index.json'), payload);
  INDEX_FINGERPRINTS.set(vaultPath, indexFingerprint(vaultPath));
  return payload;
}

/** 上次重建索引时的 vault 指纹，用来跳过没必要的重写。 */
const INDEX_FINGERPRINTS = new Map();

/**
 * 只在 vault 内容变了（或索引还没建/被删）时重建索引。
 * 面板每次刷新都会打 GET /state，没必要每次都扫盘重写 7ms 的索引。
 */
// 索引指纹要带上「生成规则版本」：只改 schema/id 派生逻辑、不动 md 时，mtime 指纹不会变。
export const INDEX_SCHEMA_VERSION = 2;

function indexFingerprint(vaultPath) {
  return `v${INDEX_SCHEMA_VERSION}:${vaultFingerprint(vaultPath)}`;
}

export function writeIndexIfChanged(vaultPath) {
  const indexPath = path.join(stateDir(vaultPath), 'index.json');
  if (INDEX_FINGERPRINTS.get(vaultPath) === indexFingerprint(vaultPath) && fs.existsSync(indexPath)) return false;
  writeIndex(vaultPath);
  return true;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 读两份快照（可能都还不存在）。 */
/**
 * 今天的流水（给面板「今天流水」块）：读 <vault>/Daily/<date>.md，只留最近 limit 条。
 * 流水不进索引，这里现读文件，不缓存。
 */
export function readTodayStream(vaultPath, { date, limit = 5 } = {}) {
  const day = date ?? localDateStamp();
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 5;
  const target = path.join(vaultPath, 'Daily', `${day}.md`);
  try {
    const text = fs.readFileSync(target, 'utf8');
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.match(/^- (\d{2}:\d{2})\s+(?:\[([^\]]{1,24})\]\s*)?(.+)$/))
      .filter(Boolean)
      .map((match) => ({ time: match[1], by: (match[2] || '家里').trim(), text: match[3].trim() }))
      .filter((line) => line.text);
    return { date: day, lines: count === 0 ? [] : lines.slice(-count) };
  } catch {
    return { date: day, lines: [] };
  }
}

export function readState(vaultPath) {
  const dir = stateDir(vaultPath);
  return {
    lastInject: readJson(path.join(dir, 'last-inject.json')),
    index: readJson(path.join(dir, 'index.json')),
    today: readTodayStream(vaultPath),
    vault: vaultPath,
  };
}

/** 按 id 取一条记忆全文（含 raw）。 */
export function readMemoryText(vaultPath, id) {
  const memory = findMemory(loadMemories(vaultPath), id);
  if (!memory) return null;
  // 详情页给人看的正文：去 frontmatter，再去掉机械的「## 核心内容」标题（改文件时还在）。
  const bodyOnly = String(memory.raw ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const text = bodyOnly.replace(/^##\s*核心内容\s*$/m, '').replace(/^\s*\n/, '').trim();
  return {
    id: memory.id,
    type: memory.type,
    status: memory.status,
    title: memory.title,
    importance: memory.importance,
    pinned: memory.pinned,
    evidence: memory.evidence ?? '',
    expires: memory.expires ?? '',
    reads: Number(memory.reads) || 0,
    updated: memory.updated,
    tags: memory.tags,
    path: memory.path,
    text,
    raw: memory.raw,
  };
}

/** 标为 superseded（只改 frontmatter），然后刷新索引。 */
export function markSuperseded(vaultPath, id, { now = new Date() } = {}) {
  const memory = findMemory(loadMemories(vaultPath), id);
  if (!memory) return { ok: false, message: `没找到 ${id}` };

  const result = supersedeMemory(memory.path, '', { now });
  if (!result.ok) return result;

  writeIndex(vaultPath);
  return { ok: true, id: memory.id, path: memory.path, updated_at: stamp(now) };
}
