/**
 * 读 vault：一个 Markdown 一条记忆，frontmatter 是极简 YAML。
 *
 * 只做读，不做写 —— 写入在 store.js。
 * 目录结构（memory-evolve 留下的习惯，不强制）：
 *   Preferences/ Decisions/ Experiences/ Knowledge/ Projects/ Profile/
 *   Index/ Attachments/ Archive/ 不读（索引、附件、归档）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { isStreamFile } from './stream.js';

export const DEFAULT_VAULT = path.join(os.homedir(), '.dsh', 'worlds', 'default', 'memory');

/** 不进上下文的目录（索引、附件、归档、编辑器配置）。 */
const IGNORED_DIRS = new Set(['Index', 'Attachments', 'Archive', '.obsidian', '.git', '.dsh-memory']);

/** 不是记忆的 Markdown。 */
const IGNORED_FILES = new Set(['README.md', 'Memory Home.md']);

/** 核心内容段的候选标题，按顺序认。 */
const CORE_HEADINGS = ['核心内容', '内容', '一句话', '摘要', '要点'];

/** 把一个 frontmatter 标量转成 JS 值（双引号串按 JSON 规则还原转义）。 */
function coerceScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    // 写入侧用 JSON.stringify 兜住引号/反斜杠/换行，这里必须按 JSON 还原，否则读回会多出转义符。
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    // YAML 单引号串里 '' 表示一个单引号（写入侧对含引号的值会走 JSON 双引号，这里只是兼容手写文件）。
    return text.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  }
  return text;
}

/** 解析 `[a, "b, c"]` 这种 flow 序列：逗号只在引号外切。 */
function parseFlowList(inner) {
  const parts = [];
  let buffer = '';
  let quote = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      buffer += ch;
      if (ch === '\\' && i + 1 < inner.length) {
        buffer += inner[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  parts.push(buffer);
  return parts
    .map((part) => coerceScalar(part))
    .filter((item) => item !== '' || typeof item === 'number');
}

/** 把一个 frontmatter 值转成 JS 值。 */
function coerce(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.startsWith('[') && text.endsWith(']')) return parseFlowList(text.slice(1, -1));
  return coerceScalar(text);
}

/**
 * 拆 frontmatter 与正文。不是以 --- 开头的文件，整体当正文。
 * 支持 `key: value` 与 `key:\n  - a\n  - b` 两种。
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return { data: {}, body: source };

  const end = source.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: source };

  const head = source.slice(3, end);
  const body = source.slice(end + 4).replace(/^\r?\n/, '');

  const data = {};
  let pendingKey = null;
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && pendingKey) {
      if (!Array.isArray(data[pendingKey])) data[pendingKey] = [];
      data[pendingKey].push(coerce(listMatch[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (value === '') {
      data[key] = [];
      pendingKey = key;
    } else {
      data[key] = coerce(value);
      pendingKey = null;
    }
  }

  return { data, body };
}

/** 取某个 `## 标题` 下的段落；找不到返回 ''。 */
export function sectionOf(body, headings) {
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const heading = lines[i].match(/^#{1,4}\s+(.+?)\s*$/);
    if (!heading || !headings.includes(heading[1])) continue;

    const collected = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,4}\s+/.test(lines[j])) break;
      collected.push(lines[j]);
    }
    const section = collected.join('\n').trim();
    if (section) return section;
  }
  return '';
}

