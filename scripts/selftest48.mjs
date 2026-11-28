// 流水全文搜索：Daily/ 与 Projects/ 里按词找（只读）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { searchStreams } from '../lib/streamsearch.js';
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

function vaultWithStreams() {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-streams-'));
  fs.mkdirSync(path.join(vaultPath, 'Daily'), { recursive: true });
  fs.mkdirSync(path.join(vaultPath, 'Projects'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultPath, 'Daily', '2026-11-20.md'),
    ['- 09:10 [工作] 修了星图的拖拽', '- 14:20 [家里] 看了会儿视频', '- 21:00 [记忆插件] 收盘没跑成，原因：模型超时', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'Daily', '2026-11-21.md'),
    ['- 10:00 [工作] 改了星图的缩放', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'Daily', '2026-11-20.summary.md'),
    ['# 2026-11-20 收盘', '', '- 星图有进展。', ''].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultPath, 'Projects', '记忆插件.md'),
    ['- 2026-11-20 [工作] 星图上线了', '- 2026-11-21 [工作] 加了流水搜索', ''].join('\n'),
    'utf8',
  );
  return vaultPath;
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

async function main() {
  await check('空 query：ok=false 且有提示', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '   ' });
    assert.equal(result.ok, false);
    assert.match(result.message, /搜索词/);
  });

  await check('单词命中：日期/时间/来源都拆出来', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '星图' });
    assert.equal(result.ok, true);
    assert.ok(result.hits.length >= 2, `应该至少两条，实际 ${result.hits.length}`);
    const daily = result.hits.find((hit) => hit.kind === 'daily' && hit.date === '2026-11-20');
    assert.equal(daily.date, '2026-11-20');
    assert.equal(daily.time, '09:10');
    assert.equal(daily.by, '工作');
    const project = result.hits.find((hit) => hit.kind === 'project');
    assert.equal(project.project, '记忆插件');
  });

  await check('多词 AND：两个词都得在同一行', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '星图 缩放' });
    assert.equal(result.hits.length, 1);
    assert.match(result.hits[0].text, /缩放/);
  });

  await check('不扫收盘摘要 .summary.md', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '收盘' });
    assert.ok(result.hits.every((hit) => hit.file !== '2026-11-20.summary.md'), '不应命中摘要文件');
    assert.ok(result.hits.some((hit) => hit.text.includes('收盘没跑成')));
  });

  await check('limit 生效', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '星图', limit: 1 });
    assert.equal(result.hits.length, 1);
  });

  await check('date 过滤 from/to', () => {
    const vaultPath = vaultWithStreams();
    const result = searchStreams(vaultPath, { query: '星图', from: '2026-11-21' });
    assert.ok(result.hits.every((hit) => hit.kind === 'project' || hit.date >= '2026-11-21'));
  });

  await check('GET /streams 命中：200 + hits', async () => {
    const vaultPath = vaultWithStreams();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/streams?query=${encodeURIComponent('星图')}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.ok(body.hits.length >= 2);
    });
  });

  await check('GET /streams 没 query：400', async () => {
    const vaultPath = vaultWithStreams();
    await withServer(vaultPath, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/memory-yuan/streams`);
      assert.equal(response.status, 400);
    });
  });

  console.log(`\n${fail ? '✗' : '✓'} selftest48：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
}

main();
