/**
 * 自测 27：记忆包导出 / 导入。
 *
 * 导出：目录 + MANIFEST（sha256/字节）+ README，不含 .dsh-memory；
 * 导入：默认 dry-run、先验 sha256（一个不符就零写入）、同名同内容跳过、同名不同内容另存不覆盖。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { exportBundle, importBundle, listBundleFiles, sha256Of } from '../lib/transfer.js';
import { createStateHandler } from '../lib/api.js';
import { createTools } from '../lib/tools.js';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-bundle-'));
const vault = path.join(tmp, 'vault');
fs.mkdirSync(path.join(vault, 'Decisions'), { recursive: true });
fs.mkdirSync(path.join(vault, 'Daily'), { recursive: true });
fs.mkdirSync(path.join(vault, '.dsh-memory'), { recursive: true });

const decision = '---\nid: mem_d1\ntype: decision\nstatus: verified\ntitle: 一条决策\nupdated_at: 2026-11-20 10:00:00\n---\n\n## 核心内容\n\n正文 A。\n';
fs.writeFileSync(path.join(vault, 'Decisions', 'd1.md'), decision, 'utf8');
fs.writeFileSync(path.join(vault, 'Daily', '2026-11-20.md'), '# 2026-11-20 流水\n\n- 10:00 一条流水\n', 'utf8');
fs.writeFileSync(path.join(vault, '.dsh-memory', 'index.json'), '{"entries":[]}', 'utf8');

const exportRoot = path.join(tmp, 'exports');

console.log('记忆包');

await check('导出生成目录、MANIFEST 与 README，计数正确', () => {
  const r = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(r.dir, 'MANIFEST.json')));
  assert.ok(fs.existsSync(path.join(r.dir, 'README.md')));
  assert.equal(r.counts.memories, 1);
  assert.equal(r.counts.daily, 1);
  assert.equal(r.files, 2);
});

await check('导出不含 .dsh-memory 运行态', () => {
  const r = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  assert.ok(!fs.existsSync(path.join(r.dir, '.dsh-memory')));
});

await check('MANIFEST 的 sha256 与文件内容一致', () => {
  const r = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, 'MANIFEST.json'), 'utf8'));
  for (const item of manifest.files) {
    const buffer = fs.readFileSync(path.join(r.dir, ...item.path.split('/')));
    assert.equal(sha256Of(buffer), item.sha256);
    assert.equal(buffer.length, item.bytes);
  }
});

await check('空库导出返回 ok:false', () => {
  const empty = path.join(tmp, 'empty-vault');
  fs.mkdirSync(empty, { recursive: true });
  const r = exportBundle(empty, { outRoot: exportRoot });
  assert.equal(r.ok, false);
});

await check('导入默认 dry-run：只报告，不落盘', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const target = path.join(tmp, 'vault2');
  fs.mkdirSync(target, { recursive: true });
  const r = importBundle(pack.dir, { vaultPath: target });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.written.length, 2);
  assert.equal(fs.existsSync(path.join(target, 'Decisions', 'd1.md')), false);
});

await check('dry-run:false 真写入且内容一致', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const target = path.join(tmp, 'vault3');
  fs.mkdirSync(target, { recursive: true });
  const r = importBundle(pack.dir, { vaultPath: target, dryRun: false });
  assert.equal(r.ok, true);
  assert.equal(r.written.length, 2);
  assert.equal(fs.readFileSync(path.join(target, 'Decisions', 'd1.md'), 'utf8'), decision);
});

await check('同名同内容跳过，不重复写', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const target = path.join(tmp, 'vault3');
  const r = importBundle(pack.dir, { vaultPath: target, dryRun: false });
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 2);
});

await check('同名不同内容另存 `.导入-<时间>`，不覆盖', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const target = path.join(tmp, 'vault4');
  fs.mkdirSync(path.join(target, 'Decisions'), { recursive: true });
  const original = '---\nid: mem_other\ntitle: 盘上已有的版本\n---\n\n本地内容。\n';
  fs.writeFileSync(path.join(target, 'Decisions', 'd1.md'), original, 'utf8');
  const r = importBundle(pack.dir, { vaultPath: target, dryRun: false });
  assert.equal(r.ok, true);
  assert.equal(r.conflicts.length, 1);
  assert.equal(fs.readFileSync(path.join(target, 'Decisions', 'd1.md'), 'utf8'), original);
  const renamed = fs.readdirSync(path.join(target, 'Decisions')).find((name) => name.includes('.导入-'));
  assert.ok(renamed, '应另存一份');
});

await check('MANIFEST 被篡改（sha 不符）时零写入', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const manifestFile = path.join(pack.dir, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files[0].sha256 = crypto.createHash('sha256').update('篡改').digest('hex');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');

  const target = path.join(tmp, 'vault5');
  fs.mkdirSync(target, { recursive: true });
  const r = importBundle(pack.dir, { vaultPath: target, dryRun: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
  assert.equal(fs.existsSync(path.join(target, 'Decisions')), false);
});

await check('缺 MANIFEST 时返回 ok:false', () => {
  const dir = path.join(tmp, 'no-manifest');
  fs.mkdirSync(dir, { recursive: true });
  const r = importBundle(dir, { vaultPath: path.join(tmp, 'vault6') });
  assert.equal(r.ok, false);
});

await check('包内路径带 .. 时被拒，零写入', () => {
  const pack = exportBundle(vault, { outRoot: exportRoot, now: new Date('2026-11-24T10:00:00Z') });
  const manifestFile = path.join(pack.dir, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files.push({ path: '../evil.md', sha256: sha256Of(Buffer.from('x')), bytes: 1 });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
  const target = path.join(tmp, 'vault7');
  fs.mkdirSync(target, { recursive: true });
  const r = importBundle(pack.dir, { vaultPath: target, dryRun: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((item) => item.path === '../evil.md'));
});

await check('listBundleFiles 只列 .md 且不含隐藏目录', () => {
  const files = listBundleFiles(vault);
  assert.deepEqual(files.sort(), ['Daily/2026-11-20.md', 'Decisions/d1.md']);
});

// ---- HTTP ----
const handler = createStateHandler({ vaultPath: vault });
const call = async (method, url, body) => {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {
    method,
    url,
    on(event, fn) {
      if (event === 'data') chunks.forEach((chunk) => fn(chunk));
      if (event === 'end') fn();
      return req;
    },
  };
  let status = 0;
  let text = '';
  const res = { writeHead(code) { status = code; }, end(payload) { text = payload; } };
  await handler(req, res);
  return { status, body: JSON.parse(text || '{}') };
};

await check('HTTP POST /export 返回目录', async () => {
  const r = await call('POST', '/memory-yuan/export', { outRoot: exportRoot });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(fs.existsSync(r.body.dir));
});

await check('HTTP POST /import 缺 bundle 返回 400', async () => {
  const r = await call('POST', '/memory-yuan/import', {});
  assert.equal(r.status, 400);
});

// ---- 工具层 ----
await check('memory_export / memory_import 形状与 render', async () => {
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((tool) => [tool.name, tool]));
  assert.ok(tools.memory_export && tools.memory_import);
  const exported = await tools.memory_export.execute({ outRoot: exportRoot });
  const text = tools.memory_export.output.render({}, exported)[0].text;
  assert.match(text, /已导出 \d+ 个文件到/);

  const imported = await tools.memory_import.execute({ bundle: exported.dir, dryRun: true });
  const preview = tools.memory_import.output.render({}, imported)[0].text;
  assert.match(preview, /预览（没有写任何文件）/);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
