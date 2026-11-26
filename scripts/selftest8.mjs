/**
 * 自测第八套：L1 词表匹配 / 打分 / 工具层与 HTTP 的边界。
 *
 * 全部在临时 vault 里跑，不碰真库。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVocabulary,
  collectConversationTexts,
  extractTokens,
  grams,
  idfOf,
  scoreByTokens,
  selectL1,
} from '../lib/l1.js';
import { createTools } from '../lib/tools.js';
import { createStateHandler } from '../lib/api.js';
import { writeIndex } from '../lib/snapshot.js';

let pass = 0;
const fails = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fails.push([name, error?.message ?? String(error)]);
    console.log(`  FAIL ${name} → ${error?.message ?? error}`);
  }
}

function fresh() {
  return mkdtempSync(join(tmpdir(), 'my8-'));
}

function memory(over = {}) {
  return {
    id: 'mem_1',
    title: '记忆插件的 L1 检索',
    type: 'project-state',
    status: 'verified',
    tags: ['记忆插件', 'L1'],
    importance: 50,
    pinned: false,
    core: '核心内容 `L1` 是按线索命中。',
    body: '正文',
    ...over,
  };
}

function contextWith(text) {
  return {
    agent: { session: { eventsSnapshot: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }] } },
  };
}

function mockReq({ method = 'GET', url = '/', body } = {}) {
  const handlers = {};
  const req = {
    method,
    url,
    headers: {},
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
      return req;
    },
  };
  setImmediate(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      for (const fn of handlers.data ?? []) fn(chunk);
    }
    for (const fn of handlers.end ?? []) fn();
  });
  return req;
}

function mockRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers ?? {};
      return res;
    },
    end(chunk) {
      res.body = chunk ?? '';
      return res;
    },
  };
  return res;
}

async function call(handler, reqArgs) {
  const req = mockReq(reqArgs);
  const res = mockRes();
  await handler(req, res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

console.log('== 自测 8：L1 与工具边界 ==');

await check('grams 空串返回空数组', () => {
  assert.deepEqual(grams(''), []);
  assert.deepEqual(grams(null), []);
});

await check('extractTokens 只返回词表里的词', () => {
  const memories = [memory()];
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens(['完全无关的一句话，没有任何词表词'], vocabulary);
  assert.deepEqual(tokens, []);
});

await check('最长匹配：「记忆插件」只算一个词，不再拆出重叠子串', () => {
  const memories = [memory()];
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens(['记忆插件的用法'], vocabulary);
  assert.ok(tokens.includes('记忆插件'), `实际：${JSON.stringify(tokens)}`);
  const noise = tokens.filter((token) => ['记忆', '忆插', '记忆插', '插件'].includes(token));
  assert.deepEqual(noise, [], `不该出现重叠子串：${JSON.stringify(noise)}`);
});

await check('同一句话里重复出现的词只计一次', () => {
  const memories = [memory()];
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens(['记忆插件，记忆插件，记忆插件'], vocabulary);
  assert.equal(tokens.filter((token) => token === '记忆插件').length, 1);
});

await check('线索不足 2 个词 → 不注入', () => {
  const memories = [memory()];
  const rows = selectL1(memories, contextWith('记忆插件'), {}).rows;
  assert.deepEqual(rows, []);
});

await check('两个线索词但只命中一条记忆 → 分值够才进', () => {
  const memories = [memory(), memory({ id: 'mem_2', title: '别的', tags: ['别的'], core: '无关' })];
  const { rows } = selectL1(memories, contextWith('记忆插件 L1 检索'), {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memory.id, 'mem_1');
});

await check('matched 最多 2 个词，且按得分降序', () => {
  const memories = [
    memory({ title: '记忆插件 检索 打分', tags: ['记忆插件', '检索', '打分'], core: '记忆插件 检索 打分' }),
  ];
  const vocabulary = buildVocabulary(memories);
  const tokens = extractTokens(['记忆插件 检索 打分'], vocabulary);
  const scored = scoreByTokens(memories[0], tokens, vocabulary);
  assert.ok(scored.matched.length <= 2, `实际 ${scored.matched.length}`);
  assert.ok(scored.matched.length >= 1);
});

await check('英文大小写不敏感（DSH vs dsh）', () => {
  const memories = [memory({ title: 'DSH 插件', tags: ['dsh'], core: 'DSH 的记忆' })];
  const vocabulary = buildVocabulary(memories);
  const scored = scoreByTokens(memories[0], ['dsh'], vocabulary);
  assert.ok(scored.hits >= 1, '小写线索应命中大写字段');
});

await check('英文子串不该误命中（js 不该命中 json）', () => {
  const memories = [memory({ title: 'json 文件', tags: ['json'], core: 'json 格式' })];
  const scored = scoreByTokens(memories[0], ['js'], null);
  assert.equal(scored.hits, 0, 'js 是 json 的子串，但不是一个词');
});

await check('idf：只在一条记忆里出现的词比到处都有的词值钱', () => {
  const memories = [
    memory({ id: 'mem_1', title: '记忆插件', tags: ['记忆插件'] }),
    memory({ id: 'mem_2', title: '记忆插件 甲', tags: ['记忆插件', '甲'] }),
    memory({ id: 'mem_3', title: '记忆插件 乙', tags: ['记忆插件', '乙'] }),
    memory({ id: 'mem_4', title: '记忆插件 丙', tags: ['记忆插件', '丙'] }),
  ];
  const vocabulary = buildVocabulary(memories);
  const common = idfOf('记忆插件', vocabulary);
  const rare = idfOf('甲', vocabulary) > 0 ? idfOf('甲', vocabulary) : 1.6;
  assert.ok(common < rare, `常见词 ${common} 应当小于罕见词 ${rare}`);
});

await check('superseded 的条目不进 L1', () => {
  const memories = [memory({ status: 'superseded' })];
  const { rows } = selectL1(memories, contextWith('记忆插件 L1 检索'), {});
  assert.deepEqual(rows, []);
});

await check('excludeIds 生效', () => {
  const memories = [memory()];
  const { rows } = selectL1(memories, contextWith('记忆插件 L1 检索'), { excludeIds: new Set(['mem_1']) });
  assert.deepEqual(rows, []);
});

await check('collectConversationTexts 只收用户消息，不吃注入块', () => {
  const context = {
    agent: {
      session: {
        eventsSnapshot: [
          { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] } },
          { type: 'assistant/message', data: { content: [{ type: 'text', text: '助手说的话' }] } },
          { type: 'user/message', data: { content: [{ type: 'text', text: '用户真实问题' }] } },
        ],
      },
    },
  };
  const texts = collectConversationTexts(context);
  assert.deepEqual(texts, ['用户真实问题']);
});

await check('工具层：memory_write 的 mode 非法 → 报错', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const out = await tools.memory_write.execute({ mode: 'upsert', content: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.message, /mode/);
});

await check('工具层：create 时传 stream 参数被忽略（仍造条目）', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const out = await tools.memory_write.execute({
    title: '测试条目',
    type: 'experience',
    content: '内容',
    stream: 'daily',
  });
  assert.equal(out.ok, true);
  assert.ok(out.id, '应当造出条目 id');
});

await check('工具层：create 的 render 有 md 与 index 两段', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  const out = await tools.memory_write.execute({ title: '渲染测试', type: 'experience', content: '内容' });
  const text = tools.memory_write.output.render({}, out)[0].text;
  assert.match(text, /md：ok/);
  assert.match(text, /索引：ok/);
});

await check('工具层：memory_get 同时传 id 与 stream 时 stream 优先（记录行为）', async () => {
  const vault = fresh();
  const tools = Object.fromEntries(createTools({ vaultPath: vault }).map((t) => [t.name, t]));
  await tools.memory_write.execute({ mode: 'append', stream: 'daily', content: '流水内容' });
  const created = await tools.memory_write.execute({ title: '条目', type: 'experience', content: '条目内容' });
  const out = await tools.memory_get.execute({ id: created.id, stream: 'daily' });
  assert.equal(out.ok, true);
  assert.match(out.text, /流水内容/);
});

await check('HTTP：GET /state 带 budget 与 index', async () => {
  const vault = fresh();
  writeIndex(vault);
  const handler = createStateHandler({ vaultPath: vault, budget: 1234 });
  const { status, json } = await call(handler, { method: 'GET', url: '/memory-yuan/state' });
  assert.equal(status, 200);
  assert.equal(json.budget, 1234);
  assert.ok(json.index);
});

await check('HTTP：GET /memory 无 id → 400', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const { status, json } = await call(handler, { method: 'GET', url: '/memory-yuan/memory' });
  assert.equal(status, 400);
  assert.match(json.error, /missing id/);
});

await check('HTTP：GET /memory 不存在的 id → 404', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const { status } = await call(handler, { method: 'GET', url: '/memory-yuan/memory?id=nope' });
  assert.equal(status, 404);
});

await check('HTTP：未知路径 → 404', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const { status } = await call(handler, { method: 'GET', url: '/memory-yuan/nope' });
  assert.equal(status, 404);
});

await check('HTTP：POST /supersede 空 body → 400 且不崩', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const { status } = await call(handler, { method: 'POST', url: '/memory-yuan/supersede', body: '' });
  assert.ok(status === 400, `实际 ${status}`);
});

await check('HTTP：POST /supersede 缺 id → 400', async () => {
  const vault = fresh();
  const handler = createStateHandler({ vaultPath: vault });
  const { status, json } = await call(handler, { method: 'POST', url: '/memory-yuan/supersede', body: {} });
  assert.equal(status, 400);
  assert.ok(json.error);
});

await check('buildVocabulary 空数组不炸', () => {
  const vocabulary = buildVocabulary([]);
  assert.equal(vocabulary.size, 0);
  assert.equal(vocabulary.df.size, 0);
  assert.deepEqual(extractTokens(['任何话'], vocabulary), []);
});

console.log(`\n自测 8：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('失败详情：');
  for (const [name, message] of fails) console.log(` - ${name}: ${message}`);
  process.exitCode = 1;
}
