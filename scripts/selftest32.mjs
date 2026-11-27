import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 旧版 Node 没有 zstd API（Node 20/22 的 zlib 里没有 zstdCompressSync），没法造样本，直接跳过。
if (typeof zlib.zstdCompressSync !== 'function') {
  console.log('（这个 Node 没有 zstd API，跳过会话存档用例）');
  process.exit(0);
}

/**
 * 出处回溯（self-test 32）：会话存档是按 zstd 帧拼接的，要能切开、能按行读、
 * 能只在用户真说的话里找线索，并且从 HTTP 层能拿到候选、写回 evidence。
 */
import {
  keywordsOf,
  matchScore,
  readEvents,
  userTexts,
  findEvidence,
  frameStarts,
  listSessionFiles,
  sessionsRoot,
} from '../lib/evidence.js';
import { createStateHandler } from '../lib/api.js';
import { createTools } from '../lib/tools.js';
import { writeIndex } from '../lib/snapshot.js';
import { loadMemories } from '../lib/vault.js';

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`);
  }
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个会话文件：若干帧，每帧若干行事件。 */
function writeSession(dir, project, sessionId, frames) {
  const target = path.join(dir, project, sessionId);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, 'session.v4.jsonl.zstd');
  const buffers = frames.map((lines) =>
    zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')),
  );
  fs.writeFileSync(file, Buffer.concat(buffers));
  return file;
}

function userEvent(seq, time, text) {
  return { type: 'user/message', seq, time, data: { content: [{ type: 'text', text }] } };
}

console.log('出处回溯');

await check('frameStarts 按魔数切帧', () => {
  const a = zlib.zstdCompressSync(Buffer.from('one'));
  const b = zlib.zstdCompressSync(Buffer.from('two'));
  const starts = frameStarts(Buffer.concat([a, b]));
  assert.equal(starts.length, 2);
  assert.equal(starts[0], 0);
  assert.equal(starts[1], a.length);
});

await check('readEvents 逐帧解压并按行拆', () => {
  const root = tmp('ev-');
  const file = writeSession(root, 'proj', 'session-a', [
    [{ type: 'session', id: 's1' }],
    [userEvent(1, 1000, '第一句'), userEvent(2, 2000, '第二句')],
  ]);
  const events = [...readEvents(file)];
  assert.equal(events.length, 3);
  assert.equal(events[2].data.content[0].text, '第二句');
});

await check('userTexts 只取 user/message 里的真话，注入块不算', () => {
  assert.deepEqual(userTexts(userEvent(1, 1, '记住这句')), ['记住这句']);
  assert.deepEqual(userTexts(userEvent(2, 1, '<system-reminder>忽略我')), []);
  assert.deepEqual(userTexts({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }), []);
  assert.deepEqual(userTexts(null), []);
});

await check('keywordsOf 切中文片段和英文词', () => {
  const words = keywordsOf('记忆星图已上线');
  assert.ok(words.includes('记忆'));
  assert.ok(words.includes('星图'));
  assert.ok(wordKeys('uniqueEnglishWord', ['uniqueenglishword']));
  function wordKeys(text, expected) {
    const list = keywordsOf(text);
    return expected.every((word) => list.includes(word));
  }
});

await check('matchScore 数命中词并返回命中的词', () => {
  const score = matchScore('记忆星图上线了，节点是记忆', ['记忆', '星图', '无关']);
  assert.equal(score.hits, 2);
  assert.deepEqual(score.keywords.slice().sort(), ['星图', '记忆'].sort());
});

await check('listSessionFiles 列出会话并按最新优先', () => {
  const root = tmp('ev-');
  const older = writeSession(root, 'p1', 'session-old', [[{ type: 'session' }]]);
  const newer = writeSession(root, 'p2', 'session-new', [[{ type: 'session' }]]);
  const now = Date.now();
  // 明确拉开 mtime，别靠「先写谁」——同毫秒写入时排序不稳。
  fs.utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
  fs.utimesSync(newer, new Date(now), new Date(now));
  const files = listSessionFiles(root);
  assert.equal(files.length, 2);
  assert.equal(files[0].sessionId, 'session-new');
});

await check('findEvidence 只在用户话里找、命中至少两个词', () => {
  const root = tmp('ev-');
  writeSession(root, 'proj', 'session-a', [
    [{ type: 'session' }],
    [
      userEvent(1, 1_700_000_000_000, '记忆星图要放进侧边栏，节点是记忆'),
      userEvent(2, 1_700_000_100_000, '今天天气不错，出去走走'),
      { type: 'assistant/message', data: { content: [{ type: 'text', text: '记忆星图记忆星图' }] } },
    ],
  ]);
  const hits = findEvidence({ title: '记忆星图上线' }, { root });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 'session-a');
  assert.ok(hits[0].quote.includes('侧边栏'));
  assert.ok(hits[0].hits >= 2);
});

await check('findEvidence 无会话目录时返回空', () => {
  const root = tmp('ev-');
  assert.deepEqual(findEvidence({ title: '记忆星图' }, { root }), []);
});

await check('findEvidence 标题线索不足时不做无意义扫描', () => {
  assert.deepEqual(findEvidence({ title: '的' }, { root: tmp('ev-') }), []);
});

// HTTP + 工具层
const vault = tmp('vault-');
const sessions = tmp('ev-');
writeSession(sessions, 'proj', 'session-z', [
  [userEvent(1, 1_700_000_200_000, '定下来吧：唯一写入源是 vault 文件，旧 memory 只留流水')],
]);
const { createMemory } = await import('../lib/store.js');
const created = createMemory({
  title: '唯一写入源：vault 文件',
  type: 'decision',
  content: '长期事实写 vault。',
  vaultPath: vault,
});
assert.equal(created.ok, true);
writeIndex(vault);

function mockRes() {
  const out = { status: 0, body: null };
  return {
    out,
    res: {
      writeHead(status) {
        out.status = status;
      },
      end(body) {
        out.body = JSON.parse(body);
      },
    },
  };
}

async function call(handler, method, url, body) {
  const { out, res } = mockRes();
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    on(event, fn) {
      if (event === 'data') chunks.forEach((chunk) => fn(chunk));
      if (event === 'end') fn();
      return req;
    },
  };
  await handler(req, res);
  return out;
}

const handler = createStateHandler({ vaultPath: vault });

await check('GET /evidence 缺 id 400', async () => {
  const out = await call(handler, 'GET', '/memory-yuan/evidence');
  assert.equal(out.status, 400);
});

await check('GET /evidence 找不到 404', async () => {
  const out = await call(handler, 'GET', '/memory-yuan/evidence?id=mem_nope');
  assert.equal(out.status, 404);
});

await check('GET /evidence 返回候选（用真实会话目录不可控，至少形状正确）', async () => {
  const out = await call(handler, 'GET', `/memory-yuan/evidence?id=${encodeURIComponent(created.id)}`);
  assert.equal(out.status, 200);
  assert.equal(out.body.id, created.id);
  assert.ok(Array.isArray(out.body.candidates));
});

await check('POST /evidence 写入 frontmatter 且 GET /memory 能读回', async () => {
  const out = await call(handler, 'POST', '/memory-yuan/evidence', {
    id: created.id,
    evidence: '2026-11-22 对话：「定下来吧」',
  });
  assert.equal(out.status, 200);
  const detail = await call(handler, 'GET', `/memory-yuan/memory?id=${encodeURIComponent(created.id)}`);
  assert.equal(detail.body.evidence, '2026-11-22 对话：「定下来吧」');
});

await check('POST /evidence 传空串能清空', async () => {
  const out = await call(handler, 'POST', '/memory-yuan/evidence', { id: created.id, evidence: '' });
  assert.equal(out.status, 200);
  const detail = await call(handler, 'GET', `/memory-yuan/memory?id=${encodeURIComponent(created.id)}`);
  assert.equal(detail.body.evidence, '');
});

await check('工具层注册十三个工具', () => {
  const tools = createTools({ vaultPath: vault });
  assert.equal(tools.length, 13);
});

console.log(`\n${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`);
  process.exit(1);
}
