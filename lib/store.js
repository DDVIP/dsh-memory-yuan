/**
 * 写入 vault：一条记忆一个 Markdown 文件。
 *
 * 纪律（设计稿）：
 *   - 改记忆 = 新建文件 + 旧文件 status: superseded，不覆盖、不删；
 *   - 一条只讲一件事；
 *   - 必写 updated，检索按它判新旧。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, readMemoryFile } from './vault.js';
import { pruneBackups } from './backups.js';
import { tryLock } from './lock.js';
import { isRealDate } from './stream.js';

/** type 决定放哪个目录。 */
export const TYPE_DIRS = {
  decision: 'Decisions',
  preference: 'Preferences',
  experience: 'Experiences',
  knowledge: 'Knowledge',
  'project-state': 'Projects/State',
  profile: 'Profile',
};

export const MEMORY_TYPES = Object.keys(TYPE_DIRS);

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`，跟 vault 现有条目一致。 */
export function stamp(now = new Date()) {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
  );
}

/** `mem_YYYYMMDDtHHMMSS_<8hex>`（UTC，跟现有 vault 同款）。 */
export function makeId(now = new Date()) {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `mem_${date}t${time}_${crypto.randomBytes(4).toString('hex')}`;
}

/** 文件名里的标题：去 Windows 非法字符，压空格，限 40 字。 */
export function slugify(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned || 'memory');
  return chars.slice(0, 40).join('').trim() || 'memory';
}

/** importance 夹到 0-100，confidence 夹到 0-1：越界值不该把排序顶翻。 */
function clampImportance(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function clampConfidence(value, fallback = 0.8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 标题天然是一行：压掉换行与连续空白。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  if (/[:#\n"'\\]/.test(text) || /^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}

/** 只有「安全」标量才原样写；其余一律 JSON.stringify，免得逗号/引号/括号把 flow 序列切坏。 */
function yamlItem(value) {
  const text = String(value);
  return /^[^\s,:#"'\\\[\]{}]+$/.test(text) ? text : JSON.stringify(text);
}

function yamlList(values) {
  const items = (values ?? []).map((value) => String(value)).filter(Boolean);
  return `[${items.map((item) => yamlItem(item)).join(', ')}]`;
}

/** 拼出一份完整的记忆文件。 */
export function serializeMemory(fields) {
  const {
    id,
    title,
    type,
    content,
    source = '',
    tags = [],
    importance = 50,
    pinned = false,
    confidence = 0.8,
    sourceSessions = [],
    createdAt = stamp(),
    updatedAt = createdAt,
    status = 'verified',
    evidence = '',
    expires = '',
    reads = 0,
  } = fields;

  // type 是独立字段，别再塞进 tags：否则每条都带一个类型词，检索时既是噪音，体检也会全量报警。
  const allTags = [...new Set(tags.filter(Boolean).map((tag) => String(tag).trim()).filter((tag) => tag && tag.toLowerCase() !== String(type).toLowerCase()))];

  const frontmatter = [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `status: ${status}`,
    `title: ${yamlScalar(oneLine(title))}`,
    `created_at: ${createdAt}`,
    `updated_at: ${updatedAt}`,
    `tags: ${yamlList(allTags)}`,
    `confidence: ${clampConfidence(confidence)}`,
    `importance: ${clampImportance(importance)}`,
    `pinned: ${pinned ? 'true' : 'false'}`,
    ...(evidence ? [`evidence: ${yamlScalar(oneLine(evidence))}`] : []),
    ...(expires ? [`expires: ${yamlScalar(oneLine(expires))}`] : []),
    `reads: ${Math.max(0, Math.floor(Number(reads) || 0))}`,
    'visibility: desktop-private',
    `source_sessions: ${yamlList(sourceSessions)}`,
    'schema_version: 1',
    '---',
    '',
  ].join('\n');

  const body = [
    '## 核心内容',
    '',
    String(content ?? '').trim(),
    '',
    '## 来源与依据',
    '',
    String(source || '（未记录）').trim(),
    '',
    '## 相关记忆',
    '',
    '（暂无）',
    '',
  ].join('\n');

  return `${frontmatter}${body}`;
}

/**
 * 新建一条记忆。返回 { ok, id, path } 或 { ok:false, message }。
 */
export function createMemory(input = {}) {
  const {
    title,
    type,
    content,
    source = '',
    tags = [],
    importance = 50,
    pinned = false,
    confidence = 0.8,
    sourceSessions = [],
    vaultPath,
    now = new Date(),
    id,
    status = 'verified',
    dirName,
    evidence = '',
    expires = '',
  } = input;

  if (!vaultPath) return { ok: false, message: '缺少 vaultPath' };
  if (!title || !String(title).trim()) return { ok: false, message: '缺少 title（一条只讲一件事，标题要能独立看懂）' };
  if (!content || !String(content).trim()) return { ok: false, message: '缺少 content（核心内容段）' };
  if (!MEMORY_TYPES.includes(type)) {
    return { ok: false, message: `不认的 type：${type}；可选 ${MEMORY_TYPES.join(' / ')}` };
  }
  let memoryStatus = String(status ?? 'verified').trim().toLowerCase();
  if (memoryStatus === 'active') memoryStatus = 'verified';
  const STATUS_ONLY = ['candidate', 'verified', 'disputed', 'superseded'];
  if (!STATUS_ONLY.includes(memoryStatus)) {
    return { ok: false, message: `status 只认 ${STATUS_ONLY.join(' / ')}（要归档用 supersedes），收到：${status}` };
  }

  const memoryId = id || makeId(now);
  const cleanTitle = oneLine(title);
  const dir = path.join(vaultPath, dirName || (memoryStatus === 'candidate' ? 'Inbox' : TYPE_DIRS[type]));
  const filePath = path.join(dir, `${slugify(cleanTitle)}-${memoryId}.md`);
  const createdAt = stamp(now);

  const text = serializeMemory({
    id: memoryId,
    title: cleanTitle,
    type,
    status: memoryStatus,
    content,
    source,
    tags,
    importance: clampImportance(importance),
    pinned: pinned === true,
    confidence: clampConfidence(confidence),
    sourceSessions,
    createdAt,
    updatedAt: createdAt,
    evidence,
    expires,
  });

  const outcome = tryLock(vaultPath, () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, text, 'utf8');
      return { ok: true, id: memoryId, path: filePath, type, title: cleanTitle };
    } catch (error) {
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/**
 * 把旧条目标成 superseded（只改 frontmatter，正文一个字不动）。
 * 返回 { ok, path } 或 { ok:false, message }。
 */
export function supersedeMemory(oldPath, newId, { now = new Date() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(oldPath, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不到旧文件：${error?.message ?? error}` };
  }

  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) {
    return { ok: false, message: '旧文件没有 frontmatter，拒绝改' };
  }

  const head = raw.slice(0, end);
  const rest = raw.slice(end);
  const updatedAt = stamp(now);

  let next = head.replace(/^status:\s*.*$/m, 'status: superseded').replace(/^updated_at:\s*.*$/m, `updated_at: ${updatedAt}`);
  if (!/^status:\s*/m.test(next)) next = `---\nstatus: superseded${next.slice(3)}`;
  if (!/^updated_at:\s*/m.test(next)) next = `${next.trimEnd()}\nupdated_at: ${updatedAt}`;
  if (newId && !/^superseded_by:\s*/m.test(next)) next = `${next.trimEnd()}\nsuperseded_by: ${newId}`;
  else if (newId) {
    // 第二次取代同一条：superseded_by 记最新，旧值挪到 previous_superseded_by，别静默丢信息。
    const current = /^superseded_by:\s*(.*)$/m.exec(next)?.[1]?.trim() ?? '';
    if (current !== newId) {
      next = next.replace(/^superseded_by:\s*.*$/m, `superseded_by: ${newId}`);
      if (current && !/^previous_superseded_by:/m.test(next)) next = `${next.trimEnd()}\nprevious_superseded_by: ${current}`;
    }
  }

  // 旧文件在 <vault>/<目录>/<文件>.md，锁放在 vault 根上。
  const vaultGuess = path.dirname(path.dirname(oldPath));
  const outcome = tryLock(vaultGuess, () => {
    try {
      // 改旧条目之前先存一份：误标 superseded 之后还能拿回原样。
      backupFile(oldPath, vaultGuess);
      fs.writeFileSync(oldPath, `${next}${rest}`, 'utf8');
      return { ok: true, path: oldPath };
    } catch (error) {
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/**
 * 覆盖写之前留一份：<vault>/.dsh-memory/backups/<文件名>.<时间戳>.<pid>.bak，同一文件只留最近 keep 份。
 * 借的是 @wilshi/dsh-memory-engine 的 MemoryStore.backup()：误标 superseded、误改状态之后还能拿回来。
 * 备份失败不阻断主流程（返回 ok:false，调用方忽略）。
 */
let backupSeq = 0;

export function backupFile(filePath, vaultPath, { keep = 5 } = {}) {
  try {
    if (!filePath || !vaultPath || !fs.existsSync(filePath)) return { ok: false, message: '没有可备份的文件' };
    const dir = path.join(vaultPath, '.dsh-memory', 'backups');
    fs.mkdirSync(dir, { recursive: true });

    const base = path.basename(filePath);
    const stampText = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const target = path.join(dir, `${base}.${stampText}.${process.pid}-${backupSeq++}.bak`);
    fs.copyFileSync(filePath, target);

    const siblings = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith('.bak'))
      .map((name) => {
        const full = path.join(dir, name);
        return { full, at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    for (const extra of siblings.slice(Math.max(1, keep))) {
      try {
        fs.unlinkSync(extra.full);
      } catch {
        // 删不掉就留着，不影响本次写入
      }
    }
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  } finally {
    // 总闸：备份跨文件的总量没上限，超了删最旧的（失败不影响写入）。
    try {
      pruneBackups(vaultPath);
    } catch {
      /* 清理失败就算了，下次再清 */
    }
  }
}

/**
 * 记一次 memory_get：把 frontmatter 的 reads 加一。
 * 只动 reads 这一行（没有就补一行）；读计数失败不该让 memory_get 失败——调用方忽略返回值。
 */
export function recordRead(filePath, vaultPath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不到文件：${error?.message ?? error}` };
  }
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return { ok: false, message: '没有 frontmatter，不动' };

  const head = raw.slice(0, end);
  const rest = raw.slice(end);
  const current = Number(/^reads:\s*(\d+)\s*$/m.exec(head)?.[1] ?? 0);
  const nextCount = (Number.isFinite(current) ? current : 0) + 1;

  let next = head.replace(/^reads:\s*.*$/m, `reads: ${nextCount}`);
  if (!/^reads:\s*/m.test(next)) {
    next = /^updated_at:\s*.*$/m.test(next)
      ? next.replace(/^updated_at:\s*.*$/m, (line) => `${line}\nreads: ${nextCount}`)
      : `${next.trimEnd()}\nreads: ${nextCount}`;
  }

  const outcome = tryLock(vaultPath || path.dirname(path.dirname(filePath)), () => {
    try {
      fs.writeFileSync(filePath, `${next}${rest}`, 'utf8');
      return { ok: true, reads: nextCount };
    } catch (error) {
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/** 改一条记忆的 status（界面「标为 verified / disputed」用）；只动 status 与 updated_at。 */
export function setMemoryPinned(filePath, pinned, { now = new Date() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不到文件：${error?.message ?? error}` };
  }
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return { ok: false, message: '没有 frontmatter，拒绝改' };
  const head = raw.slice(0, end);
  const rest = raw.slice(end);
  const updatedAt = stamp(now);
  const value = pinned === true ? 'true' : 'false';
  let next = head
    .replace(/^pinned:\s*.*$/m, `pinned: ${value}`)
    .replace(/^updated_at:\s*.*$/m, `updated_at: ${updatedAt}`);
  if (!/^pinned:\s*/m.test(next)) next = `${next.trimEnd()}\npinned: ${value}`;
  if (!/^updated_at:\s*/m.test(next)) next = `${next.trimEnd()}\nupdated_at: ${updatedAt}`;

  const outcome = tryLock(path.dirname(path.dirname(filePath)), () => {
    try {
      backupFile(filePath, path.dirname(path.dirname(filePath)));
      fs.writeFileSync(filePath, `${next}${rest}`, 'utf8');
      return { ok: true, path: filePath, pinned: value === 'true' };
    } catch (error) {
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/** 改时效：expires='' 表示永不过期。只动 frontmatter，正文不碰。 */
export function setMemoryExpiry(filePath, expires, { now = new Date() } = {}) {
  const stamp = String(expires ?? '').trim();
  if (stamp && !/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
    return { ok: false, message: `expires 要 YYYY-MM-DD 或空，收到：${stamp}` };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    backupFile(filePath, path.dirname(path.dirname(filePath)));
    // 先删旧行，再按需插到 updated_at 之后；别把过期日误当成修改时间。
    let next = raw.replace(/^expires:.*\r?\n?/m, '');
    if (stamp) {
      next = /^updated_at:.*$/m.test(next)
        ? next.replace(/^(updated_at:.*)$/m, `$1\nexpires: ${stamp}`)
        : next.replace(/^status:.*$/m, (line) => `${line}\nexpires: ${stamp}`);
    }
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    next = /^updated_at:.*$/m.test(next)
      ? next.replace(/^updated_at:.*$/m, `updated_at: ${local}`)
      : next;
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true, path: filePath, expires: stamp };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

/** 写出处：evidence='' 表示清空。只动 frontmatter，正文不碰。 */
export function setMemoryEvidence(filePath, evidence, { now = new Date() } = {}) {
  // frontmatter 是单行字段：换行/连续空白压成一个空格，长度截 300。
  const text = String(evidence ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    backupFile(filePath, path.dirname(path.dirname(filePath)));
    let next = raw.replace(/^evidence:.*\r?\n?/m, '');
    if (text) {
      next = /^updated_at:.*$/m.test(next)
        ? next.replace(/^(updated_at:.*)$/m, `$1\nevidence: ${text}`)
        : next.replace(/^status:.*$/m, (line) => `${line}\nevidence: ${text}`);
    }
    const local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    next = /^updated_at:.*$/m.test(next) ? next.replace(/^updated_at:.*$/m, `updated_at: ${local}`) : next;
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true, path: filePath, evidence: text };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

export function setMemoryStatus(filePath, status, { now = new Date() } = {}) {
  const nextStatus = String(status ?? '').trim().toLowerCase();
  if (!['candidate', 'verified', 'disputed', 'superseded'].includes(nextStatus)) {
    return { ok: false, message: `status 只认 candidate / verified / disputed / superseded，收到：${status}` };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不到文件：${error?.message ?? error}` };
  }
  const end = raw.indexOf('\n---', 3);
  if (!raw.startsWith('---') || end === -1) return { ok: false, message: '没有 frontmatter，拒绝改' };
  const head = raw.slice(0, end);
  const rest = raw.slice(end);
  const updatedAt = stamp(now);
  let next = head.replace(/^status:\s*.*$/m, `status: ${nextStatus}`).replace(/^updated_at:\s*.*$/m, `updated_at: ${updatedAt}`);
  if (!/^status:\s*/m.test(next)) next = `---\nstatus: ${nextStatus}${next.slice(3)}`;
  if (!/^updated_at:\s*/m.test(next)) next = `${next.trimEnd()}\nupdated_at: ${updatedAt}`;

  const outcome = tryLock(path.dirname(path.dirname(filePath)), () => {
    try {
      backupFile(filePath, path.dirname(path.dirname(filePath)));
      fs.writeFileSync(filePath, `${next}${rest}`, 'utf8');
      return { ok: true, path: filePath, status: nextStatus };
    } catch (error) {
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/**
 * 改一条记忆的标题 / 标签 / 重要度 / 正文。
 *
 * 只动这几个字段（和 updated_at），frontmatter 其它行、正文其它章节一字不改；
 * 先备份、持锁、tmp+rename 落盘。正文用「## 核心内容」定位，找不到就插到最前面。
 */
export function updateMemory(filePath, patch = {}, { vaultPath } = {}) {
  if (!filePath) return { ok: false, message: '缺少文件路径' };
  const vault = vaultPath ?? path.dirname(path.dirname(filePath));
  const { title, tags, importance, content, evidence, expires } = patch;
  if (title !== undefined && !String(title).trim()) return { ok: false, message: '标题不能是空的' };
  if (tags !== undefined && !Array.isArray(tags)) return { ok: false, message: 'tags 要给数组' };
  if (content !== undefined && !String(content).trim()) return { ok: false, message: '正文不能是空的' };
  if (expires !== undefined && String(expires).trim() && !isRealDate(String(expires).trim())) {
    return { ok: false, message: 'expires 要 YYYY-MM-DD，或者传空串清掉' };
  }

  const outcome = tryLock(vault, () => {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      return { ok: false, message: `读不到文件：${error?.message ?? error}` };
    }
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (!match) return { ok: false, message: '这个文件没有 frontmatter，先手改一次再加' };
    let head = match[1];
    const body = raw.slice(match[0].length);
    const snapOf = (front, text) => {
      const data = parseFrontmatter(front);
      const core = /##\s*核心内容\s*\n+([\s\S]*?)(?:\n##\s|$)/.exec(text);
      return {
        title: String(data.title ?? ''),
        tags: Array.isArray(data.tags) ? data.tags : [],
        importance: Number(data.importance) || 0,
        evidence: String(data.evidence ?? ''),
        expires: String(data.expires ?? ''),
        core: core ? core[1].trim() : '',
      };
    };
    const before = snapOf(head, body);
    const setLine = (text, key, value) => {
      const re = new RegExp('^' + key + ':.*', 'm');
      return re.test(text) ? text.replace(re, key + ': ' + value) : text.trimEnd() + '\n' + key + ': ' + value;
    };
    const dropLine = (text, key) => text.replace(new RegExp('^' + key + ':.*\\r?\\n?', 'm'), '');
    const changed = [];
    if (typeof title === 'string' && title.trim()) {
      head = setLine(head, 'title', yamlScalar(oneLine(title)));
      changed.push('title');
    }
    if (Array.isArray(tags)) {
      const typeName = String(parseFrontmatter(head).type ?? '').toLowerCase();
      const cleanTags = [...new Set(tags.map((tag) => String(tag).trim()).filter((tag) => tag && tag.toLowerCase() !== typeName))];
      head = setLine(head, 'tags', yamlList(cleanTags));
      changed.push('tags');
    }
    if (importance !== undefined) {
      head = setLine(head, 'importance', String(clampImportance(importance)));
      changed.push('importance');
    }
    if (typeof evidence === 'string') {
      head = evidence.trim() ? setLine(head, 'evidence', yamlScalar(oneLine(evidence))) : dropLine(head, 'evidence');
      changed.push('evidence');
    }
    if (typeof expires === 'string') {
      head = expires.trim() ? setLine(head, 'expires', String(expires).trim()) : dropLine(head, 'expires');
      changed.push('expires');
    }
    if (content !== undefined) changed.push('content');
    head = setLine(head, 'updated_at', stamp());

    let nextBody = body;
    if (typeof content === 'string' && content.trim()) {
      const at = body.indexOf('## 核心内容');
      if (at >= 0) {
        const after = body.indexOf('\n## ', at + 6);
        const beforeText = body.slice(0, at);
        const rest = after >= 0 ? body.slice(after) : '\n';
        nextBody = beforeText + '## 核心内容\n\n' + content.trim() + '\n' + rest;
      } else {
        nextBody = '## 核心内容\n\n' + content.trim() + '\n\n' + body;
      }
    }
    const backup = backupFile(filePath, vault);
    if (!backup.ok) return { ok: false, message: `备份没成功，先不写：${backup.message}` };
    const tmp = filePath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, '---\n' + head + '\n---\n' + nextBody, 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响报错 */ }
      return { ok: false, message: `写文件失败：${error?.message ?? error}` };
    }
    return { ok: true, path: filePath, before, after: snapOf(head, nextBody), changed };
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

/**
 * 删除 = 移到 Archive/（留底可回滚），不真删；重名加时间戳后缀。
 */
export function archiveMemory(filePath, { vaultPath } = {}) {
  if (!filePath) return { ok: false, message: '缺少文件路径' };
  const vault = vaultPath ?? path.dirname(path.dirname(filePath));
  const outcome = tryLock(vault, () => {
    const dir = path.join(vault, 'Archive');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, message: `建不了 Archive 目录：${error?.message ?? error}` };
    }
    const base = path.basename(filePath);
    let target = path.join(dir, base);
    if (fs.existsSync(target)) target = path.join(dir, base.replace(/\.md$/i, '') + '.' + Date.now() + '.md');
    const backup = backupFile(filePath, vault);
    if (!backup.ok) return { ok: false, message: `备份没成功，先不删：${backup.message}` };
    try {
      fs.renameSync(filePath, target);
    } catch (error) {
      return { ok: false, message: `移到 Archive 失败：${error?.message ?? error}` };
    }
    return { ok: true, path: target };
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}

export { parseFrontmatter, readMemoryFile };

/**
 * 从 Archive/ 把一条记忆挪回它该在的目录。
 * Archive 里文件名保留原样（`<slug>-<id>.md`），所以按 id 就能找到；目录按 type 回。
 */
export function restoreMemory(vaultPath, id) {
  const key = String(id ?? '').trim();
  if (!key) return { ok: false, message: '缺少 id' };
  const dir = path.join(vaultPath, 'Archive');
  if (!fs.existsSync(dir)) return { ok: false, message: 'Archive 目录不存在，没有可恢复的' };
  const wanted = key.toLowerCase();

  /** 在 Archive 下（含子目录）找文件名里带这个 id 的文件。 */
  const findIn = (root) => {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        found.push(...findIn(full));
      } else if (/\.md$/i.test(entry.name) && entry.name.toLowerCase().includes(wanted)) {
        found.push(full);
      }
    }
    return found;
  };

  const matches = findIn(dir);
  if (!matches.length) return { ok: false, message: `Archive 里没有 id 含「${key}」的文件` };

  const file = matches.sort((a, b) => a.length - b.length)[0];
  const memory = readMemoryFile(file, vaultPath);
  const type = String(memory?.type ?? '');
  const targetDir = TYPE_DIRS[type] ?? 'Inbox';
  const target = path.join(vaultPath, targetDir, path.basename(file));

  const outcome = tryLock(vaultPath, () => {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (error) {
      return { ok: false, message: `建不了目标目录：${error?.message ?? error}` };
    }
    let finalPath = target;
    if (fs.existsSync(finalPath)) {
      finalPath = path.join(path.dirname(target), path.basename(target).replace(/\.md$/i, '') + '.' + Date.now() + '.md');
    }
    try {
      fs.renameSync(file, finalPath);
    } catch (error) {
      return { ok: false, message: `移出 Archive 失败：${error?.message ?? error}` };
    }
    return { ok: true, path: finalPath, from: file, type: type || '未知', dir: targetDir };
  });
  if (outcome?.locked) return { ok: false, message: outcome.message };
  return outcome;
}
