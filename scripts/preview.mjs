/**
 * 不装插件也能看效果：打印 L0 段全文 + 全部记忆表 + 一个假的 L1 命中。
 *
 * 用法：node scripts/preview.mjs [vaultPath]
 */
import { DEFAULT_VAULT, loadMemories } from '../lib/vault.js';
import { selectL0, renderL0 } from '../lib/l0.js';
import { selectL1, buildL1 } from '../lib/l1.js';

const vaultPath = process.argv[2] || process.env.MEMORY_YUAN_VAULT || DEFAULT_VAULT;
const memories = loadMemories(vaultPath);
const options = { vaultPath };

const selected = selectL0(memories, options);
const l0 = renderL0(selected, options);
const l0Chars = Array.from(l0).length;

console.log(`vault: ${vaultPath}`);
console.log(`记忆: ${memories.length} 条`);
console.log(`L0: ${selected.length} 条 / ${l0Chars} 字`);
console.log('─'.repeat(60));
console.log(l0 || '（空）');

const fakeContext = {
  agent: {
    session: {
      eventsSnapshot: [
        { type: 'step/start', data: { turn: 1, step: 0 } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>注入的东西不算</system-reminder>' }] } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '记忆插件的 L1 检索是不是该按线索命中？' }] } },
        { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '工具输出也不算' }] } } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: 'L1 是每轮按对话里的线索检索记忆。' }] } },
      ],
    },
  },
};

const excludeIds = new Set(selected.map((memory) => memory.id));
const l1 = buildL1(memories, fakeContext, { ...options, excludeIds });
const { rows } = selectL1(memories, fakeContext, { ...options, excludeIds });

console.log('─'.repeat(60));
console.log(`L1（假 context）: ${rows.length} 条 / ${Array.from(l1).length} 字`);
console.log(l1 || '（空）');

console.log('─'.repeat(60));
console.log('全部记忆：');
for (const memory of memories) {
  const flags = [memory.type, `imp${memory.importance}`, memory.pinned ? 'pinned' : '', memory.status !== 'active' ? memory.status : '']
    .filter(Boolean)
    .join(' ');
  console.log(`  [${flags}] ${memory.title}`);
}
