import fs from 'node:fs';
import path from 'node:path';

/**
 * 共存检测：这台机器上还有没有别的「记忆来源」。
 *
 * 认三类，都不读对方的数据、只记「在哪儿」：
 *  1. dsh-world 的原话归档：<world>/archive.sqlite（范围由它的 archiveScope 定，默认家所在工作区）
 *  2. 旧记忆库 dsh-memory-evolve：~/.dsh/memories（MEMORY.md / USER.md / projects/<id>/KEY.md）
 *  3. 别家记忆类插件：profiles/*\/node_modules 下名字像记忆插件的包（dsh-memory-* / dsh-world / dsh-recall…）
 *
 * vault 只读自己的 Markdown，跟这些库不互通：长期记忆在 vault，别的各自查各自的。
 */

const COMPANION_NAME = /^dsh-(memory|world|recall|mem|memor)/i;
const SELF = 'dsh-memory-yuan';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 旧记忆库里的条目文件（只看形状，不解析内容） */
function scanLegacy(dir) {
  const files = [];
  const push = (rel) => {
    const file = path.join(dir, rel);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0) files.push(rel);
    } catch {
      // 没有就算了
    }
  };
  push('MEMORY.md');
  push('USER.md');
  push('key.md');
  try {
    const projects = path.join(dir, 'projects');
    for (const id of fs.readdirSync(projects)) {
      push(path.join('projects', id, 'KEY.md'));
      push(path.join('projects', id, 'MEMORY.md'));
    }
  } catch {
    // 没有 projects 目录
  }
  return files;
}

export function detectCompanionMemory({ worldsRoot, profilesRoot, home } = {}) {
  const base = home ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const dshRoot = path.join(base, '.dsh');
  const worlds = worldsRoot ?? path.join(dshRoot, 'worlds');
  const profiles = profilesRoot ?? path.join(dshRoot, 'profiles');

  // 1) dsh-world 的归档库
  const archives = [];
  if (fs.existsSync(worlds)) {
    for (const name of fs.readdirSync(worlds)) {
      const file = path.join(worlds, name, 'archive.sqlite');
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) archives.push({ world: name, size: stat.size, at: stat.mtime.toISOString() });
      } catch {
        // 这个 world 没有归档库
      }
    }
  }

  // 2) 装着的记忆类插件（排除自己）
  const plugins = [];
  if (fs.existsSync(profiles)) {
    for (const profile of fs.readdirSync(profiles)) {
      const modules = path.join(profiles, profile, 'node_modules');
      let names = [];
      try {
        names = fs.readdirSync(modules);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name === SELF || !COMPANION_NAME.test(name)) continue;
        // scoped 包（@scope/name）跳过：形状不同，先不猜
        const pkg = readJson(path.join(modules, name, 'package.json'));
        if (!pkg) continue;
        plugins.push({ name, version: typeof pkg.version === 'string' ? pkg.version : '', profile });
      }
    }
  }
  const world = plugins.find((item) => item.name === 'dsh-world') ?? null;

  // 3) 旧记忆库
  const legacyDir = path.join(dshRoot, 'memories');
  const legacyFiles = fs.existsSync(legacyDir) ? scanLegacy(legacyDir) : [];
  const legacy = legacyFiles.length ? { dir: legacyDir, files: legacyFiles } : null;

  const found = archives.length > 0 || plugins.length > 0 || !!legacy;

  const lines = [];
  if (world || archives.length) {
    const ver = world?.version ? ` ${world.version}` : '';
    const where = archives.length ? `，原话归档在 ${archives.map((a) => a.world).join('、')} 的 archive.sqlite` : '';
    lines.push(`dsh-world${ver}${where}（原话归档跟 vault 不互通：原话走它的 memory_find，或用 scripts/查原话.mjs 直接扫会话存档）。`);
  }
  if (legacy) {
    lines.push(`旧记忆库还在 ${legacy.dir}（${legacyFiles.length} 个条目文件），要搬进 vault 用 memory_migrate。`);
  }
  for (const item of plugins) {
    if (item.name === 'dsh-world') continue;
    lines.push(`${item.name}${item.version ? ` ${item.version}` : ''}（自己的记忆存在自己那儿，vault 不读它）。`);
  }

  return {
    found,
    installed: !!world,
    version: world?.version ?? '',
    archives,
    plugins,
    legacy,
    hint: found
      ? `这台机器上还有别的记忆来源，vault 只读自己的 Markdown：\n${lines.map((line) => `- ${line}`).join('\n')}`
      : '',
  };
}
