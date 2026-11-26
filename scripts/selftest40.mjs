// 第 6 条（敏感内容）：扫描 + 写入提醒 + 结构体检。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeSensitive, scanSensitive } from '../lib/sensitive.js';
import { lintVault } from '../lib/structure.js';
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

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-sensitive-'));
}

function writeMd(vault, rel, body) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const fakeCtx = () => ({ logger: { info() {}, warn() {}, error() {} }, effect() {} });

const contentOf = (value) => {
  const parts = Array.isArray(value) ? value : [value];
  return parts.map((part) => part?.reply?.text ?? part?.text ?? part?.content ?? '').join('\n');
};

async function main() {
  await check('扫得到 api key 赋值', () => {
    const hits = scanSensitive('配置里写 api_key = sk-abcdefghijklmnopqrstuvwxyz123456');
    assert.ok(hits.length >= 1);
    assert.ok(hits.some((hit) => hit.kind === 'knownPrefix' || hit.kind === 'apiKey'));
    assert.ok(hits.every((hit) => !hit.excerpt.includes('abcdefghijklmnopqrstuvwxyz')));
  });

  await check('扫得到 password 赋值', () => {
    const hits = scanSensitive('password: correctHorseBattery9');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, 'apiKey');
  });

  await check('扫得到私钥块', () => {
    const hits = scanSensitive('前面\n-----BEGIN RSA PRIVATE KEY-----\n后面');
    assert.ok(hits.some((hit) => hit.kind === 'privateKey'));
  });

  await check('扫得到 Bearer 与身份证', () => {
    const hits = scanSensitive('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n身份证 110101199003071234');
    assert.ok(hits.some((hit) => hit.kind === 'bearer'));
    assert.ok(hits.some((hit) => hit.kind === 'idCard'));
  });

  await check('正常技术讨论不误报', () => {
    const hits = scanSensitive('密码不能写进记忆，建议用环境变量；token 概念很重要。');
    assert.equal(hits.length, 0);
  });

  await check('脱敏：不原样回显', () => {
    const [hit] = scanSensitive('ghp_' + 'a'.repeat(30));
    assert.ok(hit.excerpt.includes('***'));
    assert.ok(!hit.excerpt.includes('a'.repeat(30)));
  });

  await check('describeSensitive 说人话', () => {
    const text = describeSensitive([{ kind: 'apiKey', label: 'API key / token 赋值', line: 3, excerpt: 'api_k***1234' }]);
    assert.match(text, /第 3 行/);
    assert.match(text, /明文/);
  });

  await check('memory_write 返回 sensitive 且正文照样写进去（只提醒不拦）', async () => {
    const vaultPath = tmpVault();
    const tools = Object.fromEntries(createTools({ vaultPath }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_write.execute(
      {
        type: 'knowledge',
        title: '测试：密钥提醒',
        content: '把 key 记在这里：sk-abcdefghijklmnopqrstuvwxyz123456',
        status: 'candidate',
      },
      fakeCtx(),
    );
    assert.equal(value.ok, true);
    assert.ok(Array.isArray(value.sensitive) && value.sensitive.length >= 1);
    const rendered = contentOf(tools.memory_write.output.render({}, value));
    assert.match(rendered, /敏感信息/);
    assert.match(rendered, /存「在哪」/);
  });

  await check('append 流水也扫', async () => {
    const vaultPath = tmpVault();
    const tools = Object.fromEntries(createTools({ vaultPath }).map((tool) => [tool.name, tool]));
    const value = await tools.memory_write.execute(
      { mode: 'append', stream: 'daily', content: '顺手记了 token=abcdefghijklmnop123456', by: '测试' },
      fakeCtx(),
    );
    assert.equal(value.ok, true);
    assert.ok(Array.isArray(value.sensitive) && value.sensitive.length >= 1);
  });

  await check('结构体检把敏感内容列成 info', () => {
    const vaultPath = tmpVault();
    writeMd(
      vaultPath,
      'Knowledge/k1.md',
      [
        '---',
        'id: mem_sensitive1',
        'type: knowledge',
        'status: verified',
        'title: 带密钥的条目',
        'created_at: 2026-11-20 10:00:00',
        'updated_at: 2026-11-20 10:00:00',
        'tags: [test]',
        'confidence: 0.8',
        'importance: 50',
        '---',
        '',
        '## 核心内容',
        '',
        '测试用的 key：sk-abcdefghijklmnopqrstuvwxyz123456。',
        '',
      ].join('\n'),
    );
    const report = lintVault(vaultPath, { max: 20 });
    const codes = report.rows.flatMap((row) => row.problems.map((problem) => problem.code));
    assert.ok(codes.includes('sensitive'), `codes=${codes.join(',')}`);
    const row = report.rows.find((item) => item.id === 'mem_sensitive1');
    const problem = row.problems.find((item) => item.code === 'sensitive');
    assert.equal(problem.level, 'info');
  });

  console.log(`\nselftest40：${pass} 通过，${fail} 失败`);
  if (fail) process.exitCode = 1;
}

main();
