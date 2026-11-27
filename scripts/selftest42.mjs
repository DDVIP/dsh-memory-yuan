// 第 8 条（共存提示）：检测机器上别的记忆来源（dsh-world / 旧库 / 别家记忆插件），并在结构体检里提示。
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
  await check('空环境：什么都没有', () => {
    const { base, worlds, profiles } = emptyRoots();
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles, home: base });
    assert.equal(value.found, false);
    assert.equal(value.installed, false);
    assert.deepEqual(value.archives, []);
    assert.deepEqual(value.plugins, []);
    assert.equal(value.legacy, null);
    assert.equal(value.hint, '');
  });

  await check('装了 dsh-world：读到版本号', () => {
    const { base, worlds, profiles } = emptyRoots();
    const dir = path.join(profiles, 'desktop', 'node_modules', 'dsh-world');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-world', version: '0.8.5' }));
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles, home: base });
    assert.equal(value.found, true);
    assert.equal(value.installed, true);
    assert.equal(value.version, '0.8.5');
  });

  await check('有归档库：按 world 列出来', () => {
    const { base, worlds, profiles } = emptyRoots();
    fs.mkdirSync(path.join(worlds, 'default'), { recursive: true });
    fs.writeFileSync(path.join(worlds, 'default', 'archive.sqlite'), 'sqlite-ish');
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles, home: base });
    assert.equal(value.archives.length, 1);
    assert.equal(value.archives[0].world, 'default');
    assert.ok(value.archives[0].size > 0);
    assert.match(value.hint, /archive\.sqlite|memory_find/);
  });

  await check('旧记忆库还在：报出来并指给 memory_migrate', () => {
    const { base, worlds, profiles } = emptyRoots();
    const legacy = path.join(base, '.dsh', 'memories');
    fs.mkdirSync(path.join(legacy, 'projects', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'MEMORY.md'), '- 一条旧记忆');
    fs.writeFileSync(path.join(legacy, 'projects', 'abc', 'KEY.md'), '- 项目关键记忆');
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles, home: base });
    assert.equal(value.found, true);
    assert.ok(value.legacy);
    assert.ok(value.legacy.files.includes('MEMORY.md'));
    assert.match(value.hint, /memory_migrate/);
  });

  await check('别家记忆插件：列出名字，不漏自己', () => {
    const { base, worlds, profiles } = apply();
    function apply() {
      const roots = emptyRoots();
      for (const name of ['dsh-memory-net', 'dsh-memory-yuan', 'not-a-plugin']) {
        const dir = path.join(roots.profiles, 'desktop', 'node_modules', name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
      }
      return roots;
    }
    const value = detectCompanionMemory({ worldsRoot: worlds, profilesRoot: profiles, home: base });
    const names = value.plugins.map((item) => item.name);
    assert.ok(names.includes('dsh-memory-net'));
    assert.ok(!names.includes('dsh-memory-yuan'));
    assert.ok(!names.includes('not-a-plugin'));
    assert.match(value.hint, /dsh-memory-net/);
  });

  await check('结构体检工具的 execute 带 coexist 字段', async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-lint-'));
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_lint.execute({}, { logger: { info() {} }, effect() {} });
    assert.equal(typeof value.coexist?.found, 'boolean');
    assert.equal(typeof value.coexist?.installed, 'boolean');
    assert.ok(Array.isArray(value.coexist?.plugins));
    assert.equal(typeof value.coexist?.legacyDir, 'string');
    assert.ok(Array.isArray(value.coexist?.legacyFiles));
  });

  await check('render：有共存时提示，没有时不出现', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-lint-'));
    const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
    const base = { ok: true, scanned: 3, flagged: 0, counts: { error: 0, warning: 0, info: 0 }, rows: [] };
    const withWorld = contentOf(
      tools.memory_lint.output.render({}, {
        ...base,
        coexist: {
          found: true,
          installed: true,
          version: '0.8.5',
          archives: [{ world: 'default' }],
          plugins: [{ name: 'dsh-world', version: '0.8.5', profile: 'desktop' }],
          legacyDir: '',
          legacyFiles: [],
          hint: '这台机器上还有别的记忆来源，vault 只读自己的 Markdown：\n- dsh-world 0.8.5，原话归档在 default 的 archive.sqlite。',
        },
      }),
    );
    assert.match(withWorld, /共存|别的记忆来源/);
    assert.match(withWorld, /dsh-world 0\.8\.5/);
    assert.match(withWorld, /default/);
    const without = contentOf(
      tools.memory_lint.output.render({}, {
        ...base,
        coexist: { found: false, installed: false, version: '', archives: [], plugins: [], legacyDir: '', legacyFiles: [], hint: '' },
      }),
    );
    assert.doesNotMatch(without, /共存|别的记忆来源/);
  });

  console.log(`\nselftest42：${pass} 通过，${fail} 失败`);
  if (fail) process.exitCode = 1;
}

main();
