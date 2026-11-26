// 第 4 条：归档 / 恢复（memory_archive + POST /archive、POST /restore）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools.js';
import { createStateHandler } from '../lib/api.js';
import { loadMemories } from '../lib/vault.js';
import { createMemory, archiveMemory } from '../lib/store.js';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-archive-'));
const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));

const created = createMemory({
  vaultPath: vault,
  title: '归档测试：这条以后用不上了',
  type: 'knowledge',
  content: '内容留在这里，归档之后文件还在 Archive/。',
  tags: ['归档'],
});
assert.ok(created.ok, created.message);

const created2 = createMemory({
  vaultPath: vault,
  title: '恢复测试：另一条',
  type: 'experience',
  content: '第二条，用来测恢复。',
  tags: ['归档', '恢复'],
});
assert.ok(created2.ok, created2.message);

function memoryFileAt(rel) {
  return path.join(vault, rel);
}

await check('memory_archive 已注册（十三个工具）', () => {
  assert.ok(Array.isArray(createTools({ vaultPath: vault })));
  assert.ok(tools.memory_archive, '没有 memory_archive');
  assert.equal(Object.keys(tools).length, 13);
});

await check('归档把文件挪进 Archive/ 且原路径消失', async () => {
  const before = fs.existsSync(memoryFileAt('Knowledge')).valueOf();
  const result = await tools.memory_archive.execute({ id: created.id });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.action, 'archived');
  assert.ok(result.path.includes('Archive'), result.path);
  assert.ok(fs.existsSync(result.path));
  assert.equal(fs.existsSync(created.path), false);
});

await check('归档后不在 loadMemories 里（Archive 被跳过）', () => {
  const ids = loadMemories(vault).map((memory) => memory.id);
  assert.ok(!ids.includes(created.id));
});

await check('归档时留了备份', () => {
  const backups = path.join(vault, '.dsh-memory', 'backups');
  assert.ok(fs.existsSync(backups));
  const names = fs.readdirSync(backups);
  assert.ok(names.some((name) => name.includes('归档测试')));
});

await check('memory_archive restore=true 按 type 挪回 Knowledge/', async () => {
  const result = await tools.memory_archive.execute({ id: created.id, restore: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.action, 'restored');
  assert.ok(result.path.includes('Knowledge'), result.path);
  assert.ok(fs.existsSync(result.path));
  const ids = loadMemories(vault).map((memory) => memory.id);
  assert.ok(ids.includes(created.id));
});

await check('恢复后标题与类型没变', () => {
  const target = loadMemories(vault).find((memory) => memory.id === created.id);
  assert.equal(target.title, '归档测试：这条以后用不上了');
  assert.equal(target.type, 'knowledge');
});

await check('归档第二条（experience → Experiences 恢复）', async () => {
  const archived = await tools.memory_archive.execute({ id: created2.id });
  assert.equal(archived.ok, true, archived.message);
  const restored = await tools.memory_archive.execute({ id: created2.id, restore: true });
  assert.equal(restored.ok, true, restored.message);
  assert.ok(restored.path.includes('Experiences'), restored.path);
});

await check('归档不存在的 id → ok:false 且说清楚', async () => {
  const result = await tools.memory_archive.execute({ id: 'mem_19990101t000000_deadbeef' });
  assert.equal(result.ok, false);
  assert.match(result.message, /找不到/);
});

await check('恢复不存在的 id → ok:false 且说清楚', async () => {
  const result = await tools.memory_archive.execute({ id: 'mem_19990101t000000_deadbeef', restore: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /没有/);
});

await check('render：归档说「没删，随时能恢复」', () => {
  const blocks = tools.memory_archive.output.render({}, { ok: true, action: 'archived', id: 'x', title: '一条', path: '/v/Archive/a.md' });
  assert.match(blocks[0].text, /已归档/);
  assert.match(blocks[0].text, /随时能恢复/);
});

await check('render：恢复说「已经回到」', () => {
  const blocks = tools.memory_archive.output.render({}, { ok: true, action: 'restored', id: 'x', title: '一条', path: '/v/Knowledge/a.md' });
  assert.match(blocks[0].text, /已从归档恢复/);
});

// ---- HTTP 层 ----
const handler = createStateHandler({ vaultPath: vault, budget: 4000 });

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const handlers = {};
    const req = {
      method,
      url,
      on(event, fn) {
        handlers[event] = fn;
        return req;
      },
      destroy(error) {
        reject(error);
      },
    };
    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      writeHead(status) {
        res.statusCode = status;
        return res;
      },
      end(chunk) {
        res.body = chunk ?? '';
        resolve({ status: res.statusCode, body: res.body });
      },
    };
    handler(req, res).catch(reject);
    setImmediate(() => {
      if (body !== undefined && handlers.data) {
        handlers.data(Buffer.from(JSON.stringify(body)));
      }
      handlers.end?.();
    });
  });
}

await check('POST /archive 缺 id → 400', async () => {
  const result = await call('POST', '/memory-yuan/archive', {});
  assert.equal(result.status, 400);
});

await check('POST /archive 200 且文件到 Archive/，POST /restore 200 且回来', async () => {
  const archived = await call('POST', '/memory-yuan/archive', { id: created.id });
  assert.equal(archived.status, 200, archived.body);
  const restored = await call('POST', '/memory-yuan/restore', { id: created.id });
  assert.equal(restored.status, 200, restored.body);
  const ids = loadMemories(vault).map((memory) => memory.id);
  assert.ok(ids.includes(created.id));
});

await check('POST /archive 不存在的 id → 404', async () => {
  const result = await call('POST', '/memory-yuan/archive', { id: 'mem_19990101t000000_deadbeef' });
  assert.equal(result.status, 404);
});

await check('POST /restore 缺 id → 400', async () => {
  const result = await call('POST', '/memory-yuan/restore', {});
  assert.equal(result.status, 400);
});

await check('直接调 archiveMemory 也走备份 + 重名不覆盖', async () => {
  const again = createMemory({
    vaultPath: vault,
    title: '重名归档',
    type: 'knowledge',
    content: '第一次。',
    tags: ['归档'],
  });
  const one = archiveMemory(again.path, { vaultPath: vault });
  assert.equal(one.ok, true, one.message);
  const second = createMemory({
    vaultPath: vault,
    title: '重名归档',
    type: 'knowledge',
    content: '第二次，同名。',
    tags: ['归档'],
  });
  const two = archiveMemory(second.path, { vaultPath: vault });
  assert.equal(two.ok, true, two.message);
  assert.notEqual(one.path, two.path);
  assert.ok(fs.existsSync(one.path) && fs.existsSync(two.path));
});

console.log('');
if (failures.length) {
  console.log(`${failures.length} 失败：`);
  for (const item of failures) console.log(`  - ${item.name}: ${item.message}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${pass} 项）`);
}
