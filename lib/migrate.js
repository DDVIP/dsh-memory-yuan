/**
 * 旧记忆库的迁移入口：把 dsh-memory-evolve 那套 MEMORY.md / USER.md / projects/<项目>/KEY.md
 * 拆成一条条记忆，预览、去重、按 candidate 写进 vault。
 *
 * 为什么默认 candidate：迁移进来的东西等于「没经人确认」，不能直接进 L0/L1 的主路。
 * 旧日记不做成条目（它们是流水，不是长期事实），原样抄到 Archive/旧日记/ 下留档。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createMemory } from './store.js';
import { loadMemories } from './vault.js';

/** 旧库默认位置（dsh-memory-evolve 的根）。 */
export function defaultLegacyRoot() {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memories');
}

/** 归一化标题/正文用于去重：去标点空白、小写、截断。 */
export function normalizeKey(text, limit = 60) {
  return String(text ?? '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
    .slice(0, limit);
}

/** 旧文件里的条目按 `§` 或 `---` 分隔；每段剥掉 `[YYYY-MM-DD]` 前缀与 `[summary:…]` 行。 */
export function splitEntries(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n');
  const chunks = source
    .split(/\n§\n|\n---+\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const entries = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const body = [];
    let date = '';
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      if (/^\[summary:.*\]$/.test(line.trim())) continue;
      // 块首的 Markdown 标题不是内容（旧文件开头常有 '# 长期' 这种小标题）
      if (body.length === 0 && /^#{1,6}\s/.test(line.trim())) continue;
      const stamped = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
      if (stamped) {
        // 旧格式是 '[2026-10-30] [summary:…]'：日期那行的正文其实是摘要块，不是内容。
        if (!date) date = stamped[1];
        const rest = stamped[2].trim();
        if (rest && !/^\[summary:/.test(rest)) body.push(rest);
        continue;
      }
      body.push(line);
    }
    const text2 = body.join('\n').trim();
    if (!text2) continue;
    const firstLine = text2.split('\n')[0].trim();
    const title = firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
    entries.push({ title, content: text2, date });
  }
  return entries;
}

/** 按文件名猜类型：USER.md 是偏好与画像，KEY.md 是项目关键事实，其余按经验。 */
export function guessType(file) {
  const name = path.basename(String(file).replace(/\\/g, '/')).toLowerCase();
  if (name === 'user.md') return 'preference';
  if (name === 'key.md' || name === 'key-archive.md') return 'knowledge';
  return 'experience';
}

/** 扫出旧库里「条目型」文件（不含 daily/ 日记）。 */
export function scanLegacyMemoryFiles(root) {
  const found = [];
  const push = (file) => {
    try {
      if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) found.push(file);
    } catch {
      // 文件不在就算了
    }
  };
  push(path.join(root, 'MEMORY.md'));
  push(path.join(root, 'USER.md'));
  const projects = path.join(root, 'projects');
  let names = [];
  try {
    names = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    names = [];
  }
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    // projects/<id>/MEMORY.md 是逐条流水日志，不是长期事实，单独当日志抄走（见 scanLegacyLogs）
    for (const file of ['KEY.md', 'KEY-archive.md']) {
      push(path.join(projects, entry.name, file));
    }
  }
  return found;
}

/** 扫旧项目流水日志：projects/<id>/MEMORY.md（每天多条的流水，不拆成记忆条目）。 */
export function scanLegacyLogs(root) {
  const projects = path.join(root, 'projects');
  let names = [];
  try {
    names = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const logs = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projects, entry.name, 'MEMORY.md');
    try {
      if (fs.statSync(file).size > 0) logs.push({ project: entry.name, file });
    } catch {
      // 没有就算了
    }
  }
  return logs;
}

