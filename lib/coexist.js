import fs from 'node:fs';
import path from 'node:path';

/**
 * 共存检测：这台机器上有没有别的「记忆来源」——目前认 dsh-world。
 *
 * dsh-world 把原话归档进 <world>/archive.sqlite（范围由它的 archiveScope 决定，
 * 默认 workspace = 家所在工作区），跟本插件的 vault（一条一个 md）不互通：
 * 长期记忆在 vault，原话在 sqlite。两边各查各的，这里只做提示，不改任何文件。
 */
export function detectCompanionMemory({ worldsRoot, profilesRoot, home } = {}) {
  const base = home ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const worlds = worldsRoot ?? path.join(base, '.dsh', 'worlds');
  const profiles = profilesRoot ?? path.join(base, '.dsh', 'profiles');

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

  let installed = false;
  let version = '';
  if (fs.existsSync(profiles)) {
    for (const profile of fs.readdirSync(profiles)) {
      const pkg = path.join(profiles, profile, 'node_modules', 'dsh-world', 'package.json');
      try {
        const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        installed = true;
        if (typeof data.version === 'string') version = data.version;
      } catch {
        // 没装或不完整
      }
    }
  }

  return {
    installed,
    version,
    archives,
    hint:
      installed || archives.length
        ? 'dsh-world 的原话归档跟 vault 不互通：长期记忆走 memory_search，原话走它的 memory_find，或用 room/查原话.mjs 直接扫会话存档。'
        : '',
  };
}
