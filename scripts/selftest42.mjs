// 第 8 条（共存提示）：检测 dsh-world 的安装与归档，并在结构体检里提示。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectCompanionMemory } from '../lib/coexist.js';
import { createTools } from '../lib/tools.js';

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

const contentOf = (value) => {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => part?.reply?.text ?? part?.text ?? part?.content ?? '').join('\n');
};

function emptyRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-coexist-'));
  const worlds = path.join(base, 'worlds');
  const profiles = path.join(base, 'profiles');
  fs.mkdirSync(worlds, { recursive: true });
  fs.mkdirSync(profiles, { recursive: true });
  return { base, worlds, profiles };
}

async function main() {
  await check('空环境：没装 dsh-world、没有归档库', () => {
    const { worlds, profiles } = emptyRoots();
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles });
    assert.equal(value.installed, false);
    assert.deepEqual(value.archives, []);
    assert.equal(value.hint, '');
  });

  await check('装了 dsh-world：读到版本号', () => {
    const { worlds, profiles } = emptyRoots();
    const dir = path.join(profiles, 'desktop', 'node_modules', 'dsh-world');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-world', version: '0.8.5' }));
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles });
    assert.equal(value.installed, true);
    assert.equal(value.version, '0.8.5');
  });

  await check('有归档库：按 world 列出来', () => {
    const { worlds, profiles } = emptyRoots();
    fs.mkdirSync(path.join(worlds, 'default'), { recursive: true });
    fs.writeFileSync(path.join(worlds, 'default', 'archive.sqlite'), 'sqlite-ish');
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles });
    assert.equal(value.archives.length, 1);
    assert.equal(value.archives[0].world, 'default');
    assert.ok(value.archives[0].size > 0);
    assert.match(value.hint, /archive\.sqlite|memory_find/);
  });

  await check('结构体检工具的 execute 带 coexist 字段', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-lint-'));
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_lint.execute({}, { logger: { info() {} }, effect() {} });
    assert.equal(typeof value.coexist?.installed, 'boolean');
    assert.ok(Array.isArray(value.coexist?.archives));
  });

  await check('render：有 dsh-world 时提示共存，没有时不出现', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-lint-'));
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const base = { ok: true, scanned: 3, flagged: 0, counts: { error: 0, warning: 0, info: 0 }, rows: [] };
    const withWorld = contentOf(
      tools.memory_lint.output.render({}, {
        ...base,
        coexist: { installed: true, version: '0.8.5', archives: [{ world: 'default' }], hint: '原话走 memory_find。' },
      }),
    );
    assert.match(withWorld, /共存/);
    assert.match(withWorld, /dsh-world 0\.8\.5/);
    assert.match(withWorld, /default/);
    const without = contentOf(
      tools.memory_lint.output.render({}, { ...base, coexist: { installed: false, version: '', archives: [], hint: '' } }),
    );
    assert.doesNotMatch(without, /共存/);
  });

  console.log(`\nselftest42：${pass} 通过，${fail} 失败`);
  if (fail) process.exitCode = 1;
}

main();
