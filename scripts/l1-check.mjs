/**
 * L1 体检：拿 10 条真实提问跑一遍打分，看命中词里还有没有「处理」「下来」这类泛词。
 * 只读真实 vault，不写任何东西。
 */
import { buildVocabulary, filterByVocabulary, grams, scoreByTokens, selectL1 } from '../lib/l1.js';
import { loadMemories } from '../lib/vault.js';

const vault = 'C:/Users/17207/.dsh/worlds/default/memory';
const memories = loadMemories(vault);
const vocabulary = buildVocabulary(memories);

const questions = [
  '记忆插件的 L1 打分别再用字滑窗',
  '给记忆插件加流水追加',
  '小鱼唱歌用哪个音色',
  'B 站投稿要填什么',
  '抖音后台数据怎么抓',
  '房间里的五个文件是什么',
  'AstrBot 插件怎么装',
  '视频数据不用太在意',
  '交接和记忆插件更新了',
  '写记忆写错了怎么改',
];

/** 用户点名的泛词，不该出现在命中词里。 */
const NOISE = ['处理', '下来', '可以', '这个', '那个', '什么的', '了什'];

function userTurn(text) {
  return {
    agent: {
      session: {
        eventsSnapshot: [
          { type: 'user/message', data: { content: [{ type: 'text', text }] } },
        ],
      },
    },
  };
}

let flagged = 0;
for (const question of questions) {
  const { tokens, rows } = selectL1(memories, userTurn(question));
  const hits = rows.flatMap((row) => row.matched);
  const bad = hits.filter((token) => NOISE.some((noise) => token.includes(noise)));
  if (bad.length) flagged += 1;
  console.log(`\nQ: ${question}`);
  console.log(`   线索词：${tokens.join(' / ') || '(空)'}`);
  if (!rows.length) console.log('   命中：(空)');
  for (const row of rows) {
    console.log(`   - [${row.memory.type}] ${row.memory.title}`);
    console.log(`     命中：${row.matched.join('、') || '(无)'}  score=${row.score.toFixed(2)} hits=${row.hits}`);
  }
  if (bad.length) console.log(`   ⚠ 泛词混进命中：${bad.join('、')}`);
}

console.log(`\nvault ${memories.length} 条，词表 ${vocabulary.df.size} 个词；10 条里 ${flagged} 条命中泛词。`);
process.exitCode = flagged ? 1 : 0;
