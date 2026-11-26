// 记忆星图的数据层：节点=记忆条目，边=线索关联。
//
// 为什么用两种边：
// - tag 共现：人写记忆时给的标签，是最可信的「同一件事」信号；
// - 标题词共现：没打标签的条目靠词重叠连起来，避免星图碎成一地孤岛。
// 取代链（superseded_by）不进边：旧条目默认不显示，画出来只会是死链。

import { readHits } from './snapshot.js';

const LIVE_STATUSES = new Set(['verified', 'candidate']);

// 标题里做线索用的词：英文词 + 中文 2 字片段（与 review.js 的 titleTerms 同口径）
const EN_WORD = /[a-z][a-z0-9_]{1,}/g;
const CN_CHUNK = /[\u4e00-\u9fa5]+/g;

const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '都', '也', '就', '而', '并',
  '一个', '这个', '那个', '我们', '你们', '他们', '可以', '不要', '已经', '就是',
  '因为', '所以', '时候', '自己', '东西', '事情', '问题', '需要', '可能', '应该',
  '知道', '觉得', '以及', '或者', '而且', '不是', '没有', '还是', '这样', '那样',
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'are', 'not', 'but', 'its',
]);

export function titleTerms(title) {
  const out = new Set();
  const text = String(title ?? '').toLowerCase();
  for (const word of text.match(EN_WORD) ?? []) {
    if (word.length >= 2 && !STOP.has(word)) out.add(word);
  }
  for (const chunk of text.match(CN_CHUNK) ?? []) {
    if (chunk.length === 2) {
      if (!STOP.has(chunk)) out.add(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length - 1; i += 1) {
      const gram = chunk.slice(i, i + 2);
      if (!STOP.has(gram)) out.add(gram);
    }
  }
  return out;
}

function importanceOf(memory) {
  const n = Number(memory?.importance);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
}

/** 节点权重：重要性为主，pinned 加成，被读过/被命中过的再加一点。 */
export function weightOf(memory, hits = {}) {
  const hit = hits?.[memory?.id];
  const readBoost = Math.min(3, Number(memory?.reads) || 0) * 2;
  const hitBoost = Math.min(10, Number(hit?.hits) || 0);
  return Math.round(importanceOf(memory) + (memory?.pinned ? 8 : 0) + readBoost + hitBoost);
}

/**
 * 组装星图。
 * @param {Array} memories loadMemories 的结果
 * @param {{now?: Date, includeArchived?: boolean, hits?: Record<string, {hits:number}>, maxNodes?: number, maxEdgesPerNode?: number}} options
 */
export function buildGraph(memories, options = {}) {
  const {
    includeArchived = false,
    hits = {},
    maxNodes = 200,
    maxEdgesPerNode = 14,
    now = new Date(),
  } = options;

  const pool = (memories ?? []).filter((m) => m && m.id && (includeArchived || LIVE_STATUSES.has(m.status)));
  const chosen = [...pool]
    .sort((a, b) => weightOf(b, hits) - weightOf(a, hits) || String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
    .slice(0, Math.max(1, maxNodes));

  const nodes = chosen.map((m) => ({
    id: m.id,
    title: String(m.title ?? '(无标题)'),
    type: String(m.type ?? 'knowledge'),
    status: String(m.status ?? 'candidate'),
    importance: importanceOf(m),
    pinned: m.pinned === true,
    reads: Math.max(0, Number(m.reads) || 0),
    tags: (Array.isArray(m.tags) ? m.tags : []).map(String).filter(Boolean),
    updated: String(m.updated ?? ''),
    dir: String(m.dir ?? ''),
    weight: weightOf(m, hits),
  }));

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeMap = new Map();
  const addEdge = (a, b, weight, kind) => {
    if (a === b) return;
    const [source, target] = a < b ? [a, b] : [b, a];
    const key = `${kind}|${source}|${target}`;
    const prev = edgeMap.get(key);
    if (prev) prev.weight += weight;
    else edgeMap.set(key, { source, target, weight, kind });
  };

  // tag 共现：同一个 tag 下的条目两两相连。tag 太多（>12 条）时跳过——
  // 「记忆」这种泛标签全连会把星图连成一团，看不出结构。
  const byTag = new Map();
  for (const node of nodes) {
    for (const tag of new Set(node.tags)) {
      const list = byTag.get(tag) ?? [];
      list.push(node.id);
      byTag.set(tag, list);
    }
  }
  for (const [tag, list] of byTag) {
    if (list.length < 2 || list.length > 12) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) addEdge(list[i], list[j], 2, `tag:${tag}`);
    }
  }

  // 标题词共现：中文 2 字片段要重合 ≥3 个，或 ≥2 个且其中一个是英文词才连。
  // 不这么收的话，标题里一堆「记忆」「插件」会把不相干的条目也连上。
  const terms = new Map(nodes.map((n) => [n.id, titleTerms(n.title)]));
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = terms.get(nodes[i].id);
      const b = terms.get(nodes[j].id);
      if (!a?.size || !b?.size) continue;
      const overlap = [...a].filter((t) => b.has(t));
      const hasLatin = overlap.some((term) => /^[a-z]/.test(term));
      if (overlap.length >= 3 || (overlap.length >= 2 && hasLatin)) {
        addEdge(nodes[i].id, nodes[j].id, overlap.length, 'topic');
      }
    }
  }

  // 每个节点只留最强的 maxEdgesPerNode 条边（按 weight 降序），其余丢掉；
  // 全局再按 weight 截断到 maxEdges（默认节点数×4），太密就看不出形状了。
  const ranked = [...edgeMap.values()].sort((a, b) => b.weight - a.weight);
  const degree = new Map();
  const edges = [];
  const maxEdges = Math.max(20, nodes.length * 4);
  for (const edge of ranked) {
    if (edges.length >= maxEdges) break;
    const a = (degree.get(edge.source) ?? 0) + 1;
    const b = (degree.get(edge.target) ?? 0) + 1;
    if (a > maxEdgesPerNode || b > maxEdgesPerNode) continue;
    degree.set(edge.source, a);
    degree.set(edge.target, b);
    edges.push({ ...edge, weight: Math.min(9, edge.weight) });
  }

  const types = {};
  const statuses = {};
  for (const node of nodes) {
    types[node.type] = (types[node.type] ?? 0) + 1;
    statuses[node.status] = (statuses[node.status] ?? 0) + 1;
  }

  return {
    at: now.toISOString(),
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      isolated: nodes.filter((n) => !edges.some((e) => e.source === n.id || e.target === n.id)).length,
      types,
      statuses,
    },
  };
}

/** 从 vault 现读现算（HTTP /graph 用）。 */
export function buildGraphOfVault(memories, vaultPath, options = {}) {
  const hits = vaultPath ? readHits(vaultPath) : {};
  return buildGraph(memories ?? [], { ...options, hits });
}
