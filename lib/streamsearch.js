/**
 * 流水全文搜索：在 Daily/*.md 与 Projects/*.md 里按词找，只回命中行。
 *
 * 边界：
 *   - 只读，不改任何文件；
 *   - 所有词都要出现在同一行里（AND，和 memory_search 一致），大小写不敏感；
 *   - 不扫 .summary.md（那是收盘摘要，不是流水）；
 *   - 按文件修改时间从新到旧扫，命中够数就停。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 500;

function listMarkdown(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md') && !name.endsWith('.summary.md'))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { name, full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES);
}

function parseDailyLine(line) {
  const match = /^\s*-\s+(\d{2}:\d{2})\s+(?:\[([^\]]{1,24})\]\s*)?(.*)$/.exec(line);
  if (!match) return null;
  return { time: match[1], by: (match[2] || '家里').trim(), text: match[3].trim() };
}

/**
 * @param {string} vaultPath
 * @param {{ query?: string, limit?: number, from?: string, to?: string }} options
 * @returns {{ ok: boolean, query?: string, words?: string[], scanned?: number, hits?: object[], message?: string }}
 */
export function searchStreams(vaultPath, { query = '', limit = 20, from = '', to = '' } = {}) {
  const words = String(query)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (!words.length) return { ok: false, message: '要给一个搜索词（空格分隔多个）' };
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));
  const hits = [];
  let scanned = 0;

  const scanFile = (entry, kind) => {
    if (hits.length >= cap) return;
    let text = '';
    try {
      text = fs.readFileSync(entry.full, 'utf8');
    } catch {
      return;
    }
    scanned += 1;
    const date = kind === 'daily' ? entry.name.slice(0, 10) : '';
    const project = kind === 'project' ? entry.name.replace(/\.md$/, '') : '';
    if (date && from && date < from) return;
    if (date && to && date > to) return;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= cap) break;
      const line = lines[index];
      const lower = line.toLowerCase();
      if (!words.every((word) => lower.includes(word))) continue;
      const parsed = parseDailyLine(line);
      hits.push({
        kind,
        file: path.basename(entry.full),
        date,
        project,
        line: index + 1,
        time: parsed?.time ?? '',
        by: parsed?.by ?? '',
        text: parsed?.text ?? line.trim(),
      });
    }
  };

  // 项目日志先扫：没有日期过滤，主人多半是想在项目流里找
  for (const entry of listMarkdown(path.join(vaultPath, 'Projects'))) scanFile(entry, 'project');
  for (const entry of listMarkdown(path.join(vaultPath, 'Daily'))) scanFile(entry, 'daily');

  return { ok: true, query: String(query).trim(), words, scanned, hits };
}
