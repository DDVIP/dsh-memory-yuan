/**
 * L1 参数的运行期覆盖：存在 vault 的 `.dsh-memory/l1-settings.json`，
 * 面板上改完立刻生效（下一轮注入就用新值），不用重启、不改插件配置。
 *
 * 只允许这四个数字，范围写死在这里；写文件走 tmp + rename。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 参数名 → [最小, 最大]。 */
export const L1_RANGES = {
  maxItems: [1, 12],
  minHits: [1, 8],
  minScore: [0, 60],
  minStrongHits: [0, 4],
};

const FILE_NAME = 'l1-settings.json';
let cache = { key: '', value: null };

function settingsPathOf(vaultPath) {
  return path.join(vaultPath, '.dsh-memory', FILE_NAME);
}

/** 读覆盖值：文件不在、坏了、超范围都当没设。 */
export function readL1Settings(vaultPath) {
  const file = settingsPathOf(vaultPath);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (cache.key === key) return cache.value;
  let value = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [name, [min, max]] of Object.entries(L1_RANGES)) {
      const number = Number(raw?.[name]);
      if (Number.isFinite(number) && number >= min && number <= max) value[name] = Math.round(number);
    }
  } catch {
    value = {};
  }
  cache = { key, value };
  return value;
}

/** 写覆盖值（只写传了的那几个；返回合并后的完整覆盖）。 */
export function writeL1Settings(vaultPath, patch = {}) {
  const next = { ...readL1Settings(vaultPath) };
  const changed = [];
  for (const [name, [min, max]] of Object.entries(L1_RANGES)) {
    if (!(name in patch)) continue;
    const number = Number(patch[name]);
    if (!Number.isFinite(number)) return { ok: false, message: `${name} 要一个数字` };
    if (number < min || number > max) return { ok: false, message: `${name} 要在 ${min}–${max} 之间，收到 ${number}` };
    next[name] = Math.round(number);
    changed.push(name);
  }
  if (!changed.length) return { ok: false, message: `没给要改的项；可选 ${Object.keys(L1_RANGES).join(' / ')}` };

  const file = settingsPathOf(vaultPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    return { ok: false, message: `写 l1-settings.json 失败：${error?.message ?? String(error)}` };
  }
  return { ok: true, settings: next, changed };
}

/** 清掉某个覆盖（传空串或 null 就是恢复默认）。 */
export function clearL1Setting(vaultPath, name) {
  if (!(name in L1_RANGES)) return { ok: false, message: `不认的参数：${name}` };
  const current = readL1Settings(vaultPath);
  if (!(name in current)) return { ok: true, settings: current, cleared: name };
  const next = { ...current };
  delete next[name];
  const file = settingsPathOf(vaultPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    return { ok: false, message: `写 l1-settings.json 失败：${error?.message ?? String(error)}` };
  }
  return { ok: true, settings: next, cleared: name };
}

/** 配置默认值 + 面板覆盖 = 这一轮真正用的参数。 */
export function effectiveL1Options(vaultPath, base) {
  return { ...base, ...readL1Settings(vaultPath) };
}
