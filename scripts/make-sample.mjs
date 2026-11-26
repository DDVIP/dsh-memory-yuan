#!/usr/bin/env node
// 生成一个「示例记忆库」，给开源仓库和第一次试用的人看（不含任何真实记忆）。
// 用法：node scripts/make-sample.mjs [输出目录]   默认 docs/sample-vault
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeMemory } from '../lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'docs', 'sample-vault');

const TYPE_DIRS = {
  decision: 'Decisions',
  preference: 'Preferences',
  experience: 'Experiences',
  knowledge: 'Knowledge',
  'project-state': 'Projects/State',
  profile: 'Profile',
};

// 12 条：六个类型都覆盖，标签有交叉（星图才有连线），有意留一条过期、一条候选、一条带出处。
const SAMPLE = [
  {
    type: 'decision',
    title: '先写一条，别在一个文件里堆三件事',
    importance: 92,
    pinned: true,
    tags: ['记忆', '写法', '原则'],
    content:
      '一条记忆只讲一件事。想改的时候新建一条、把旧的标成 superseded，别覆盖旧文件——这样能看出想法是怎么变的。',
    source: '这是一个示例条目，用来说明「一条一件事」的写法。',
    evidence: '示例库自带，不指向真实对话',
    status: 'verified',
  },
  {
    type: 'decision',
    title: '收盘只归拢当天流水，不自动改长期记忆',
    importance: 78,
    pinned: true,
    tags: ['记忆', '收盘', '流水'],
    content:
      '每天的收盘任务只把当天流水收成几句完整的话，写进当天的小结；配得上长期的写成 Inbox 候选，等人确认。',
    source: '示例条目：收盘任务的设计边界。',
    status: 'verified',
  },
  {
    type: 'preference',
    title: '说话先给结论，再给原因',
    importance: 88,
    pinned: true,
    tags: ['交流', '偏好'],
    content: '第一句就是答案；原因放后面，短句，不铺垫。技术问题里路径和报错原文照贴。',
    source: '示例条目：交流偏好。',
    status: 'verified',
  },
  {
    type: 'preference',
    title: '改别人的文件前先备份',
    importance: 70,
    pinned: false,
    tags: ['安全', '写法'],
    content: '任何覆盖写之前先留一份备份，出问题能退回去。备份只留最近几份，别无限堆。',
    source: '示例条目：写盘习惯。',
    status: 'verified',
  },
  {
    type: 'experience',
    title: '报错要指到真正失败的那一步',
    importance: 82,
    pinned: false,
    tags: ['调试', '报错'],
    content:
      '写盘成功、更新索引失败时，不要整条报「写入失败」——那会让人以为没写进去，然后重写一遍，库里出现两份。把两步分开说。',
    source: '示例条目：一次真实的误报。',
    evidence: '示例库自带',
    status: 'verified',
  },
  {
    type: 'experience',
    title: '猜不到时间就先查，别硬说「今天」',
    importance: 64,
    pinned: false,
    tags: ['时间', '调试'],
    content: '长会话里时间感知会漂：说到「今天/明天/现在」之前先取一次真实时间。',
    source: '示例条目：时间校准。',
    status: 'verified',
  },
  {
    type: 'knowledge',
    title: 'Markdown 的 frontmatter 只能写简单标量',
    importance: 66,
    pinned: false,
    tags: ['Markdown', '写法'],
    content:
      '解析器只认「key: value」和「key:」加缩进列表两种。值里有冒号、井号、引号就加引号，否则读回来会缺半截。',
    source: '示例条目：frontmatter 的坑。',
    status: 'verified',
  },
  {
    type: 'knowledge',
    title: '标签比正文更适合当检索线索',
    importance: 58,
    pinned: false,
    tags: ['检索', '记忆'],
    content: '标题和标签是「这条讲什么」的浓缩，正文是细节。按线索找的时候先看标签，成本最低。',
    source: '示例条目：检索策略。',
    status: 'candidate',
  },
  {
    type: 'project-state',
    title: '记忆插件这一轮在做什么',
    importance: 74,
    pinned: false,
    tags: ['记忆', '项目'],
    content: '把记忆从「只能通过工具读」换成「文件式、每轮注入几条、其余按线索检索」。',
    source: '示例条目：项目状态。',
    status: 'verified',
  },
  {
    type: 'project-state',
    title: '这个仓库的结构',
    importance: 52,
    pinned: false,
    tags: ['项目', '结构'],
    content:
      'index.js 注入与注册；lib/ 里是 vault 解析、三层注入、工具、HTTP、快照、体检；scripts/ 是测试与小工具。',
    source: '示例条目：仓库结构。',
    status: 'verified',
  },
  {
    type: 'profile',
    title: '这条记忆是为谁写的',
    importance: 80,
    pinned: false,
    tags: ['画像', '记忆'],
    content: '写记忆的时候想着「下次读它的人不知道现在发生了什么」，所以主语、时间、因果都要写清楚。',
    source: '示例条目：写作对象。',
    status: 'verified',
  },
  {
    type: 'decision',
    title: '这条已经过期，只用来演示「已过期」长什么样',
    importance: 40,
    pinned: false,
    tags: ['示例', '过期'],
    content: '当时对、后来错的东西会过期。过期的不再注入，体检单里会单列出来。',
    source: '示例条目：过期。',
    expires: '2026-01-01',
    status: 'verified',
  },
];

let written = 0;
for (const item of SAMPLE) {
  const dir = path.join(outDir, TYPE_DIRS[item.type]);
  fs.mkdirSync(dir, { recursive: true });
  const id = `mem_sample_${String(written + 1).padStart(2, '0')}`;
  const text = serializeMemory({
    id,
    title: item.title,
    type: item.type,
    content: item.content,
    source: item.source,
    tags: item.tags,
    importance: item.importance,
    pinned: item.pinned,
    confidence: 0.9,
    status: item.status ?? 'verified',
    evidence: item.evidence ?? '',
    expires: item.expires ?? '',
    reads: 0,
    createdAt: `2026-11-${String(10 + written).padStart(2, '0')} 20:00:00`,
  });
  const slug = item.title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  fs.writeFileSync(path.join(dir, `${slug}-${id}.md`), text, 'utf8');
  written += 1;
}

fs.writeFileSync(
  path.join(outDir, 'README.md'),
  '# 示例记忆库\n\n这是 `make-sample.mjs` 生成的 12 条示例记忆，用来演示目录结构、frontmatter 与星图的连线。\n不是真实记忆，可以随便改、随便删。\n',
  'utf8',
);
console.log(`已生成 ${written} 条示例记忆 → ${outDir}`);
