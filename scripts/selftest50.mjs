/**
 * 合并判据：除了「标签 ≥2 + 标题重合 50%」，正文高度重合也算（迁移进来的条目标题是整段话）。
 */
import assert from 'node:assert/strict';

import { bodySimilarity, buildReview } from '../lib/review.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}

const now = new Date('2026-11-27T12:00:00');
const memory = (overrides) => ({
  id: 'mem_a',
  type: 'knowledge',
  title: '标题',
  core: '正文',
  body: '正文',
  tags: [],
  status: 'verified',
  updated: '2026-11-26 10:00:00',
  dir: 'Knowledge',
  importance: 60,
  evidence: '有人写的',
  expires: '',
  reads: 0,
  ...overrides,
});

const review = (memories) => buildReview(memories, { now, hits: {}, ignored: new Map() });

check('正文完全一样的短文本，相似度够高', () => {
  const text = '记忆插件写入失败的时候要把错误指到真正失败的那一步';
  assert.ok(bodySimilarity(text, text) > 0.99);
});

check('正文只有一半像，相似度不到 0.6', () => {
  const a = '记忆插件写入失败的时候要把错误指到真正失败的那一步，不要报索引错误';
  const b = '星图节点位置要记住，刷新之后不能跳来跳去';
  assert.ok(bodySimilarity(a, b) < 0.2);
});

check('标签不同也能因为正文重合被收进来', () => {
  const text = '写入失败的报错要指到真正失败的那一步，不要把索引错报成写盘错，这条踩过一次';
  const result = review([
    memory({ id: 'a', title: '写入失败要指到真正失败的那一步', core: text, tags: ['写入'] }),
    memory({ id: 'b', title: '报错别报错环节', core: text, tags: ['报错'] }),
  ]);
  assert.equal(result.merge.length, 1);
  assert.equal(result.merge[0].suggest.action, 'merge');
  assert.match(result.merge[0].why, /正文重合/);
});

check('一个共同 tag 加正文一半重合也算', () => {
  const a = '记忆插件写入失败的时候要把错误指到真正失败的那一步，不要报索引错误，先看盘上的文件';
  const b = '记忆插件写入失败的时候要把错误指到真正失败的那一步，不要报索引错误';
  const result = review([
    memory({ id: 'a', title: '写失败的处理', core: a, tags: ['记忆插件'] }),
    memory({ id: 'b', title: '写失败的处理二', core: b, tags: ['记忆插件'] }),
  ]);
  assert.equal(result.merge.length, 1);
});

check('正文不像、标签不共享：不该合并', () => {
  const result = review([
    memory({ id: 'a', title: '流水带来源标记', core: '流水每一行都要带来源标记，比如家里或者工作', tags: ['流水'] }),
    memory({ id: 'b', title: '星图记住位置', core: '星图节点位置存 localStorage，刷新之后不跳', tags: ['星图'] }),
  ]);
  assert.equal(result.merge.length, 0);
});

check('不同类型不会合并', () => {
  const text = '同一段正文一个字都不差，但一条是知识一条是画像';
  const result = review([
    memory({ id: 'a', type: 'knowledge', core: text, tags: ['x'] }),
    memory({ id: 'b', type: 'profile', core: text, tags: ['x'] }),
  ]);
  assert.equal(result.merge.length, 0);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
