// 体检「可以合并」的一键合并：POST /review/merge（留一条，另一条标废弃 + 归档）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { createMemory } from '../lib/store.js';
import { loadMemories } from '../lib/vault.js';
import { createStateHandler } from '../lib/api.js';

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

function vaultWithTwo() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-merge-ui-'));
  const keep = createMemory({
    vaultPath,
    type: 'knowledge',
    title: '插件注入写法',
    content: '往系统提示词注入内容只有一种写法生效：export const inject = [\'systemPrompt\']，再 ctx.effect 里 context。',
    tags: ['插件', '注入'],
    status: 'candidate',
  });
  const drop = createMemory({
    vaultPath,
    type: 'knowledge',
    title: '插件注入写法（旧版）',
    content: '往系统提示词注入内容只有一种写法生效：export const inject = [\'systemPrompt\']。',
    tags: ['插件', '注入'],
    status: 'candidate',
  });
  return { vaultPath, keep: keep.id, drop: drop.id };
}

async function withServer(vaultPath, fn) {
  const server = createServer(createStateHandler({ vaultPath }));
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(port, body, route = '/memory-yuan/review/merge') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  await check('缺 id：400', async () => {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-merge-ui-'));
    await withServer(vaultPath, async (port) => {
      const result = await post(port, { keep: 'x' });
      assert.equal(result.status, 400);
      assert.match(result.body.message, /keep 和 drop/);
    });
  });

  await check('keep 与 drop 相同：400', async () => {
    const { vaultPath, keep } = vaultWithTwo();
    await withServer(vaultPath, async (port) => {
      const result = await post(port, { keep, drop: keep });
      assert.equal(result.status, 400);
      assert.match(result.body.message, /不能是同一条/);
    });
  });

  await check('id 不存在：404', async () => {
    const { vaultPath, keep } = vaultWithTwo();
    await withServer(vaultPath, async (port) => {
      const result = await post(port, { keep, drop: 'mem_nope' });
      assert.equal(result.status, 404);
      assert.match(result.body.message, /找不到/);
    });
  });

  await check('正常合并：留 keep、drop 标废弃并进 Archive', async () => {
    const { vaultPath, keep, drop } = vaultWithTwo();
    await withServer(vaultPath, async (port) => {
      const result = await post(port, { keep, drop });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.kept.id, keep);
      assert.equal(result.body.dropped.id, drop);
      const left = loadMemories(vaultPath).map((memory) => memory.id);
      assert.ok(left.includes(keep), 'keep 应该还在库里');
      assert.ok(!left.includes(drop), 'drop 不该再出现在库里（应已归档）');
      const archiveDir = path.join(vaultPath, 'Archive');
      const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
      assert.ok(files.length >= 1, `Archive/ 里应该有文件，实际：${files.join(',')}`);
    });
  });

  await check('合并后 drop 的文件内容仍是原文（没删内容）', async () => {
    const { vaultPath, keep, drop } = vaultWithTwo();
    const before = loadMemories(vaultPath).find((memory) => memory.id === drop);
    await withServer(vaultPath, async (port) => {
      const result = await post(port, { keep, drop });
      assert.equal(result.status, 200);
    });
    const archiveDir = path.join(vaultPath, 'Archive');
    const names = fs.readdirSync(archiveDir);
    const hit = names.find((name) => name.includes(drop));
    assert.ok(hit, `Archive/ 里应该找得到 ${drop}，实际：${names.join(',')}`);
    const text = fs.readFileSync(path.join(archiveDir, hit), 'utf8');
    assert.match(text, /旧版/);
    assert.ok(before?.title?.includes('旧版'));
  });

  await check('合并后再合一次：404（drop 已经不在了）', async () => {
    const { vaultPath, keep, drop } = vaultWithTwo();
    await withServer(vaultPath, async (port) => {
      const first = await post(port, { keep, drop });
      assert.equal(first.status, 200);
      const again = await post(port, { keep, drop });
      assert.equal(again.status, 404);
    });
  });

  console.log(`\n${fail ? '✗' : '✓'} selftest47：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main();