/** 正文第一段（跳过标题行）。 */
function firstParagraph(body) {
  const text = String(body ?? '').trim();
  if (!text) return '';
  const chunks = text.split(/\n\s*\n/);
  for (const chunk of chunks) {
    const cleaned = chunk
      .split(/\r?\n/)
      .filter((line) => !/^#{1,4}\s+/.test(line))
      .join('\n')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

/** 正文里第一个一级标题，用作 title 兜底。 */
function firstHeading(body) {
  const match = String(body ?? '').match(/^#\s+(.+?)\s*$/m);
  return match ? match[1] : '';
}

/** title 与 core 都压成单行，避免把多行结构带进注入段。 */
export function flatten(text) {
  return String(text ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

/** 记忆状态四态；旧文件里的 active 一律视作 verified（不让旧库掉出 L0）。 */
export const MEMORY_STATUSES = ['candidate', 'verified', 'disputed', 'superseded'];

export function normalizeStatus(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'active') return 'verified';
  if (MEMORY_STATUSES.includes(raw)) return raw;
  return 'candidate';
}

/** 无 id 文件按相对路径派生稳定 id（sha1 前 8 位）。 */
function derivedId(fullPath, vaultPath, fallbackName) {
  try {
    const rel = path.relative(vaultPath, fullPath).replace(/\\/g, '/');
    return `mem_derived_${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 8)}`;
  } catch {
    return `mem_derived_${String(fallbackName).slice(0, 16)}`;
  }
}

/** 读一个记忆文件，形状固定。 */
export function readMemoryFile(fullPath, vaultPath = DEFAULT_VAULT) {
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const fallbackName = path.basename(fullPath, path.extname(fullPath));

    return {
      // 没写 id 的文件（手写、别的工具生成的）也要能点开：按相对路径派生稳定 id。
      // 不用文件名——两个目录里都叫 Persona.md 时，文件名派生的 id 会在 findMemory 里撞车。
      id: typeof data.id === 'string' && data.id ? data.id : derivedId(fullPath, vaultPath, fallbackName),
      title: flatten(data.title || firstHeading(body) || fallbackName),
      type: typeof data.type === 'string' && data.type ? data.type : 'knowledge',
      // 四态 canon（旧文件里的 active 视作 verified）；disputed / superseded 不再进 L0/L1。
      status: normalizeStatus(data.status),
      tags: toStringArray(data.tags),
      importance: Number.isFinite(Number(data.importance)) ? Number(data.importance) : 0,
      pinned: data.pinned === true,
      confidence: Number.isFinite(Number(data.confidence)) ? Number(data.confidence) : 0,
      evidence: typeof data.evidence === 'string' ? data.evidence.trim() : '',
      expires: typeof data.expires === 'string' ? data.expires.trim() : '',
      reads: Number.isFinite(Number(data.reads)) ? Math.max(0, Math.floor(Number(data.reads))) : 0,
      updated: typeof data.updated_at === 'string' ? data.updated_at : typeof data.updated === 'string' ? data.updated : '',
      // 出处回溯要用「写下来的时间」划边界：这之后说的话不可能是它的来源。
      createdAt: typeof data.created_at === 'string' ? data.created_at : typeof data.createdAt === 'string' ? data.createdAt : '',
      path: fullPath,
      dir: path.dirname(fullPath),
      vault: vaultPath,
      core: flatten(sectionOf(body, CORE_HEADINGS) || firstParagraph(body)),
      body,
      raw,
    };
  } catch (error) {
    console.warn('[memory-yuan] 读取失败：', fullPath, error?.message ?? error);
    return null;
  }
}

/** 递归列出 vault 里的记忆文件（不读内容、不解析）。 */
function listMemoryFiles(vaultPath) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      console.warn('[memory-yuan] 目录读不了：', dir, error?.message ?? error);
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (IGNORED_FILES.has(entry.name)) continue;
      if (isStreamFile(path.relative(vaultPath, full))) continue;
      files.push(full);
    }
  };
  if (!vaultPath || !fs.existsSync(vaultPath)) return files;
  walk(vaultPath);
  return files;
}

/**
 * 文件指纹：路径 + mtime + 大小。
 * 任何一条被改、增、删都会变；只读它比读内容便宜得多。
 */
function fingerprintOf(files) {
  const parts = new Array(files.length);
  for (let i = 0; i < files.length; i += 1) {
    const full = files[i];
    try {
      const stat = fs.statSync(full);
      parts[i] = `${full}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      parts[i] = `${full}:missing`;
    }
  }
  return parts.join('|');
}

/** 内容指纹（给「索引要不要重建」这类判断用）。 */
export function vaultFingerprint(vaultPath = DEFAULT_VAULT) {
  if (!vaultPath || !fs.existsSync(vaultPath)) return '';
  return fingerprintOf(listMemoryFiles(vaultPath));
}

/** 解析结果的缓存：vault 目录 → {fingerprint, memories}。指纹没变就不重读。 */
const MEMORY_CACHE = new Map();
const MEMORY_CACHE_MAX_FILES = 5000;

/**
 * 递归读整个 vault，按 importance 倒序。
 * vault 不存在时返回空数组，不炸。
 * 文件没变时直接给上次的解析结果（每轮 L0/L1 各调一次，省掉重复扫盘与解析）。
 */
export function loadMemories(vaultPath = DEFAULT_VAULT) {
  if (!vaultPath || !fs.existsSync(vaultPath)) return [];

  const files = listMemoryFiles(vaultPath);
  const fingerprint = fingerprintOf(files);
  const cached = MEMORY_CACHE.get(vaultPath);
  if (cached && cached.fingerprint === fingerprint) return cached.memories;

  const out = [];
  for (const full of files) {
    const memory = readMemoryFile(full, vaultPath);
    if (memory) out.push(memory);
  }
  out.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return String(b.updated).localeCompare(String(a.updated));
  });

  // 库特别大时不缓存，宁可变慢也别占内存。
  if (files.length <= MEMORY_CACHE_MAX_FILES) MEMORY_CACHE.set(vaultPath, { fingerprint, memories: out });
  return out;
}
