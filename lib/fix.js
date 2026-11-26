// 结构体检的「修」：只修文件本身写得不对的地方，不动内容。
//
// 能自动修的是「有唯一正确做法」的那些：
//   - dir-mismatch：type 有标准位置，挪过去就行（挪之前备份，重名加后缀）
//   - no-frontmatter / no-id / no-tags / empty-title / long-title：补一段 frontmatter 或补该有的行
//   - bad-status / bad-importance / tag-is-type / dup-tag / time-reversed：改成合法值
//
// 不能自动修的是内容问题：dup-id（要人决定留哪条）、empty-core / short-core（要人写）。
// 这些在 fixProblem 里直接返回 ok:false 并说明原因，UI 也不给「修」按钮。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { TYPE_DIRS, backupFile } from './store.js';
import { loadMemories, MEMORY_STATUSES } from './vault.js';

export const FIXABLE_CODES = new Set([
  'dir-mismatch',
  'no-frontmatter',
  'no-id',
  'no-tags',
  'empty-title',
  'long-title',
  'bad-status',
  'bad-importance',
  'tag-is-type',
  'dup-tag',
  'time-reversed',
]);

const TITLE_MAX_CHARS = 120;

function nowStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(
    now.getMinutes(),
  )}:${pad(now.getSeconds())}`;
}

function sha1(text) {
  // node:crypto 在这里只用来派生稳定 id，和 vault.js 的派生规则保持一致。
  return createHash('sha1').update(text).digest('hex');
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function yamlItem(value) {
  const text = String(value ?? '');
  return /^[^\s,:#"'\\[\]{}]+$/.test(text) ? text : JSON.stringify(text);
}

function yamlList(values) {
  const list = Array.isArray(values) ? values.map(yamlItem) : [];
  return `[${list.join(', ')}]`;
}

/** 改（或补）frontmatter 里的一行；没有 frontmatter 就整体补一段。 */
function setLine(raw, key, value) {
  const text = String(raw ?? '');
  if (!/^---\r?\n/.test(text)) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  const head = text.slice(0, end);
  const tail = text.slice(end);
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  const next = re.test(head) ? head.replace(re, line) : `${head}\n${line}`;
  return next + tail;
}

function dropLine(raw, key) {
  return String(raw ?? '').replace(new RegExp(`^${key}:.*\\r?\\n?`, 'm'), '');
}

/** 目录名猜类型：标准目录用反向表，非标准目录一律 knowledge（旧文档）。 */
function guessTypeByDir(dirName, rawType) {
  if (rawType && TYPE_DIRS[rawType]) return rawType;
  const entry = Object.entries(TYPE_DIRS).find(([, dir]) => dir === dirName);
  if (entry) return entry[0];
  return 'knowledge';
}

/** 标题取正文第一行（去掉 # 与结尾冒号），没有就用文件名。 */
function guessTitle(memory) {
  const body = String(memory.body ?? '');
  const first = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('##'));
  const cleaned = first ? first.replace(/^#+\s*/, '').replace(/[:：]\s*$/, '') : '';
  if (cleaned) return oneLine(cleaned).slice(0, TITLE_MAX_CHARS);
  const base = path.basename(memory.path, '.md').replace(/-mem_[a-z0-9_]+\.md$/i, '');
  return oneLine(base).slice(0, TITLE_MAX_CHARS) || '未命名';
}

function cleanTags(memory) {
  const type = String(memory.type ?? '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const tag of Array.isArray(memory.tags) ? memory.tags : []) {
    const text = oneLine(tag);
    if (!text) continue;
    const lower = text.toLowerCase();
    if (lower === type || seen.has(lower)) continue;
    seen.add(lower);
    out.push(text);
  }
  return out;
}

function writeAtomic(filePath, text, vaultPath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      backupFile(filePath, vaultPath);
    } catch {
      /* 备份失败不拦修复：修复本身是 tmp+rename，最坏是丢一份备份 */
    }
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 修一条结构问题。
 * @returns {{ok:boolean, id?:string, code?:string, action?:string, path?:string, message?:string}}
 */
export function fixProblem(vaultPath, { id, code } = {}, { now = new Date() } = {}) {
  const wanted = String(id ?? '').trim();
  const which = String(code ?? '').trim();
  if (!wanted) return { ok: false, message: '要给 id' };
  if (!which) return { ok: false, message: '要给 code（哪一类结构问题）' };
  if (!FIXABLE_CODES.has(which)) {
    return { ok: false, code: which, message: '这一类问题得人来看（内容问题不能自动改）' };
  }

  const memory = loadMemories(vaultPath).find((item) => String(item.id) === wanted);
  if (!memory) return { ok: false, id: wanted, code: which, message: `找不到这条记忆：${wanted}` };

  const filePath = memory.path;
  let raw = fs.readFileSync(filePath, 'utf8');
  const stamp = nowStamp(now);

  try {
    switch (which) {
      case 'dir-mismatch': {
        const targetDir = TYPE_DIRS[memory.type] ?? 'Inbox';
        const targetFile = path.join(vaultPath, targetDir, path.basename(filePath));
        if (path.resolve(targetFile) === path.resolve(filePath)) {
          return { ok: true, id: wanted, code: which, action: '已经在标准目录里', path: filePath };
        }
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        let finalFile = targetFile;
        if (fs.existsSync(finalFile)) {
          finalFile = targetFile.replace(/\.md$/i, `.${Date.now()}.md`);
        }
        try {
          backupFile(filePath, vaultPath);
        } catch {
          /* 同上 */
        }
        fs.renameSync(filePath, finalFile);
        return { ok: true, id: wanted, code: which, action: `挪到 ${targetDir}/`, path: finalFile };
      }

      case 'no-frontmatter': {
        const rel = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        const dirName = path.basename(path.dirname(filePath));
        const type = guessTypeByDir(dirName, memory.type);
        const title = guessTitle(memory);
        const head = [
          '---',
          `id: ${memory.id || `mem_derived_${sha1(rel).slice(0, 8)}`}`,
          `type: ${type}`,
          'status: candidate',
          `title: ${yamlItem(title)}`,
          `created_at: ${stamp}`,
          `updated_at: ${stamp}`,
          'tags: []',
          'confidence: 0.6',
          'importance: 50',
          'pinned: false',
          'visibility: desktop-private',
          'schema_version: 1',
          '---',
          '',
        ].join('\n');
        writeAtomic(filePath, head + raw.replace(/^\uFEFF/, ''), vaultPath);
        return { ok: true, id: wanted, code: which, action: `补了 frontmatter（type: ${type}，status: candidate）`, path: filePath };
      }

      case 'no-id': {
        const rel = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        const derived = memory.id && /^mem_/.test(String(memory.id)) ? memory.id : `mem_derived_${sha1(rel).slice(0, 8)}`;
        raw = setLine(raw, 'id', derived);
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `补了 id（${derived}）`, path: filePath };
      }

      case 'no-tags': {
        raw = setLine(raw, 'tags', '[]');
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: '补了 tags: []', path: filePath };
      }

      case 'empty-title': {
        const title = guessTitle(memory);
        raw = setLine(raw, 'title', yamlItem(title));
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `补了标题：${title}`, path: filePath };
      }

      case 'long-title': {
        const title = oneLine(memory.title).slice(0, TITLE_MAX_CHARS);
        raw = setLine(raw, 'title', yamlItem(title));
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `标题截到 ${TITLE_MAX_CHARS} 字`, path: filePath };
      }

      case 'bad-status': {
        const current = String(memory.status ?? '').toLowerCase();
        const next = MEMORY_STATUSES.includes(current) ? current : current === 'active' ? 'verified' : 'candidate';
        raw = setLine(raw, 'status', next);
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `status 改成 ${next}`, path: filePath };
      }

      case 'bad-importance': {
        const value = Number(memory.importance);
        const next = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 50;
        raw = setLine(raw, 'importance', String(next));
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `importance 改成 ${next}`, path: filePath };
      }

      case 'tag-is-type':
      case 'dup-tag': {
        const tags = cleanTags(memory);
        raw = setLine(raw, 'tags', yamlList(tags));
        raw = setLine(raw, 'updated_at', stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: `tags 清理成 ${tags.length} 个`, path: filePath };
      }

      case 'time-reversed': {
        // created_at 晚于 updated_at：把 updated_at 抬到 created_at，等于「最后改过的时间」= 创建时间，不编造新时间。
        const created = String(memory.createdAt || '').trim();
        raw = setLine(raw, 'updated_at', created || stamp);
        writeAtomic(filePath, raw, vaultPath);
        return { ok: true, id: wanted, code: which, action: 'updated_at 改到 created_at', path: filePath };
      }

      default:
        return { ok: false, id: wanted, code: which, message: `不认的修复：${which}` };
    }
  } catch (error) {
    return { ok: false, id: wanted, code: which, message: `修失败：${error?.message ?? String(error)}` };
  }
}
