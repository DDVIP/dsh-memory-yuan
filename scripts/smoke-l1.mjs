/**
 * L1 回归：不装插件，用假 context 测线索提取与命中。
 * 用法：node scripts/smoke-l1.mjs
 */
import assert from 'node:assert/strict';

import { buildL1, collectConversationTexts, grams, scoreByTokens, selectL1 } from '../lib/l1.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const near = {
  id: 'mem_near',
  title: '记忆插件的 L1 检索要按线索命中',
  type: 'project-state',
  status: 'verified',
  importance: 80,
  tags: ['记忆插件', 'L1', '检索'],
  core: '记忆插件每轮按对话里的线索检索，命中才注入一行摘要，条数有上限。',
  body: '记忆插件 L1 检索的设计与实现。',
};

const far = {
  id: 'mem_far',
  title: '音色是自己克隆的',
  type: 'knowledge',
  status: 'verified',
  importance: 75,
  tags: ['音色', '翻唱'],
  core: '音色基于本账号配音音色克隆，翻唱的唱是渊的音色。',
  body: '与记忆插件无关。',
};

const context = {
  agent: {
    session: {
      eventsSnapshot: [
        { type: 'step/start', data: { turn: 1, step: 0 } },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: '<system-reminder>这段是注入的，不算线索</system-reminder>' }] },
        },
        { type: 'user/message', data: { content: [{ type: 'text', text: '记忆插件的 L1 检索该怎么按线索命中？' }] } },
        { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出也不算线索' }] } } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: 'L1 是按线索检索记忆的。' }] } },
      ],
    },
  },
};

console.log('1) 对话文本提取');
const texts = collectConversationTexts(context);
check('只取用户说的话（assistant 不参与线索）', () => assert.equal(texts.length, 1));
check('用户原话在', () => assert.ok(texts.some((text) => text.includes('记忆插件的 L1 检索'))));
check('注入的 system-reminder 不进', () => assert.ok(!texts.some((text) => text.includes('这段是注入的'))));
check('tool 输出不进', () => assert.ok(!texts.some((text) => text.includes('工具输出也不算'))));
check('空 context 返回空数组', () => assert.deepEqual(collectConversationTexts(undefined), []));

console.log('2) 线索切词');
const tokens = grams(texts.join('\n'));
check('中文滑窗含「检索」', () => assert.ok(tokens.includes('检索')));
check('英文词能切（L1）', () => assert.ok(tokens.includes('l1')));
check('停用词被过滤', () => assert.ok(!tokens.includes('的')));

console.log('3) 打分');
const nearScore = scoreByTokens(near, tokens);
const farScore = scoreByTokens(far, tokens);
check('相关条目 hits >= 3', () => assert.ok(nearScore.hits >= 3, `hits=${nearScore.hits}`));
check('相关条目比无关条目分高', () => assert.ok(nearScore.score > farScore.score));
check('matched 有内容且 <= 6', () => assert.ok(nearScore.matched.length > 0 && nearScore.matched.length <= 6));

console.log('4) 注入段');
const text = buildL1([near, far], context);
check('有输出且带标题', () => {
  assert.ok(text.length > 0);
  assert.match(text, /^## 记忆 · L1/);
});
check('命中 near、不含 far', () => {
  assert.ok(text.includes('mem_near'));
  assert.ok(!text.includes('mem_far'));
});

console.log('5) 边界');
check('excludeIds 后返回空串', () => {
  assert.equal(buildL1([near, far], context, { excludeIds: new Set(['mem_near']) }), '');
});
check('无线索返回空串', () => {
  assert.equal(buildL1([near], { agent: { session: { eventsSnapshot: [] } } }), '');
});
check('maxItems 限条数', () => {
  const rows = selectL1([near, far], { ...context, agent: { session: { eventsSnapshot: context.agent.session.eventsSnapshot } } }, { maxItems: 1 }).rows;
  assert.ok(rows.length <= 1);
});

console.log(`\n全部通过（${passed} 项）`);
