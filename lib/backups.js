/**
 * 备份目录的用量与清理。
 *
 * 每次改记忆都会在 <vault>/.dsh-memory/backups/ 留一份 .bak；单文件有 keep=5 的
 * 份数限制，但跨文件的**总量**没有上限，库用久了会一直长。这里给一条总闸：
 * 超过 300 份或 20MB 就删最旧的（保底留 20 份，免得一删干净没法回退）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PRUNE_MAX_FILES = 300;
export const PRUNE_MAX_BYTES = 20 * 1024 * 1024;
export const PRUNE_MIN_KEEP = 20;

export function backupsDirOf(vaultPath) {
  return path.join(vaultPath, '.dsh-memory', 'backups');
}

/** 当前备份目录：多少个文件、占多少字节。 */
export function backupStats(vaultPath) {
  const dir = backupsDirOf(vaultPath);
  if (!fs.existsSync(dir)) return { dir, files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.bak')) continue;
    try {
      bytes += fs.statSync(path.join(dir, name)).size;
      files += 1;
    } catch {
      /* 读不到就跳过 */
    }
  }
  return { dir, files, bytes };
}

/**
 * 超量时删最旧的备份。
 * @param {string} vaultPath
 * @param {{ maxFiles?: number, maxBytes?: number, keepAtLeast?: number }} options
 * @returns {{ ok: boolean, removed: number, before: {files:number,bytes:number}, after: {files:number,bytes:number} }}
 */
export function pruneBackups(vaultPath, { maxFiles = PRUNE_MAX_FILES, maxBytes = PRUNE_MAX_BYTES, keepAtLeast = PRUNE_MIN_KEEP } = {}) {
  const dir = backupsDirOf(vaultPath);
  const before = backupStats(vaultPath);
  if (!fs.existsSync(dir) || (before.files <= maxFiles && before.bytes <= maxBytes)) {
    return { ok: true, removed: 0, before, after: before };
  }

  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.bak'))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return { full, at: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => a.at - b.at);

  let files = entries.length;
  let bytes = entries.reduce((sum, item) => sum + item.size, 0);
  let removed = 0;
  for (const entry of entries) {
    if (files <= maxFiles && bytes <= maxBytes) break;
    if (files <= keepAtLeast) break;
    try {
      fs.unlinkSync(entry.full);
      files -= 1;
      bytes -= entry.size;
      removed += 1;
    } catch {
      break;
    }
  }

  return { ok: true, removed, before, after: { files, bytes } };
}
