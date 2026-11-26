// 第五轮（补充）：专攻 frontmatter 与文件名的刁钻输入——分隔符、超长、特殊字符、自指。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadMemories, parseFrontmatter, readMemoryFile } from '../lib/vault.js';
import { createMemory, supersedeMemory, slugify, TYPE_DIRS } from '../lib/store.js';
import { searchMemories } from '../lib/search.js';

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    console.log(`  ✓ ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  } catch (error) {
    failures.push({ name, message: error?.message ?? String(error) });
    console.log(`  ✗ ${name} → ${error?.message ?? error}`);
  }
}
function freshVault(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `my5-${tag}-`));
}
const vault = freshVault('fm');

console.log('【1】title 的刁钻输入');
await check('title 含 --- 分隔符：写进去读回来还是同一句', () => {
  const title = '分隔符 --- 在标题里 --- 不该切断 frontmatter';
  const r = createMemory({ vaultPath: vault, title, type: 'knowledge', content: 'x' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  assert.equal(m?.title, title);
  return { ok: true };
});
await check('title 500 字：文件名被截断但记忆完好', () => {
  const title = '超长标题'.repeat(125);
  const r = createMemory({ vaultPath: vault, title, type: 'knowledge', content: 'x' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { titleLen: title.length, filenameLen: path.basename(r.path).length, roundTrip: m?.title === title };
});
await check('title 全是空白：拒绝而不是写出无标题记忆', () => {
  const r = createMemory({ vaultPath: vault, title: '   \n\t  ', type: 'knowledge', content: 'x' });
  return { ok: r.ok, message: r.message };
});
await check('空 content：允许还是拒绝（行为记录）', () => {
  const r = createMemory({ vaultPath: vault, title: '空正文', type: 'knowledge', content: '' });
  return { ok: r.ok, message: r.message };
});

console.log('\n【2】tags / content 的特殊字符');
await check('tags 含换行、引号、冒号、逗号：读回完全一致', () => {
  const tags = ['换\n行', '有"引号"', '有:冒号', '有,逗号', "有'单引号'"];
  const r = createMemory({ vaultPath: vault, title: 'tags 特殊字符', type: 'knowledge', content: 'x', tags });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  assert.deepEqual(m?.tags, tags);
  return m?.tags;
});
await check('content 以 --- 开头、正文里还有 ## 核心内容：不串段', () => {
  const content = '---\n这不是 frontmatter\n---\n\n## 核心内容\n\n真正的核心。';
  const r = createMemory({ vaultPath: vault, title: '正文里有分隔符', type: 'knowledge', content });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { bodyHasAll: String(m?.body ?? '').includes('这不是 frontmatter'), core: m?.core };
});
await check('content 里有 --- 单独一行：body 不被截断', () => {
  const content = '第一段\n\n---\n\n第二段';
  const r = createMemory({ vaultPath: vault, title: '正文单独横线', type: 'knowledge', content });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { hasSecond: String(m?.body ?? '').includes('第二段') };
});

console.log('\n【3】类型目录与 slug');
await check('type=project-state：落在 Projects/State 下、读回 type 一致', () => {
  const r = createMemory({ vaultPath: vault, title: '项目状态一条', type: 'project-state', content: 'x' });
  const dir = path.basename(path.dirname(r.path));
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { dir, expected: TYPE_DIRS['project-state'], type: m?.type };
});
await check('slugify 全非法字符：文件名不为空', () => {
  const s = slugify('///\\\\:*?"<>|');
  return { slug: JSON.stringify(s) };
});
await check('文件名里含空格与括号（Windows 允许）能正常读写', () => {
  const r = createMemory({ vaultPath: vault, title: '括号 (测试) 与 空格', type: 'knowledge', content: 'x' });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { ok: m?.title === '括号 (测试) 与 空格', file: path.basename(r.path) };
});

console.log('\n【4】supersede 的自指与重复');
await check('supersedes 指向自己：不会把新写入的这条标成 superseded', () => {
  const r = createMemory({ vaultPath: vault, title: '自指取代', type: 'knowledge', content: 'x' });
  const again = createMemory({ vaultPath: vault, title: '自指取代 2', type: 'knowledge', content: 'y', id: r.id });
  const m = loadMemories(vault).find((x) => x.id === r.id);
  return { created: again.ok, status: m?.status, note: again.message };
});
await check('同一条被两次 supersede：正文不动、superseded_by 记最新、旧值进 previous_', () => {
  const old = createMemory({ vaultPath: vault, title: '被取代两次', type: 'knowledge', content: '正文必须保留' });
  const bodyBefore = readMemoryFile(old.path)?.body;
  supersedeMemory(old.path, 'mem_first', { now: new Date('2026-11-22T10:00:00Z') });
  supersedeMemory(old.path, 'mem_second', { now: new Date('2026-11-22T11:00:00Z') });
  const raw = fs.readFileSync(old.path, 'utf8');
  const bodyAfter = readMemoryFile(old.path)?.body;
  return {
    bodySame: bodyBefore === bodyAfter,
    by: /superseded_by:\s*(\S+)/.exec(raw)?.[1],
    previous: /previous_superseded_by:\s*(\S+)/.exec(raw)?.[1],
    status: /status: (\w+)/.exec(raw)?.[1],
  };
});

console.log('\n【5】解析器细节');
await check('frontmatter 未知字段：不丢、不崩', () => {
  const dir = path.join(vault, 'Knowledge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'unknown.md'), '---\nid: mem_unknown\ntype: knowledge\nstatus: active\ntitle: 未知字段\ncustom_field: 保留我\n---\n\n## 核心内容\n\nx\n', 'utf8');
  const m = loadMemories(vault).find((x) => x.id === 'mem_unknown');
  const fm = parseFrontmatter(fs.readFileSync(path.join(dir, 'unknown.md'), 'utf8'));
  return { found: Boolean(m), custom: fm?.custom_field ?? fm?.data?.custom_field };
});
await check('pinned: yes / importance: "85" 的容错（行为记录）', () => {
  const dir = path.join(vault, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'loose.md'), '---\nid: mem_loose\ntype: knowledge\nstatus: active\ntitle: 松散值\npinned: yes\nimportance: "85"\n---\n\n## 核心内容\n\nx\n', 'utf8');
  const m = loadMemories(vault).find((x) => x.id === 'mem_loose');
  return { pinned: m?.pinned, importance: m?.importance };
});
await check("YAML 单引号里的 '' 还原成一个单引号", () => {
  const dir = path.join(vault, 'Knowledge');
  fs.writeFileSync(path.join(dir, 'single.md'), "---\nid: mem_single\ntype: knowledge\nstatus: active\ntitle: '单引号 it''s'\n---\n\n## 核心内容\n\nx\n", 'utf8');
  const m = loadMemories(vault).find((x) => x.id === 'mem_single');
  assert.equal(m?.title, "单引号 it's");
  return { title: m?.title };
});
await check('检索时 title 命中的条目排在只有 body 命中的前面', () => {
  const a = createMemory({ vaultPath: vault, title: '关键词在标题里', type: 'knowledge', content: '无关' });
  const b = createMemory({ vaultPath: vault, title: '标题无关', type: 'knowledge', content: '关键词在正文里' });
  const rows = searchMemories(loadMemories(vault), { query: '关键词' });
  return { order: rows.map((r) => r.memory.id), titleFirst: rows[0]?.memory.id === a.id, bodyAlso: rows.some((r) => r.memory.id === b.id) };
});

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(` ✗ ${f.name}: ${f.message}`);
  process.exitCode = 1;
}
