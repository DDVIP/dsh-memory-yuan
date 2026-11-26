/**
 * 记忆包：导出 / 导入。
 *
 * 借 dsh-memory-doctor 的「记忆包 v2」：导出目录里带 MANIFEST.json（每个文件的 sha256 + 字节），
 * 导入先逐文件校验，不一致就零写入；默认 dry-run；同名不同内容绝不覆盖，另存 `.导入-<时间>`。
 *
 * 不导出 `.dsh-memory/`（索引、锁、备份、hits 都是本机运行态，跟着走反而会打架）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tryLock } from './lock.js';

export const BUNDLE_FORMAT = 'dsh-memory-yuan/bundle';
export const BUNDLE_VERSION = 1;
const SKIP_DIRS = new Set(['.dsh-memory', '.obsidian', '.git', 'Archive']);

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 递归列出要进记忆包的文件（相对 vault 的路径，正斜杠）。 */
export function listBundleFiles(vaultPath) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const nextAbs = path.join(abs, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(nextAbs, nextRel);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(nextRel);
    }
  };
  walk(vaultPath, '');
  return out.sort();
}

export function countOfFiles(files) {
  let daily = 0;
  let projects = 0;
  let memories = 0;
  for (const file of files) {
    if (file.startsWith('Daily/')) daily += 1;
    else if (file.startsWith('Projects/') && !file.startsWith('Projects/State/')) projects += 1;
    else memories += 1;
  }
  return { memories, daily, projects };
}

function stampText(now) {
  const iso = new Date(now).toISOString();
  return iso.slice(0, 10);
}

function compactStamp(now) {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

export function defaultExportRoot() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'memory-exports');
}

/**
 * 导出记忆包到 `<outRoot>/记忆包-YYYY-MM-DD-<4hex>/`。
 * 返回 { ok, dir, files, counts, at } 或 { ok:false, message }。
 */
export function exportBundle(vaultPath, { outRoot = defaultExportRoot(), now = new Date() } = {}) {
  try {
    if (!vaultPath || !fs.existsSync(vaultPath)) return { ok: false, message: `vault 不存在：${vaultPath}` };
    const suffix = crypto.randomBytes(2).toString('hex');
    const dir = path.join(outRoot, `记忆包-${stampText(now)}-${suffix}`);
    const files = listBundleFiles(vaultPath);
    if (!files.length) return { ok: false, message: '库里没有 .md 文件，没什么可导出的' };

    const manifest = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      at: new Date(now).toISOString(),
      vault: vaultPath,
      counts: countOfFiles(files),
      files: [],
    };

    fs.mkdirSync(dir, { recursive: true });
    for (const rel of files) {
      const source = path.join(vaultPath, ...rel.split('/'));
      const buffer = fs.readFileSync(source);
      const target = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      manifest.files.push({ path: rel, sha256: sha256Of(buffer), bytes: buffer.length });
    }

    fs.writeFileSync(
      path.join(dir, 'README.md'),
      [
        '# 记忆包',
        '',
        `导出时间：${manifest.at}`,
        `来源库：${vaultPath}`,
        '',
        '这是 dsh-memory-yuan 的记忆包（一条记忆一个 Markdown 文件，另有 MANIFEST.json 记录每个文件的 sha256）。',
        '',
        '## 怎么导入',
        '',
        '1. 在 DSH 里让助手调 `memory_import`，传 `bundle` 为这个文件夹的路径，先 `dryRun: true` 看清单；',
        '2. 确认后 `dryRun: false` 落盘。同名但内容不同的文件不会覆盖，会另存为 `.导入-<时间>.md`。',
        '',
        '`.dsh-memory/`（索引、锁、备份、命中统计）不在包里，导入后会按需重建。',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return { ok: true, dir, files: files.length, counts: manifest.counts, at: manifest.at };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

function readManifest(bundleDir) {
  const file = path.join(bundleDir, 'MANIFEST.json');
  if (!fs.existsSync(file)) return { ok: false, message: `没有 MANIFEST.json：${file}` };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest?.format !== BUNDLE_FORMAT) return { ok: false, message: `不是这个插件的记忆包（format=${manifest?.format}）` };
    if (!Array.isArray(manifest.files) || !manifest.files.length) return { ok: false, message: 'MANIFEST 里没有文件清单' };
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, message: `MANIFEST 读不出来：${error?.message ?? error}` };
  }
}

/**
 * 导入记忆包。默认 dryRun：只报告会写什么。
 * 逐文件先验 sha256；任何一个不符就零写入（不做「部分导入」）。
 */
export function importBundle(bundleDir, { vaultPath, dryRun = true, now = new Date() } = {}) {
  try {
    if (!vaultPath) return { ok: false, message: '缺少 vaultPath' };
    if (!bundleDir || !fs.existsSync(bundleDir)) return { ok: false, message: `记忆包不存在：${bundleDir}` };
    const read = readManifest(bundleDir);
    if (!read.ok) return read;
    const { manifest } = read;

    const verified = [];
    const errors = [];
    for (const item of manifest.files) {
      const rel = String(item.path ?? '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.includes('..')) {
        errors.push({ path: rel, reason: '路径不合法' });
        continue;
      }
      const source = path.join(bundleDir, ...rel.split('/'));
      if (!fs.existsSync(source)) {
        errors.push({ path: rel, reason: '文件在包里不存在' });
        continue;
      }
      const buffer = fs.readFileSync(source);
      const digest = sha256Of(buffer);
      if (digest !== item.sha256) {
        errors.push({ path: rel, reason: `sha256 不一致（清单 ${String(item.sha256).slice(0, 8)}…，实际 ${digest.slice(0, 8)}…）` });
        continue;
      }
      verified.push({ rel, buffer, sha256: digest });
    }
    if (errors.length) return { ok: false, message: '校验没过，一条都没写', errors, verified: verified.length };

    const plan = { written: [], skipped: [], conflicts: [] };
    for (const item of verified) {
      const target = path.join(vaultPath, ...item.rel.split('/'));
      if (fs.existsSync(target)) {
        const existing = sha256Of(fs.readFileSync(target));
        if (existing === item.sha256) {
          plan.skipped.push(item.rel);
          continue;
        }
        const parsed = path.parse(target);
        const renamed = path.join(parsed.dir, `${parsed.name}.导入-${compactStamp(now)}${parsed.ext}`);
        plan.conflicts.push({ path: item.rel, target: renamed, reason: '同名但内容不同，另存不覆盖' });
        plan.written.push({ path: item.rel, target: renamed, conflict: true });
        continue;
      }
      plan.written.push({ path: item.rel, target, conflict: false });
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        bundle: bundleDir,
        at: manifest.at,
        counts: manifest.counts,
        verified: verified.length,
        ...plan,
      };
    }

    const outcome = tryLock(vaultPath, () => {
      const created = [];
      for (const item of plan.written) {
        const source = verified.find((entry) => entry.rel === item.path);
        if (!source) continue;
        fs.mkdirSync(path.dirname(item.target), { recursive: true });
        const tmp = `${item.target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, source.buffer);
        fs.renameSync(tmp, item.target);
        created.push({ path: item.path, target: item.target, conflict: item.conflict });
      }
      return created;
    });
    if (outcome?.locked) return { ok: false, message: outcome.message };

    return {
      ok: true,
      dryRun: false,
      bundle: bundleDir,
      at: manifest.at,
      counts: manifest.counts,
      verified: verified.length,
      written: outcome,
      skipped: plan.skipped,
      conflicts: plan.conflicts,
    };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}
