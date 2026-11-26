// 第 5 条：旧记忆库迁移（memory_migrate + POST /migrate）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../lib/tools.js';
import { createStateHandler } from '../lib/api.js';
import { loadMemories } from '../lib/vault.js';
import { applyMigration, guessType, normalizeKey, planMigration, splitEntries } from '../lib/migrate.js';

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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-migrate-'));
const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-legacy-'));
fs.mkdirSync(path.join(legacy, 'daily'), { recursive: true });
fs.mkdirSync(path.join(legacy, 'projects', 'proj1'), { recursive: true });

fs.writeFileSync(
  path.join(legacy, 'MEMORY.md'),
  ['# 长期', '', '[2026-11-01] 第一条事实：房间里的灯是暖色。', '', '§', '', '[2026-11-02] 第二条事实：写代码前先读 AGENTS.md。', '', '[summary:压缩掉的细节]'].join('\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(legacy, 'USER.md'),
  ['[2026-11-03] 偏好：结论先行，别客套。', '', '§', '', '[2026-11-04] 偏好：长篇动手前先说一声。'].join('\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(legacy, 'projects', 'proj1', 'KEY.md'),
  ['[2026-11-05] 项目关键事实：播放器用 qq-browser。', '', '§', '', '[2026-11-06] 项目关键事实：封面图默认叠立绘。'].join('\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(legacy, 'projects', 'proj1', 'MEMORY.md'),
  ['- 11-01 做了 A', '- 11-02 做了 B', '- 11-03 做了 C'].join('\n'),
  'utf8',
);
fs.writeFileSync(path.join(legacy, 'daily', '2026-11-01.md'), '- 11:00 旧日记第一行\n- 12:00 第二行\n', 'utf8');
fs.writeFileSync(path.join(legacy, 'daily', '2026-11-02.md'), '- 09:30 旧日记另一天\n', 'utf8');

const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
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
      if (body !== undefined && handlers.data) handlers.data(Buffer.from(JSON.stringify(body)));
      handlers.end?.();
    });
  });
}

await check('memory_migrate 已注册（十三个工具）', () => {
  assert.ok(tools.memory_migrate, '没有 memory_migrate');
  assert.equal(Object.keys(tools).length, 13);
});

await check('splitEntries 按 § 分条、剥日期与 summary', () => {
  const entries = splitEntries('[2026-11-01] 甲。\n\n§\n\n[2026-11-02] 乙。\n[summary:x]');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].content, '甲。');
  assert.equal(entries[0].date, '2026-11-01');
  assert.equal(entries[1].content, '乙。');
});

await check('guessType：USER.md → preference、KEY.md → knowledge、其余 experience', () => {
  assert.equal(guessType('/x/USER.md'), 'preference');
  assert.equal(guessType('C:\\x\\projects\\a\\KEY.md'), 'knowledge');
  assert.equal(guessType('/x/MEMORY.md'), 'experience');
});

await check('normalizeKey 去标点空白并小写', () => {
  assert.equal(normalizeKey('记忆 · 换底，测试！'), '记忆换底测试');
});

await check('planMigration 出计划：条目分开数、流水日志单独算、日记单独算', () => {
  const plan = planMigration({ root: legacy, vaultPath: vault });
  assert.equal(plan.ok, true, plan.message);
  assert.equal(plan.counts.entries, 6);
  assert.equal(plan.counts.journals, 2);
  assert.equal(plan.counts.logs, 1);
  assert.equal(plan.counts.skipped, 0);
});

await check('planMigration 不改任何文件', () => {
  assert.equal(loadMemories(vault).length, 0);
});

await check('dryRun 工具只给清单', async () => {
  const result = await tools.memory_migrate.execute({ root: legacy });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.dryRun, true);
  assert.equal(result.planned.entries, 6);
  assert.equal(result.written, undefined);
  assert.equal(loadMemories(vault).length, 0);
  assert.match(result.preview[0].title, /第一条事实/);
});

await check('render：dryRun 说「传 dryRun:false 真写」', () => {
  const blocks = tools.memory_migrate.output.render({}, { ok: true, dryRun: true, root: '/old', planned: { entries: 2, journals: 1, logs: 0, skipped: 0 }, preview: [{ title: '甲', type: 'experience' }] });
  assert.match(blocks[0].text, /预览/);
  assert.match(blocks[0].text, /dryRun:false/);
});

await check('真写：条目按 candidate 进 Inbox，日记与旧日志进 Archive/', async () => {
  const result = await tools.memory_migrate.execute({ root: legacy, dryRun: false });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.written.length, 6);
  const loaded = loadMemories(vault);
  assert.equal(loaded.length, 6);
  for (const memory of loaded) assert.equal(memory.status, 'candidate');
  assert.ok(fs.existsSync(path.join(vault, 'Archive', '旧日记', '2026-11-01.md')));
  assert.ok(fs.existsSync(path.join(vault, 'Archive', '旧日志', 'proj1.md')));
});

await check('迁移条目带「迁移」tag 与来源说明', () => {
  const memory = loadMemories(vault).find((item) => item.title.includes('第一条事实'));
  assert.ok(memory, '没找到迁过来的条目');
  assert.ok(memory.tags.includes('迁移'));
  assert.match(memory.raw, /迁移自旧记忆库/);
});

await check('再跑一次：全部跳过（同标题 / 日记已迁）', () => {
  const plan = planMigration({ root: legacy, vaultPath: vault });
  assert.equal(plan.counts.entries, 0);
  assert.equal(plan.skipped.length, 6);
});

await check('dryRun 的第二遍：日记与日志也报「已经迁过了」', async () => {
  const result = await tools.memory_migrate.execute({ root: legacy, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.written.length, 0);
  assert.ok(result.skipped.some((item) => /已经迁过/.test(item.reason)));
});

await check('旧库不存在 → ok:false 说清楚路径', async () => {
  const result = await tools.memory_migrate.execute({ root: 'C:/__mem_yuan_no_such_legacy__', dryRun: true });
  assert.equal(result.ok, false);
  assert.match(result.message, /旧库不存在/);
});

await check('applyMigration 自己也会拒绝坏计划', () => {
  const result = applyMigration({ ok: false, message: '坏的' });
  assert.equal(result.ok, false);
});

await check('POST /migrate dryRun 200 且没写东西', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-migrate2-'));
  const freshTools = createTools({ vaultPath: fresh });
  const result = await call('POST', '/memory-yuan/migrate', { root: legacy, dryRun: true });
  assert.equal(result.status, 200, result.body);
  const body = JSON.parse(result.body);
  assert.equal(body.dryRun, true);
  assert.equal(loadMemories(fresh).length, 0);
});

await check('POST /migrate 旧库不存在 → 400', async () => {
  const result = await call('POST', '/memory-yuan/migrate', { root: 'C:/__mem_yuan_no_such_legacy__', dryRun: true });
  assert.equal(result.status, 400);
});

console.log('');
if (failures.length) {
  console.log(`${failures.length} 失败：`);
  for (const item of failures) console.log(`  - ${item.name}: ${item.message}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过（${pass} 项）`);
}
