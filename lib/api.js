/**
 * UI 的 HTTP 路由：client 面板用 fetch 取，宿主进程内、不碰网络。
 *
 *   GET  /memory-yuan/state            两份快照 + 预算（含今日流水、体检单）
 *   GET  /memory-yuan/memory?id=xxx    一条记忆全文
 *   POST /memory-yuan/supersede        { id } 标 superseded
 *   POST /memory-yuan/status           { id, status } 改状态（verified / disputed / candidate）
 *   GET  /memory-yuan/review           体检单（内容层面）
 *   GET  /memory-yuan/lint             结构体检（frontmatter / type / tags / 时间）
 *   POST /memory-yuan/lint/fix         修一条结构问题（只修文件本身，不动内容）
 *   POST /memory-yuan/tend             按体检建议处理（默认 dry-run）
 *   POST /memory-yuan/archive          { id } 挪进 Archive/
 *   POST /memory-yuan/restore          { id } 从 Archive/ 挪回
 *   POST /memory-yuan/migrate          { root?, dryRun? } 旧库迁移（默认 dry-run）
 *   GET  /memory-yuan/summary?date=    某天的收盘摘要（没有就 exists:false）
 *   POST /memory-yuan/summary          { date?, sentences[] } 手写 / 改当天的收盘
 *   GET  /memory-yuan/l1               L1 参数的默认值与当前覆盖
 *   POST /memory-yuan/l1               { maxItems?, minHits?, minScore?, minStrongHits? } 改（空串 = 恢复默认）
 */
