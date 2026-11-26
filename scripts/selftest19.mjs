/**
 * 记忆星图的数据层自测：节点、边、权重、过滤、上限、标题词。
 *
 * 全部用内存里的假记忆，不碰真库（buildGraphOfVault 的用例才建临时 vault）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGraph, buildGraphOfVault, titleTerms, weightOf } from '../lib/graph.js';

let pass = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error?.message ?? error}`);
  }
}

let seq = 0;
function memory(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `mem_${seq}`;
  return {
    id,
    title: overrides.title ?? `记忆 ${id}`,
    type: overrides.type ?? 'knowledge',
    status: overrides.status ?? 'verified',
    tags: overrides.tags ?? [],
    importance: overrides.importance ?? 50,
    pinned: overrides.pinned ?? false,
    reads: overrides.reads ?? 0,
    updated: overrides.updated ?? '2026-11-20 10:00:00',
    dir: overrides.dir ?? 'Knowledge',
    core: overrides.core ?? '',
    ...overrides,
  };
}

console.log('记忆星图 · 数据层');

await check('空库：没有节点也没有边', () => {
  const graph = buildGraph([]);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.stats.nodes, 0);
});

await check('默认只画在用条目（verified / candidate），不画 superseded / disputed', () => {
  const graph = buildGraph([
    memory({ status: 'verified' }),
    memory({ status: 'candidate' }),
    memory({ status: 'superseded' }),
    memory({ status: 'disputed' }),
  ]);
  assert.deepEqual(graph.nodes.map((n) => n.status).sort(), ['candidate', 'verified']);
});

await check('includeArchived 才把归档条目也画出来', () => {
  const graph = buildGraph(
    [memory({ status: 'verified' }), memory({ status: 'superseded' }), memory({ status: 'disputed' })],
    { includeArchived: true },
  );
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.stats.statuses.superseded, 1);
});

await check('节点字段齐全，weight 按 importance / pinned / reads / hits 算', () => {
  const plain = memory({ importance: 60 });
  const star = memory({ importance: 60, pinned: true, reads: 5, id: 'mem_star' });
  const graph = buildGraph([plain, star], { hits: { mem_star: { hits: 7 } } });
  for (const node of graph.nodes) {
    for (const key of ['id', 'title', 'type', 'status', 'importance', 'pinned', 'reads', 'tags', 'updated', 'dir', 'weight']) {
      assert.ok(key in node, `节点缺字段 ${key}`);
    }
  }
  const a = graph.nodes.find((n) => n.id === plain.id);
  const b = graph.nodes.find((n) => n.id === 'mem_star');
  assert.equal(a.weight, 60);
  // 60 + 8(pinned) + 3×2(reads 封顶 3 次×2) + 7(hits) = 81
  assert.equal(b.weight, 81);
});

await check('weightOf 对越界 importance 做夹取', () => {
  assert.equal(weightOf({ importance: 999 }), 100);
  assert.equal(weightOf({ importance: -20 }), 0);
  assert.equal(weightOf({ importance: 'abc' }), 50);
});

await check('同一个 tag 的两条记忆连一条 tag 边', () => {
  const a = memory({ tags: ['星图'] });
  const b = memory({ tags: ['星图'] });
  const graph = buildGraph([a, b]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].kind, 'tag:星图');
  assert.equal(graph.edges[0].weight, 2);
});

await check('三条同 tag 两两连，共三条边', () => {
  const list = [memory({ tags: ['x'] }), memory({ tags: ['x'] }), memory({ tags: ['x'] })];
  const graph = buildGraph(list);
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.edges.every((edge) => edge.kind === 'tag:x'));
});

await check('泛标签（>20 条）不连线，避免把整张图连死', () => {
  const list = Array.from({ length: 21 }, () => memory({ tags: ['泛'] }));
  const graph = buildGraph(list);
  assert.equal(graph.edges.length, 0);
});

await check('标题词重合 ≥3 的连 topic 边，weight=交集数', () => {
  const a = memory({ title: '记忆插件收盘归拢星图' });
  const b = memory({ title: '记忆插件收盘归拢画法' });
  const graph = buildGraph([a, b]);
  const topic = graph.edges.filter((edge) => edge.kind === 'topic');
  assert.equal(topic.length, 1);
  assert.ok(topic[0].weight >= 3, `topic weight 应 ≥3，实际 ${topic[0].weight}`);
});

await check('英文词重合 2 个也连', () => {
  const a = memory({ title: 'Vault graph 设计' });
  const b = memory({ title: 'Vault graph 实现' });
  const graph = buildGraph([a, b]);
  const topic = graph.edges.filter((edge) => edge.kind === 'topic');
  assert.equal(topic.length, 1);
});

await check('只重合一个泛词不连（避免「记忆」把一切连起来）', () => {
  const a = memory({ title: '记忆' });
  const b = memory({ title: '记忆插件上线了' });
  const graph = buildGraph([a, b]);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'topic').length, 0);
});

await check('每节点最多留 maxEdgesPerNode 条边', () => {
  const list = [memory({ tags: ['中心'] })];
  for (let i = 0; i < 8; i += 1) list.push(memory({ tags: ['中心'] }));
  const graph = buildGraph(list, { maxEdgesPerNode: 3 });
  const degree = new Map();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  for (const [id, count] of degree) assert.ok(count <= 3, `${id} 度数 ${count} 超过上限`);
});

await check('maxNodes 截断到最重要的若干条', () => {
  const list = Array.from({ length: 10 }, (_, i) => memory({ importance: i * 10 }));
  const graph = buildGraph(list, { maxNodes: 3 });
  assert.equal(graph.nodes.length, 3);
  const kept = graph.nodes.map((n) => n.importance).sort((a, b) => b - a);
  assert.equal(kept[0], 90);
});

await check('stats 统计类型、状态、孤岛数', () => {
  const a = memory({ type: 'decision', tags: ['t'] });
  const b = memory({ type: 'decision', tags: ['t'] });
  const lonely = memory({ type: 'knowledge', title: '孤零零的一条' });
  const graph = buildGraph([a, b, lonely]);
  assert.equal(graph.stats.types.decision, 2);
  assert.equal(graph.stats.types.knowledge, 1);
  assert.equal(graph.stats.isolated, 1);
});

await check('titleTerms 会切英文词与中文 2 字片段，并去掉停用词', () => {
  const terms = titleTerms('Vault 文件是唯一的写入源');
  assert.ok(terms.has('vault'));
  assert.ok(terms.has('文件'));
  assert.ok(terms.has('写入'));
  assert.ok(!terms.has('的'));
  assert.ok(!terms.has('是'));
});

await check('buildGraphOfVault 会读 hits.json 给权重加成', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-yuan-graph-'));
  fs.mkdirSync(path.join(vault, '.dsh-memory'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '.dsh-memory', 'hits.json'),
    JSON.stringify({ mem_hit: { hits: 4, lastAt: '2026-11-22T00:00:00.000Z' } }),
    'utf8',
  );
  const list = [memory({ id: 'mem_hit', importance: 50 })];
  const graph = buildGraphOfVault(list, vault);
  assert.equal(graph.nodes[0].weight, 54);
});

await check('同一对节点的 tag 边与 topic 边是两条不同 kind 的边', () => {
  const a = memory({ title: '星图 graph 标签 测试', tags: ['星'] });
  const b = memory({ title: '星图 graph 标签 画法', tags: ['星'] });
  const graph = buildGraph([a, b]);
  const kinds = graph.edges.map((edge) => edge.kind).sort();
  assert.deepEqual(kinds, ['tag:星', 'topic']);
});

await check('边按 source/target 去重（同一 kind 只出一条）', () => {
  const a = memory({ tags: ['dup', 'dup'] });
  const b = memory({ tags: ['dup', 'dup'] });
  const graph = buildGraph([a, b]);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'tag:dup').length, 1);
});

console.log(`\n记忆星图：${pass} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