/** 扫旧日记：daily/YYYY-MM-DD.md。 */
export function scanLegacyJournals(root) {
  const dir = path.join(root, 'daily');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => ({ date: entry.name.slice(0, 10), file: path.join(dir, entry.name) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 出迁移计划：读旧库 + 现有 vault，去重（标题归一相同 或 正文前 60 字相同就跳过）。
 * 不改任何文件；真写走 applyMigration。
 */
export function planMigration({ root = defaultLegacyRoot(), vaultPath } = {}) {
  if (!vaultPath) return { ok: false, message: '缺少 vaultPath' };
  if (!fs.existsSync(root)) return { ok: false, message: `旧库不存在：${root}` };

  const existing = loadMemories(vaultPath);
  const titleSet = new Set(existing.map((memory) => normalizeKey(memory.title)));
  const bodySet = new Set(existing.map((memory) => normalizeKey(memory.core || memory.body)));

  const files = scanLegacyMemoryFiles(root);
  const entries = [];
  const skipped = [];
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      skipped.push({ title: path.basename(file), reason: `读不了：${error?.message ?? error}` });
      continue;
    }
    for (const entry of splitEntries(text)) {
      const titleKey = normalizeKey(entry.title);
      const bodyKey = normalizeKey(entry.content);
      if (titleSet.has(titleKey)) {
        skipped.push({ title: entry.title, reason: '库里已有同标题' });
        continue;
      }
      if (bodySet.has(bodyKey)) {
        skipped.push({ title: entry.title, reason: '库里已有同样内容' });
        continue;
      }
      titleSet.add(titleKey);
      bodySet.add(bodyKey);
      entries.push({
        ...entry,
        type: guessType(file),
        sourceFile: path.relative(root, file),
      });
    }
  }

  const journals = scanLegacyJournals(root).map((journal) => ({
    date: journal.date,
    file: journal.file,
    target: path.join(vaultPath, 'Archive', '旧日记', `${journal.date}.md`),
  }));

  const logs = scanLegacyLogs(root).map((log) => ({
    project: log.project,
    file: log.file,
    target: path.join(vaultPath, 'Archive', '旧日志', `${log.project}.md`),
  }));

  return {
    ok: true,
    root,
    vaultPath,
    entries,
    journals,
    logs,
    skipped,
    counts: {
      entries: entries.length,
      journals: journals.length,
      logs: logs.length,
      skipped: skipped.length,
      scannedFiles: files.length,
    },
  };
}

/**
 * 真写：条目按 candidate 进 Inbox（等人确认），日记原样抄到 Archive/旧日记/。
 * 已经存在同名文件时日记不覆盖（旧日记不会变，跳过即可）。
 */
export function applyMigration(plan, { vaultPath, now } = {}) {
  if (!plan?.ok) return { ok: false, message: plan?.message ?? '没有可执行的计划' };
  const vault = vaultPath ?? plan.vaultPath;
  const written = [];
  const skipped = [...(plan.skipped ?? [])];

  for (const entry of plan.entries ?? []) {
    const result = createMemory({
      vaultPath: vault,
      title: entry.title,
      type: entry.type,
      content: entry.content,
      source: `迁移自旧记忆库 ${entry.sourceFile}${entry.date ? `（${entry.date}）` : ''}`,
      tags: ['迁移'],
      importance: 50,
      status: 'candidate',
      now,
    });
    if (result.ok) {
      written.push({ id: result.id, title: result.title, type: result.type, path: result.path });
    } else {
      skipped.push({ title: entry.title, reason: result.message ?? '写入失败' });
    }
  }

  const journalsWritten = [];
  for (const journal of plan.journals ?? []) {
    if (fs.existsSync(journal.target)) {
      skipped.push({ title: path.basename(journal.target), reason: '已经迁过了' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(journal.target), { recursive: true });
      fs.copyFileSync(journal.file, journal.target);
      journalsWritten.push(journal.target);
    } catch (error) {
      skipped.push({ title: path.basename(journal.target), reason: `复制失败：${error?.message ?? error}` });
    }
  }

  const logsWritten = [];
  for (const log of plan.logs ?? []) {
    if (fs.existsSync(log.target)) {
      skipped.push({ title: path.basename(log.target), reason: '已经迁过了' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(log.target), { recursive: true });
      fs.copyFileSync(log.file, log.target);
      logsWritten.push(log.target);
    } catch (error) {
      skipped.push({ title: path.basename(log.target), reason: `复制失败：${error?.message ?? error}` });
    }
  }

  return {
    ok: true,
    written,
    journals: journalsWritten,
    logs: logsWritten,
    skipped,
    counts: {
      written: written.length,
      journals: journalsWritten.length,
      logs: logsWritten.length,
      skipped: skipped.length,
    },
  };
}