import { markSuperseded, readMemoryText, readState, writeIndex, writeIndexIfChanged } from './snapshot.js';
import { loadMemories } from './vault.js';
import { findMemory } from './search.js';
import { archiveMemory, restoreMemory, setMemoryEvidence, setMemoryExpiry, setMemoryPinned, setMemoryStatus, supersedeMemory, updateMemory } from './store.js';
import { findEvidence } from './evidence.js';
import {reviewVault, ignoreInReview, readIgnored, unignoreInReview } from './review.js';
import { tendVault } from './tend.js';
import { exportBundle, importBundle } from './transfer.js';
import { buildGraphOfVault } from './graph.js';
import { applyMigration, defaultLegacyRoot, planMigration } from './migrate.js';
import { lintVault } from './structure.js';
import { FIXABLE_CODES, fixProblem } from './fix.js';
import { readDigestState } from './digest-scheduler.js';
import { readSummary, writeSummary } from './digest.js';
import { localDateStamp } from './stream.js';
import { searchStreams } from './streamsearch.js';
import { L1_DEFAULTS } from './l1.js';
import { L1_RANGES, clearL1Setting, readL1Settings, writeL1Settings } from './l1settings.js';
import { PRUNE_MAX_BYTES, PRUNE_MAX_FILES, backupStats, pruneBackups } from './backups.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  // 用事件而不是 async iterator：宿主/测试里传进来的 req 不一定是 IncomingMessage。
  const chunks = [];
  if (typeof req?.on !== 'function') {
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
  } else {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', resolve);
      req.on('error', reject);
    });
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function createStateHandler({ vaultPath, budget = 4000, digest = null }) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/^\/memory-yuan/, '') || '/';

    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/state')) {
        const state = readState(vaultPath);
        // 只在 vault 变了才重建：文件可能在 Obsidian 里被手改，要「刷一次就变」；但没变就别每次扫盘重写。
        try {
          if (writeIndexIfChanged(vaultPath)) state.index = readState(vaultPath).index;
        } catch {
          // 索引写不出来也能看 last-inject，不阻断
        }
        sendJson(res, 200, { ...state, budget, digest: readDigestState(vaultPath) });
        return;
      }

      if (req.method === 'POST' && pathname === '/digest/run') {
        const body = await readBody(req);
        if (typeof digest?.run !== 'function') {
          sendJson(res, 501, {
            ok: false,
            message: '这个会话没有模型能力（缺 llm / settings 服务），收盘跑不了；换一个有模型能力的会话来，或等它到点自动跑',
          });
          return;
        }
        const date = String(body?.date ?? '').trim() || undefined;
        const force = body?.force === false ? false : true;
        try {
          const result = await digest.run({ date, force });
          sendJson(res, 200, { ok: true, result });
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error?.message ?? String(error) });
        }
        return;
      }

      if (pathname === '/summary') {
        if (req.method === 'GET') {
          const date = url.searchParams.get('date')?.trim() || localDateStamp();
          const summary = readSummary(vaultPath, date);
          if (!summary.ok) {
            sendJson(res, 400, { ...summary, today: localDateStamp() });
            return;
          }
          sendJson(res, 200, { ...summary, today: localDateStamp() });
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const date = String(body?.date ?? '').trim() || localDateStamp();
          const sentences = Array.isArray(body?.sentences) ? body.sentences : [];
          const written = writeSummary(vaultPath, { date, sentences });
          if (!written.ok) {
            sendJson(res, 400, { ...written, today: localDateStamp() });
            return;
          }
          sendJson(res, 200, { ...written, ...readSummary(vaultPath, date), today: localDateStamp() });
          return;
        }
      }

      // 流水全文搜索：Daily/ 与 Projects/ 里按词找，只回命中行。
      if (req.method === 'GET' && pathname === '/streams') {
        const query = url.searchParams.get('query') ?? '';
        const limit = Number(url.searchParams.get('limit')) || 20;
        const from = url.searchParams.get('from')?.trim() ?? '';
        const to = url.searchParams.get('to')?.trim() ?? '';
        const result = searchStreams(vaultPath, { query, limit, from, to });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      // L1 参数：面板上改完下一轮就生效（存 vault 的 .dsh-memory/l1-settings.json）。
      if (req.method === 'GET' && pathname === '/l1') {
        sendJson(res, 200, {
          ok: true,
          ranges: L1_RANGES,
          defaults: {
            maxItems: L1_DEFAULTS.maxItems,
            minHits: L1_DEFAULTS.minHits,
            minScore: L1_DEFAULTS.minScore,
            minStrongHits: L1_DEFAULTS.minStrongHits,
          },
          settings: readL1Settings(vaultPath),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/l1') {
        const body = await readBody(req);
        const patch = {};
        const cleared = [];
        for (const name of Object.keys(L1_RANGES)) {
          if (!(body && name in body)) continue;
          if (body[name] === '' || body[name] === null) cleared.push(name);
          else patch[name] = body[name];
        }
        for (const name of cleared) clearL1Setting(vaultPath, name);
        if (Object.keys(patch).length) {
          const written = writeL1Settings(vaultPath, patch);
          if (!written.ok) {
            sendJson(res, 400, { ok: false, message: written.message });
            return;
          }
        }
        sendJson(res, 200, { ok: true, settings: readL1Settings(vaultPath), cleared });
        return;
      }

      // 备份目录：用量与清理（跨文件总量无上限，这里给一条总闸）。
      if (req.method === 'GET' && pathname === '/backups') {
        sendJson(res, 200, {
          ok: true,
          stats: backupStats(vaultPath),
          limits: { maxFiles: PRUNE_MAX_FILES, maxBytes: PRUNE_MAX_BYTES },
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/backups/clean') {
        const result = pruneBackups(vaultPath, { maxFiles: 100, maxBytes: 5 * 1024 * 1024 });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === 'GET' && pathname === '/memory') {
        const id = url.searchParams.get('id') ?? '';
        if (!id) {
          sendJson(res, 400, { error: 'missing id' });
          return;
        }
        const found = readMemoryText(vaultPath, id);
        if (!found) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        sendJson(res, 200, found);
        return;
      }

      if (req.method === 'POST' && pathname === '/supersede') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          // 缺 id 是请求不完整（400），不是「找不到这条记忆」（404）。自测 8 发现。
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const result = markSuperseded(vaultPath, id);
        sendJson(res, result.ok ? 200 : 404, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/status') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        const status = String(body?.status ?? '').trim().toLowerCase();
        if (!id || !status) {
          sendJson(res, 400, { ok: false, error: 'missing id or status' });
          return;
        }
        if (!['candidate', 'verified', 'disputed', 'superseded'].includes(status)) {
          sendJson(res, 400, { ok: false, error: `不认的 status：${status}` });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = setMemoryStatus(memory.path, status);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        writeIndex(vaultPath);
        sendJson(res, 200, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'POST' && pathname === '/pin') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id || typeof body?.pinned !== 'boolean') {
          // pinned 必须是显式 true/false，别让「忘了传」被当成 false
          sendJson(res, 400, { ok: false, error: 'missing id or pinned(boolean)' });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = setMemoryPinned(memory.path, body.pinned);
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        writeIndex(vaultPath);
        sendJson(res, 200, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'GET' && pathname === '/review') {
        sendJson(res, 200, { ok: true, ...reviewVault(vaultPath), ignored: readIgnored(vaultPath).size });
        return;
      }

      // 体检「可以合并」的一键合并：留一条，另一条标 superseded 后归档（文件不删，Archive/ 里能恢复）。
      if (req.method === 'POST' && pathname === '/review/merge') {
        const body = await readBody(req);
        const keepId = String(body?.keep ?? '').trim();
        const dropId = String(body?.drop ?? '').trim();
        if (!keepId || !dropId) {
          sendJson(res, 400, { ok: false, message: '要给 keep 和 drop 两个 id' });
          return;
        }
        if (keepId === dropId) {
          sendJson(res, 400, { ok: false, message: 'keep 和 drop 不能是同一条' });
          return;
        }
        const memories = loadMemories(vaultPath);
        const keep = findMemory(memories, keepId);
        const drop = findMemory(memories, dropId);
        if (!keep || !drop) {
          sendJson(res, 404, { ok: false, message: `有一条找不到：${!keep ? keepId : dropId}` });
          return;
        }
        const merged = supersedeMemory(drop.path, keep.id);
        if (!merged.ok) {
          sendJson(res, 400, merged);
          return;
        }
        const archived = archiveMemory(drop.path, { vaultPath });
        writeIndex(vaultPath);
        sendJson(res, 200, {
          ok: true,
          kept: { id: keep.id, title: keep.title },
          dropped: { id: drop.id, title: drop.title },
          archived: archived.ok ? archived.path : '',
          message: archived.ok ? '' : `已标废弃但没归档成功：${archived.message ?? '未知原因'}`,
        });
        return;
      }

      // 结构体检：只看文件写得对不对（frontmatter / type / tags / 时间），和 /review（内容层面）分开。
      if (req.method === 'GET' && pathname === '/lint') {
        const max = Number(url.searchParams.get('max')) || 200;
        const ignored = readIgnored(vaultPath);
        sendJson(res, 200, { ok: true, ...lintVault(vaultPath, { max, ignoredIds: ignored }), fixable: [...FIXABLE_CODES] });
        return;
      }

      // 结构体检的「修」：只修文件本身（目录、frontmatter、脏字段），不动内容。
      if (req.method === 'POST' && pathname === '/lint/fix') {
        const body = await readBody(req);
        const result = fixProblem(vaultPath, { id: body?.id, code: body?.code });
        if (!result.ok) {
          sendJson(res, 400, { ok: false, error: result.message ?? 'fix failed', ...result });
          return;
        }
        writeIndex(vaultPath);
        sendJson(res, 200, { ok: true, ...result, fixable: [...FIXABLE_CODES] });
        return;
      }

      if (req.method === 'POST' && pathname === '/expire') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = setMemoryExpiry(memory.path, body?.expires ?? '');
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        writeIndex(vaultPath);
        sendJson(res, 200, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'POST' && pathname === '/review/unignore') {
        const body = await readBody(req);
        const result = unignoreInReview(vaultPath, body?.id);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/review/ignore') {
        const body = await readBody(req);
        const result = ignoreInReview(vaultPath, body?.id, { action: body?.action });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/tend') {
        const body = await readBody(req);
        const items = Array.isArray(body?.items) ? body.items : [];
        if (!items.length) {
          sendJson(res, 400, { ok: false, message: '要给 items（要处理哪几条）' });
          return;
        }
        const result = tendVault(vaultPath, { items, dryRun: body?.dryRun !== false });
        if (result.ok && !result.dryRun && result.applied?.length) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/archive') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, message: 'missing id' });
          return;
        }
        const target = findMemory(loadMemories(vaultPath), id);
        if (!target) {
          sendJson(res, 404, { ok: false, message: '找不到这条记忆' });
          return;
        }
        const result = archiveMemory(target.path, { vaultPath });
        if (result.ok) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/restore') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, message: 'missing id' });
          return;
        }
        const result = restoreMemory(vaultPath, id);
        if (result.ok) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 404, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/migrate') {
        const body = await readBody(req);
        const root = String(body?.root ?? '').trim() || defaultLegacyRoot();
        const dryRun = body?.dryRun !== false;
        const plan = planMigration({ root, vaultPath });
        if (!plan.ok) {
          sendJson(res, 400, { ok: false, message: plan.message });
          return;
        }
        const result = dryRun ? { ok: true, dryRun: true, planned: plan.counts } : applyMigration(plan, { vaultPath });
        if (!dryRun && result.ok) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/export') {
        const body = await readBody(req);
        const outRoot = String(body?.outRoot ?? '').trim();
        const result = exportBundle(vaultPath, outRoot ? { outRoot } : {});
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/import') {
        const body = await readBody(req);
        const bundle = String(body?.bundle ?? '').trim();
        if (!bundle) {
          sendJson(res, 400, { ok: false, message: '要给 bundle（记忆包文件夹路径）' });
          return;
        }
        const result = importBundle(bundle, { vaultPath, dryRun: body?.dryRun !== false });
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/related') {
        const id = String(url.searchParams.get('id') ?? '').trim();
        const limit = Math.min(12, Math.max(1, Number(url.searchParams.get('limit') ?? 6) || 6));
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const graph = buildGraphOfVault(loadMemories(vaultPath), vaultPath, { maxEdgesPerNode: 40 });
        const node = graph.nodes.find((item) => item.id === id);
        if (!node) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const byId = new Map(graph.nodes.map((item) => [item.id, item]));
        const related = graph.edges
          .filter((edge) => edge.source === id || edge.target === id)
          .sort((a, b) => b.weight - a.weight)
          .slice(0, limit)
          .map((edge) => {
            const other = byId.get(edge.source === id ? edge.target : edge.source);
            return other ? { id: other.id, title: other.title, type: other.type, kind: edge.kind, weight: edge.weight } : null;
          })
          .filter(Boolean);
        sendJson(res, 200, { ok: true, id, related });
        return;
      }

      if (req.method === 'POST' && pathname === '/update') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = updateMemory(memory.path, {
          title: body?.title,
          tags: body?.tags,
          importance: body?.importance,
          content: body?.content,
        }, { vaultPath });
        if (result.ok) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 400, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'POST' && pathname === '/delete') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, error: '删除要二次确认：传 confirm: true' });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = archiveMemory(memory.path, { vaultPath });
        if (result.ok) writeIndex(vaultPath);
        sendJson(res, result.ok ? 200 : 400, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'GET' && pathname === '/evidence') {
        // 从会话存档里回溯「这条记忆是哪次对话说的」：只读、只给候选，由人确认。
        const id = String(url.searchParams.get('id') ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const memories = loadMemories(vaultPath);
        const memory = findMemory(memories, id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const candidateLimit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit') || 5)));
        const candidates = findEvidence(
          { title: memory.title, createdAt: memory.createdAt ?? memory.updated, memories },
          { maxResults: candidateLimit },
        );
        sendJson(res, 200, { ok: true, id: memory.id, title: memory.title, candidates });
        return;
      }

      if (req.method === 'POST' && pathname === '/evidence') {
        const body = await readBody(req);
        const id = String(body?.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { ok: false, error: 'missing id' });
          return;
        }
        const memory = findMemory(loadMemories(vaultPath), id);
        if (!memory) {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const result = setMemoryEvidence(memory.path, body?.evidence ?? '');
        if (!result.ok) {
          sendJson(res, 400, result);
          return;
        }
        writeIndex(vaultPath);
        sendJson(res, 200, { ...result, id: memory.id, title: memory.title });
        return;
      }

      if (req.method === 'GET' && pathname === '/graph') {
        // 星图：默认只画 verified / candidate；all=1 连 superseded 一起画（看历史）。
        const all = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') ?? '').toLowerCase());
        const maxNodes = Number(url.searchParams.get('maxNodes') || 0) || 200;
        const notes = vaultPath ? loadMemories(vaultPath) : [];
        sendJson(res, 200, buildGraphOfVault(notes, vaultPath, { includeArchived: all, maxNodes }));
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) });
    }
  };
}

export function registerRoutes(ctx, options) {
  const handler = createStateHandler(options);
  return ctx.webServer.register({ kind: 'prefix', path: '/memory-yuan', handler });
}
