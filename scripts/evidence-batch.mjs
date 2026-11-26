import fs from 'node:fs';
import path from 'node:path';

/**
 * 批量出处候选：对「已确认但没写出处」的条目，从会话存档里各找几条候选原话。
 * 只读、只出单子（写到 docs/evidence-candidates.md），不写 vault 里的任何记忆。
 *
 * 会话存档只扫一遍，把所有「用户说过的话」读进内存，再逐条匹配——比每条扫一遍快得多。
 */
import { keywordsOf, listSessionFiles, matchScore, readEvents, userTexts } from '../lib/evidence.js';
import { loadMemories, DEFAULT_VAULT } from '../lib/vault.js';
import { localDateStamp } from '../lib/stream.js';

const vaultPath = process.env.MEMORY_YUAN_VAULT || DEFAULT_VAULT;
const outPath = path.join(process.cwd(), 'docs', 'evidence-candidates.md');
const PER_MEMORY = 3;

console.log('读会话存档……');
const started = Date.now();
const sentences = [];
for (const meta of listSessionFiles()) {
  for (const event of readEvents(meta.file)) {
    for (const text of userTexts(event)) {
      if (text.length < 8) continue;
      sentences.push({
        sessionId: meta.sessionId,
        project: meta.project,
        at: new Date(Number(event.time) || 0).toISOString(),
        text: text.replace(/\s+/g, ' ').trim(),
      });
    }
  }
}
console.log(`  ${sentences.length} 句用户原话，${Date.now() - started}ms`);

const memories = loadMemories(vaultPath);
const targets = memories.filter((memory) => memory.status === 'verified' && !String(memory.evidence ?? '').trim());
console.log(`待补出处：${targets.length} 条`);

// 泛词降权：一个关键词如果在很多条记忆的标题里都出现，它就不是「这条」的特征。
const df = new Map();
for (const memory of memories) {
  for (const keyword of new Set(keywordsOf(memory.title))) df.set(keyword, (df.get(keyword) ?? 0) + 1);
}
const isGeneric = (keyword) => (df.get(keyword) ?? 0) > 8;

function stampOf(memory) {
  const raw = String(memory.created_at ?? memory.updated ?? '').trim();
  const parsed = Date.parse(raw.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 综合分：先看「非泛词的命中数」（这才是这条记忆的特征），时间接近只做小幅加成。 */
function rankOf(sentence, keywords, createdAt) {
  // 出处只可能是「这条记忆写下来之前」说的话；之后的对话是结果不是来源。
  if (createdAt && Date.parse(sentence.at) > createdAt + 10 * 60_000) return null;
  const score = matchScore(sentence.text, keywords);
  if (score.hits < 2) return null;
  const specific = score.keywords.filter((keyword) => !isGeneric(keyword));
  if (!specific.length) return null; // 只命中泛词 = 谁都能对上，不算候选
  // 长句命中多词不代表就是出处：按「特征词命中 / 句长」压一下。
  let rank = specific.length + Math.min(1.5, specific.length / Math.max(20, sentence.text.length / 40));
  if (createdAt) {
    const gapHours = (createdAt - Date.parse(sentence.at)) / 36e5;
    if (gapHours <= 12) rank += 1;
    else if (gapHours <= 48) rank += 0.5;
  }
  return { ...score, rank, specific };
}

const rows = [];
for (const memory of targets) {
  const keywords = keywordsOf(memory.title);
  const createdAt = stampOf(memory);
  const scored = [];
  for (const sentence of sentences) {
    const ranked = rankOf(sentence, keywords, createdAt);
    if (!ranked) continue;
    scored.push({ ...sentence, ...ranked });
  }
  scored.sort((a, b) => b.rank - a.rank || b.hits - a.hits || (a.at < b.at ? 1 : -1));
  rows.push({ memory, keywords, candidates: scored.slice(0, PER_MEMORY), total: scored.length });
}

const withHits = rows.filter((row) => row.candidates.length).length;
console.log(`有候选：${withHits} 条 / 无候选：${rows.length - withHits} 条`);

const lines = [
  `# 出处候选（${localDateStamp()}）`,
  '',
  `从会话存档（${sentences.length} 句用户原话）里回溯「已确认但没写出处」的记忆。**一条都没写回 vault**，确认哪条对再点详情页「找出处」或直接改文件。`,
  '',
  `- 待补：${rows.length} 条`,
  `- 找到候选：${withHits} 条`,
  `- 没找到：${rows.length - withHits} 条`,
  '',
];
for (const row of rows) {
  lines.push(`## ${row.memory.title}`, '');
  lines.push(`\`${row.memory.id}\` · ${row.memory.type} · 关键词：${row.keywords.slice(0, 6).join('、')}`);
  if (!row.candidates.length) {
    lines.push('', '没有候选：标题里的词在用户说过的话里没同时出现两次。可以在详情页手写出处。');
  } else {
    lines.push('');
    for (const candidate of row.candidates) {
      lines.push(`- ${candidate.at} · 会话 ${candidate.sessionId.replace(/^session-/, '').slice(0, 8)} · 命中 ${candidate.hits}：${candidate.text.slice(0, 90)}`);
    }
  }
  lines.push('');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
console.log(`写到 ${outPath}`);
for (const row of rows.slice(0, 5)) {
  console.log(`- ${row.memory.title.slice(0, 24)}：${row.candidates[0]?.text.slice(0, 50) ?? '（无候选）'}`);
}
