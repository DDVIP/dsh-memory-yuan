/**
 * 十三个工具：memory_search / memory_get / memory_write / memory_update / memory_digest / memory_review / memory_tend / memory_lint / memory_archive / memory_migrate / memory_export / memory_import / memory_explain。
 *
 * 形状（踩过坑）：每个工具必须带 output { schema, render }，
 * render 返回 [{ type:'text', text }]；execute 的返回值必须严格匹配 output.schema
 * （schema 里写了 additionalProperties:false，多一个字段就报 invalid output）。
 * render 的签名是 (args, value)：第二个参数才是 execute 的返回值（2026-11-22 踩过）。
 */
import { loadMemories, readMemoryFile } from './vault.js';
import { findMemory, searchMemories, summarize } from './search.js';
import { MEMORY_TYPES, archiveMemory, createMemory, recordRead, restoreMemory, supersedeMemory, updateMemory } from './store.js';
import { reviewVault } from './review.js';
import { tendVault } from './tend.js';
import { findConflicts } from './conflict.js';
import { describeSensitive, scanSensitive } from './sensitive.js';
import { explainOne, explainRecall, explainState } from './explain.js';
import { lintVault } from './structure.js';
import { detectCompanionMemory } from './coexist.js';
import { applyMigration, defaultLegacyRoot, planMigration } from './migrate.js';
import { writeIndex } from './snapshot.js';
import { appendStream, readStream } from './stream.js';
import { tryLock } from './lock.js';
import { readDaily, writeSummary } from './digest.js';
import { exportBundle, importBundle } from './transfer.js';

/** 写盘成功后重建索引；失败只影响索引，不影响已落盘的记忆。 */
function reindex(vaultPath) {
  try {
    writeIndex(vaultPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

/** 标题归一化（借 dsh-memory-net 的去重键：去空白/标点/符号再小写）。 */
function normTitle(value) {
  return String(value ?? '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** 从 exec 里尽量拿到会话 id。 */
function sessionIdOf(exec) {
  return exec?.sessionId ?? exec?.sessionID ?? exec?.session?.id ?? exec?.agent?.session?.id ?? '';
}

const rowsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      type: { type: 'string' },
      status: { type: 'string' },
      importance: { type: 'number' },
      pinned: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      updated: { type: 'string' },
      path: { type: 'string' },
      excerpt: { type: 'string' },
      score: { type: 'number' },
      hits: { type: 'array', items: { type: 'string' } },
    },
    required: ['id', 'title', 'type', 'status', 'importance', 'pinned', 'tags', 'updated', 'path', 'excerpt'],
    additionalProperties: false,
  },
};

export function createTools({ vaultPath }) {
  const memorySearch = {
    name: 'memory_search',
    get description() {
      return (
        '按线索检索渊自己的记忆库（Markdown vault）。默认搜 verified 与 candidate（disputed / superseded 要 includeArchived）。' +
        'query 用空格分隔关键词；tags 要全部包含；type 精确到 decision/preference/experience/knowledge/project-state/profile。' +
        '返回一行一条摘要（含 excerpt），要全文再用 memory_get。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔' },
        tags: { type: 'array', items: { type: 'string' }, description: '必须全部包含的 tag' },
        type: { type: 'string', description: '限定类型' },
        includeArchived: { type: 'boolean', description: '连 disputed / superseded 一起搜' },
        limit: { type: 'integer', description: '最多返回几条（默认 8）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          rows: rowsSchema,
          query: { type: 'string' },
          count: { type: 'number' },
          hint: { type: 'string' },
        },
        required: ['rows', 'query', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const rows = Array.isArray(value?.rows) ? value.rows : [];
        if (rows.length === 0) {
          return [{ type: 'text', text: `没有命中（query: ${value?.query ?? ''}）` }];
        }
        const lines = rows.map((row) => `[${row.type}·${row.importance}] ${row.title} — ${row.excerpt}（${row.id}）`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      const memories = loadMemories(vaultPath);
      const rows = searchMemories(memories, {
        query: args.query ?? '',
        tags: args.tags ?? [],
        type: args.type ?? '',
        includeArchived: args.includeArchived === true,
        limit: args.limit ?? 8,
      }).map(({ memory, score, hits }) => ({ ...summarize(memory), score, hits }));

      return {
        rows,
        query: args.query ?? '',
        count: rows.length,
        ...(rows.length > 0 ? { hint: '要全文用 memory_get(id)；旧版本已 superseded 的不会出现在这里' } : {}),
      };
    },
  };

  const memoryGet = {
    name: 'memory_get',
    get description() {
      return '按 id（或文件路径尾部）取一条记忆的全文。找不到时 ok=false。';
    },
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id，或文件路径' },
        stream: { type: 'string', description: '读流水：daily（按天）或 project（按项目）' },
        date: { type: 'string', description: 'stream=daily 时的日期 YYYY-MM-DD，默认今天' },
        project: { type: 'string', description: 'stream=project 时的项目名' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          importance: { type: 'number' },
          pinned: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          updated: { type: 'string' },
          path: { type: 'string' },
          evidence: { type: 'string' },
          expires: { type: 'string' },
          reads: { type: 'number' },
          text: { type: 'string' },
          kind: { type: 'string' },
          date: { type: 'string' },
          project: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: value?.message ?? '没找到' }];
        if (value.kind) return [{ type: 'text', text: `${value.path}\n\n${value.text}` }];
        const meta = [
          `状态 ${value.status ?? '?'}`,
          value.updated ? `更新 ${value.updated}` : '',
          value.expires ? `过期 ${value.expires}` : '',
          `读过 ${value.reads ?? 0} 次`,
        ].filter(Boolean).join(' · ');
        const evidence = value.evidence ? `\n证据：${value.evidence}` : '';
        return [{ type: 'text', text: `${value.title}\n${value.path}\n${meta}${evidence}\n\n${value.text}` }];
      },
    },
    async execute(args = {}) {
      if (args.stream) {
        const stream = readStream(vaultPath, { kind: args.stream, date: args.date, project: args.project });
        if (!stream.ok) return { ok: false, message: stream.message };
        const out = { ok: true, kind: stream.kind, path: stream.path, text: stream.text };
        if (stream.date) out.date = stream.date;
        if (stream.project) out.project = stream.project;
        return out;
      }
      if (!args.id) return { ok: false, message: '要给 id，或传 stream=daily/project 读流水' };
      const memories = loadMemories(vaultPath);
      const memory = findMemory(memories, args.id);
      if (!memory) return { ok: false, message: `没找到记忆：${args.id}` };
      // 记一次读取：区分「注入了」和「真的被读过」，memory_review 用。
      const read = recordRead(memory.path, vaultPath);
      // 计数写进去之后重读一次，免得返回的正文里 reads 还是旧值。
      const fresh = read.ok ? readMemoryFile(memory.path) ?? memory : memory;
      const out = {
        ok: true,
        id: memory.id,
        title: memory.title,
        type: memory.type,
        status: fresh.status,
        importance: memory.importance,
        pinned: memory.pinned,
        tags: memory.tags,
        updated: fresh.updated,
        path: memory.path,
        evidence: fresh.evidence ?? '',
        expires: fresh.expires ?? '',
        reads: read.ok ? read.reads : memory.reads ?? 0,
        text: fresh.raw,
      };
      return out;
    },
  };

  const memoryWrite = {
    name: 'memory_write',
    get description() {
      return (
        '写记忆。默认 mode=create：一条新记忆（一条只讲一件事），type 可选：' +
        `${MEMORY_TYPES.join(' / ')}。` +
        '改旧记忆不要覆盖：新写一条并传 supersedes=旧 id，旧文件会被标成 superseded（正文保留）。' +
        'mode=append：往流水里追加一行——stream=daily（Daily/YYYY-MM-DD.md）或 stream=project（Projects/<项目名>.md），不建 id、不进索引、不参与 L1。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'create（默认，造条目）或 append（追加流水）' },
        stream: { type: 'string', description: 'mode=append 时：daily 或 project' },
        project: { type: 'string', description: 'mode=append 且 stream=project 时的项目名' },
        date: { type: 'string', description: 'mode=append 且 stream=daily 时的日期 YYYY-MM-DD，默认今天' },
        title: { type: 'string', description: '标题：能独立看懂的一句话（create 用；append 不需要）' },
        type: { type: 'string', description: MEMORY_TYPES.join(' / ') },
        content: { type: 'string', description: '核心内容段；append 时是这一行流水的内容' },
        source: { type: 'string', description: '来源与依据' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索线索' },
        importance: { type: 'integer', description: '0-100，默认 50' },
        pinned: { type: 'boolean', description: 'true 才会进 L0（仅 decision/preference 有意义）' },
        confidence: { type: 'number', description: '0-1，默认 0.8' },
        supersedes: { type: 'string', description: '被替代的旧记忆 id' },
        expectedUpdatedAt: {
          type: 'string',
          description:
            '写前比对：传你读到的旧条目 updated_at（形如 2026-11-22 15:40:12），和磁盘上不一致就拒绝（别的班次刚改过），不会悄悄覆盖',
        },
        status: {
          type: 'string',
          description:
            'candidate（默认，进 Inbox/ 等确认）/ verified（人确认过，才是 L0 的料）/ disputed（有争议，不进 L0/L1）/ superseded（被替代）。verified 必须同时传 confirm=true，模型不能自己盖戳',
        },
        evidence: { type: 'string', description: '这句话的出处：哪天的对话、哪封日记、哪个文件第几行（可选）' },
        expires: { type: 'string', description: '时效性：YYYY-MM-DD，过期后不进 L1、体检单会单列（可选）' },
        confirm: { type: 'boolean', description: 'status=verified 时必须为 true（主人明确同意时才传）' },
        by: {
          type: 'string',
          description:
            'mode=append 时的来源标记，自由文本不设白名单：家里 / 工作 / 记忆插件 / room插件…（以后新会话用新名字）；不传就不标，读取按家里算',
        },
        source_sessions: {
          type: 'array',
          items: { type: 'string' },
          description: '来源会话 id（默认当前会话）',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          id: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          message: { type: 'string' },
          superseded: { type: 'string' },
          kind: { type: 'string' },
          date: { type: 'string' },
          project: { type: 'string' },
          line: { type: 'string' },
          md: { type: 'string' },
          index: { type: 'string' },
          indexError: { type: 'string' },
          conflict: { type: 'boolean' },
          currentUpdatedAt: { type: 'string' },
          expectedUpdatedAt: { type: 'string' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                importance: { type: 'number' },
                pinned: { type: 'boolean' },
                updated: { type: 'string' },
                hard: { type: 'boolean' },
                sameTags: { type: 'array', items: { type: 'string' } },
                overlap: { type: 'number' },
              },
              required: ['id', 'title'],
              additionalProperties: false,
            },
          },
          duplicate: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              type: { type: 'string' },
              path: { type: 'string' },
            },
            required: ['id', 'title'],
            additionalProperties: false,
          },
          sensitive: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                label: { type: 'string' },
                line: { type: 'number' },
                excerpt: { type: 'string' },
              },
              required: ['kind', 'label'],
              additionalProperties: false,
            },
          },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) {
          if (value?.conflict) {
            return [
              {
                type: 'text',
                text:
                  `这条记忆在你读之后被改过，没有写。\n` +
                  `你看到的 updated_at：${value.expectedUpdatedAt ?? '(空)'}\n` +
                  `盘上现在是：${value.currentUpdatedAt ?? '(空)'}\n` +
                  `${value.message ?? ''}\n` +
                  '先 memory_get 看最新版，再决定是改写还是放弃；确实要覆盖就别传 expectedUpdatedAt。',
              },
            ];
          }
          const detail = value?.message ?? '没有具体原因（多半是参数不合 schema）';
          return [{ type: 'text', text: `md 没写成：${detail}。先查对应目录有没有新文件，别急着重写。` }];
        }
        if (value.mode === 'append') {
          const where =
            value.kind === 'daily' ? `daily 流水 ${value.date}` : `项目流水 ${value.project}`;
          const sensitiveNote =
            Array.isArray(value.sensitive) && value.sensitive.length
              ? `\n${describeSensitive(value.sensitive)}`
              : '';
          return [{ type: 'text', text: `已追加 ${where}\n${value.line}\n${value.path}${sensitiveNote}` }];
        }
        const lines = [`已写入 ${value.type}：${value.title}`, value.path];
        lines.push(`md：${value.md ?? 'ok'}；索引：${value.index ?? 'ok'}`);
        if (value.superseded) lines.push(`旧条目已标 superseded：${value.superseded}`);
        if (value.index === 'failed') {
          lines.push(
            `索引重建失败（原始错误）：${value.indexError ?? '(无)'}。记忆已落盘，别重写；下次重建索引会自动补上。`,
          );
        }
        if (value.message) lines.push(`注意：${value.message}`);
        if (Array.isArray(value.conflicts) && value.conflicts.length) {
          lines.push(
            `可能撞题的已有条目 ${value.conflicts.length} 条（没拦着你写）：` +
              value.conflicts
                .map(
                  (item) =>
                    `${item.title}（${item.id}${item.pinned ? '，pinned' : ''}${item.overlap ? `，标题重合 ${Math.round(item.overlap * 100)}%` : ''}）`,
                )
                .join('；') +
              '。如果说的是同一件事，建议用 supersedes 明确替代；两份都留着会同时进 L1/L0。',
          );
        }
        if (value.duplicate) {
          lines.push(
            `库里已有同标题的 ${value.duplicate.type ?? '条目'}：${value.duplicate.title}（${value.duplicate.id}）。` +
              `要改它请传 supersedes=${value.duplicate.id}；这次已经写了一条新的。`,
          );
        }
        if (Array.isArray(value.sensitive) && value.sensitive.length) {
          lines.push(describeSensitive(value.sensitive));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}, exec) {
      const mode = args.mode ?? 'create';
      if (mode !== 'create' && mode !== 'append') {
        return { ok: false, message: `mode 只能是 create 或 append，收到：${mode}` };
      }
      // 待办5：verified 是「人确认过」的章，模型不能自己盖；默认写 candidate。
      const requestedStatus = String(args.status ?? 'candidate').trim().toLowerCase();
      if (requestedStatus === 'verified' && args.confirm !== true) {
        return {
          ok: false,
          message:
            'verified 是「人确认过」的章：在面板上点「标为 verified」，或主人明确同意时传 confirm=true。默认会写 candidate。',
        };
      }

      if (mode === 'append') {
        const appended = appendStream({
          vaultPath,
          kind: args.stream,
          content: args.content,
          date: args.date,
          project: args.project,
          by: args.by,
        });
        if (!appended.ok) return { ok: false, mode: 'append', message: appended.message };
        const out = {
          ok: true,
          mode: 'append',
          kind: appended.kind,
          path: appended.path,
          line: appended.line,
        };
        if (appended.date) out.date = appended.date;
        if (appended.project) out.project = appended.project;
        const sensitive = scanSensitive(args.content ?? '');
        if (sensitive.length) out.sensitive = sensitive;
        return out;
      }

      const outcome = tryLock(vaultPath, () => {
        // 写前比对：两个班次各持一份快照，盘上这条被别人改过就拒绝，不悄悄覆盖。
        let target = null;
        if (args.supersedes) target = findMemory(loadMemories(vaultPath), args.supersedes);
        if (args.expectedUpdatedAt) {
          if (!target) {
            return {
              ok: false,
              mode: 'create',
              conflict: true,
              expectedUpdatedAt: String(args.expectedUpdatedAt),
              message: '传了 expectedUpdatedAt 但没传 supersedes（没指明比哪一条），没法比对',
            };
          }
          if (String(target.updated ?? '') !== String(args.expectedUpdatedAt)) {
            return {
              ok: false,
              mode: 'create',
              conflict: true,
              id: target.id,
              expectedUpdatedAt: String(args.expectedUpdatedAt),
              currentUpdatedAt: String(target.updated ?? ''),
              message: '盘上这条的 updated_at 和你读到的不一样，可能另一个班次刚改过',
            };
          }
        }

        const result = createMemory({
          title: args.title,
          type: args.type,
          content: args.content,
          source: args.source ?? '',
          tags: args.tags ?? [],
          importance: args.importance ?? 50,
          pinned: args.pinned === true,
          confidence: args.confidence ?? 0.8,
          status: requestedStatus,
          evidence: args.evidence ?? '',
          expires: args.expires ?? '',
          sourceSessions:
            Array.isArray(args.source_sessions) && args.source_sessions.length
              ? args.source_sessions.map(String)
              : sessionIdOf(exec)
                ? [sessionIdOf(exec)]
                : [],
          vaultPath,
          id: undefined,
        });

        if (!result.ok) return { ok: false, mode: 'create', md: 'failed', message: result.message };

        // 查重（借 dsh-memory-net 的去重键）：同 type、标题归一化后相同 → 提示，不阻断写入。
        // 排除刚写进去的这条自己（查重在写盘之后做，否则会命中自己）。
        const duplicate = loadMemories(vaultPath).find(
          (memory) =>
            memory.id !== result.id &&
            memory.type === args.type &&
            memory.status !== 'superseded' &&
            normTitle(memory.title) === normTitle(args.title),
        );

        let superseded;
        let note;
        if (args.supersedes) {
          const old = target ?? findMemory(loadMemories(vaultPath), args.supersedes);
          if (!old) {
            note = `新条目已写入，但没找到要替代的 ${args.supersedes}`;
          } else {
            const marked = supersedeMemory(old.path, result.id);
            if (!marked.ok) note = `新条目已写入，但旧条目标记失败：${marked.message}`;
            else superseded = old.id;
          }
        }

        // 撞题提醒（不阻断写入）：同 type、同 tag 或标题词重合过半的旧条目列出来，
        // 让人决定是用 supersedes 替代，还是两份都留着（decision / preference 尤其怕前后相反）。
        const conflicts = findConflicts(loadMemories(vaultPath).filter((memory) => memory.id !== result.id), {
          id: result.id,
          type: args.type,
          title: result.title,
          tags: args.tags ?? [],
        });

        // md 与 index 分两段报：md 写成才是写入成功，索引失败只提示并可自愈（2026-11-22 bug）。
        const sensitive = scanSensitive(args.content ?? '');
        const index = reindex(vaultPath);
        return {
          ok: true,
          mode: 'create',
          id: result.id,
          path: result.path,
          type: result.type,
          title: result.title,
          md: 'ok',
          index: index.ok ? 'ok' : 'failed',
          ...(index.ok ? {} : { indexError: index.message }),
          ...(duplicate
            ? { duplicate: { id: duplicate.id, title: duplicate.title, type: duplicate.type, path: duplicate.path } }
            : {}),
          ...(conflicts.length ? { conflicts } : {}),
          ...(sensitive.length ? { sensitive } : {}),
          ...(superseded ? { superseded } : {}),
          ...(note ? { message: note } : {}),
        };
      });

      if (outcome?.locked) return { ok: false, mode: 'create', md: 'failed', message: outcome.message };
      return outcome;
    },
  };

const UPDATE_FIELD_NAMES = { title: '标题', tags: '标签', importance: '重要度', content: '正文', evidence: '出处', expires: '过期日' };

  const memoryUpdate = {
    name: 'memory_update',
    get description() {
      return '改一条已有记忆的字段（标题 / 标签 / 重要度 / 正文 / 出处 / 过期日），不新建文件、不动 id 与状态。只改传了的字段；写前可传 expectedUpdatedAt 防止覆盖别的班次刚改的版本。';
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '记忆 id，或文件路径尾部' },
        title: { type: 'string', description: '新标题（单行）' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签数组（整体替换）' },
        importance: { type: 'integer', description: '新的重要度 0-100' },
        content: { type: 'string', description: '新的核心内容（只替换「## 核心内容」那一段）' },
        evidence: { type: 'string', description: '出处；传空串就清掉' },
        expires: { type: 'string', description: '过期日 YYYY-MM-DD；传空串就清掉' },
        expectedUpdatedAt: { type: 'string', description: '你读到的 updated_at；盘上不一致就拒绝，不悄悄覆盖' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          changed: { type: 'array', items: { type: 'string' } },
          before: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              importance: { type: 'number' },
              evidence: { type: 'string' },
              expires: { type: 'string' },
              core: { type: 'string' },
            },
          },
          after: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              importance: { type: 'number' },
              evidence: { type: 'string' },
              expires: { type: 'string' },
              core: { type: 'string' },
            },
          },
          conflict: { type: 'boolean' },
          currentUpdatedAt: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) {
          if (value?.conflict) {
            return [
              {
                type: 'text',
                text: '没改：这条在你读之后被改过。\n盘上现在是：' + (value.currentUpdatedAt ?? '（未知）') + '\n先 memory_get 看最新版，确认后再改。',
              },
            ];
          }
          return [{ type: 'text', text: '改失败：' + (value?.message ?? '没有具体原因') }];
        }
        const lines = [`已更新：${value.title ?? ''}（${value.id ?? ''}）`];
        const changed = Array.isArray(value.changed) ? value.changed : [];
        if (changed.length) {
          const parts = changed.map((field) => {
            const name = UPDATE_FIELD_NAMES[field] ?? field;
            if (field === 'title' && value.before?.title !== value.after?.title) return name + '（' + value.before.title + ' → ' + value.after.title + '）';
            if (field === 'importance' && value.before?.importance !== value.after?.importance) return name + '（' + value.before.importance + ' → ' + value.after.importance + '）';
            return name;
          });
          lines.push('改了：' + parts.join('、'));
        }
        if (value.path) lines.push('文件：' + value.path);
        if (value.message) lines.push('注意：' + value.message);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const memories = loadMemories(vaultPath);
      const target = findMemory(memories, String(args?.id ?? ''));
      if (!target) return { ok: false, message: `找不到这条记忆：${args?.id ?? ''}` };
      const expected = typeof args?.expectedUpdatedAt === 'string' ? args.expectedUpdatedAt.trim() : '';
      if (expected && expected !== target.updated) {
        return {
          ok: false,
          conflict: true,
          id: target.id,
          title: target.title,
          currentUpdatedAt: target.updated,
          message: '盘上这条的 updated_at 和你读到的不一样，可能另一个班次刚改过',
        };
      }
      const patch = {};
      for (const key of ['title', 'tags', 'importance', 'content', 'evidence', 'expires']) {
        if (args?.[key] !== undefined) patch[key] = args[key];
      }
      if (!Object.keys(patch).length) {
        return { ok: false, id: target.id, title: target.title, message: '没给要改的字段（title / tags / importance / content / evidence / expires）' };
      }
      const result = updateMemory(target.path, patch, { vaultPath });
      if (!result.ok) return { ok: false, id: target.id, title: target.title, message: result.message };
      const index = reindex(vaultPath);
      const note = index.ok ? '' : `索引重建失败：${index.message}。记忆已改，不要重写。`;
      return {
        ok: true,
        id: target.id,
        title: result.after?.title ?? target.title,
        path: target.path,
        changed: result.changed ?? [],
        before: result.before ?? {},
        after: result.after ?? {},
        ...(note ? { message: note } : {}),
      };
    },
  };

  const memoryDigest = {
    name: 'memory_digest',
    get description() {
      return (
        '收盘归拢：不传 sentences 时读当天（或指定日期）的每日流水与已有收盘；' +
        '传 sentences（3–6 句有主语的完整句子）时写进 Daily/<date>.summary.md（覆盖同名文件，同一天跑两次不会写两遍）。' +
        '只归拢流水，不改长期记忆；配得上长期的写成 Inbox/ 候选（memory_write 加 status=candidate）。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
        sentences: {
          type: 'array',
          items: { type: 'string' },
          description: '收盘句子（3–6 句）；不传就是只读，读了再写',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          date: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line: { type: 'string' },
                time: { type: 'string' },
                by: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['line', 'time', 'by', 'text'],
              additionalProperties: false,
            },
          },
          summaryPath: { type: 'string' },
          previous: { type: 'string' },
          count: { type: 'number' },
          at: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) {
          return [{ type: 'text', text: `收盘没跑成：${value?.message ?? '（没有原因）'}` }];
        }
        if (Array.isArray(value.lines)) {
          const head = value.lines.length
            ? `这一天有 ${value.lines.length} 条流水：\n${value.lines.join('\n')}`
            : '这一天还没有流水行。';
          const tail = value.previous ? `\n已有收盘（再写会覆盖）：\n${value.previous}` : '\n还没有收盘。';
          return [{ type: 'text', text: `${head}${tail}\n流水文件：${value.path}` }];
        }
        return [{ type: 'text', text: `已写收盘：${value.date}，${value.count} 句\n${value.path}` }];
      },
    },
    async execute(args = {}) {
      if (Array.isArray(args.sentences) && args.sentences.length) {
        return writeSummary(vaultPath, { date: args.date, sentences: args.sentences });
      }
      return readDaily(vaultPath, args.date);
    },
  };

  const reviewItemBase = {
    id: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string', description: '为什么上这张单子（人话）' },
    fix: { type: 'string', description: '建议怎么处理' },
    locked: { type: 'boolean', description: 'true 表示 decision / preference，只列不改' },
    suggest: {
      type: 'object',
      description: '一条可直接执行的建议；memory_tend 照着做',
      properties: {
        action: { type: 'string', description: 'supersede / evidence / demote / renew / merge / none' },
        value: { type: 'string' },
        reason: { type: 'string' },
        keep: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
        drop: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: { action: { type: 'string' }, value: { type: 'string' }, reason: { type: 'string' } },
            required: ['action'],
            additionalProperties: false,
          },
        },
      },
      required: ['action', 'reason'],
      additionalProperties: false,
    },
  };

  const memoryReview = {
    name: 'memory_review',
    get description() {
      return (
        '记忆体检：只出单子，不动任何记忆。① 疑似过时（updated 超 60 天，且所在目录 30 天没有新条目）' +
        '② 可能没用（L1 命中 ≥3 次，但 memory_get 0 次）③ 可以合并（同 type、tag 交集 ≥2、标题词重合 ≥50%）' +
        '④ 已确认但没写出处 ⑤ 已过期（expires 已过，不再进 L1）。' +
        '要不要归档、合并由主人定；这个工具不归档、不改 status。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        now: { type: 'string', description: '按哪个时间算「多久没动」（YYYY-MM-DD，默认今天；测试用）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          scanned: { type: 'number' },
          counts: {
            type: 'object',
            properties: {
              stale: { type: 'number' },
              unused: { type: 'number' },
              merge: { type: 'number' },
              noEvidence: { type: 'number' },
              expired: { type: 'number' },
              ignored: { type: 'number' },
            },
            required: ['stale', 'unused', 'merge', 'noEvidence'],
            additionalProperties: false,
          },
          stale: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ...reviewItemBase,
                updated: { type: 'string' },
                days: { type: 'number' },
                dirIdleDays: { type: 'number' },
              },
              required: ['id', 'type', 'title', 'updated', 'days', 'dirIdleDays'],
              additionalProperties: false,
            },
          },
          unused: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ...reviewItemBase,
                hits: { type: 'number' },
                reads: { type: 'number' },
                lastHitAt: { type: 'string' },
              },
              required: ['id', 'type', 'title', 'hits', 'reads', 'lastHitAt'],
              additionalProperties: false,
            },
          },
          merge: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                a: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
                b: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false },
                sharedTags: { type: 'array', items: { type: 'string' } },
                titleOverlap: { type: 'number' },
                why: { type: 'string' },
                fix: { type: 'string' },
              },
              required: ['a', 'b', 'sharedTags', 'titleOverlap'],
              additionalProperties: false,
            },
          },
          noEvidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                title: { type: 'string' },
                importance: { type: 'number' },
                updated: { type: 'string' },
                why: { type: 'string' },
                fix: { type: 'string' },
              },
              required: ['id', 'type', 'title'],
              additionalProperties: false,
            },
          },
          expired: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ...reviewItemBase,
                expires: { type: 'string' },
                updated: { type: 'string' },
              },
              required: ['id', 'type', 'title', 'expires', 'updated'],
              additionalProperties: false,
            },
          },
          ignoredEntries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                action: { type: 'string' },
              },
              required: ['id', 'type', 'title'],
              additionalProperties: false,
            },
          },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: value?.message ?? '体检没跑成' }];
        const counts = value.counts ?? { stale: 0, unused: 0, merge: 0 };
        const lines = [`体检：扫了 ${value.scanned ?? 0} 条活记忆。`];
        // 每条都带一条可执行建议；decision / preference 只列不改（locked）。
        const suggestLine = (item) => {
          if (!item?.suggest) return '';
          if (item.locked) return '建议：只列不改（decision / preference 是人定的）';
          const action = item.suggest.action ?? 'none';
          if (action === 'none') return `建议：不动（${item.suggest.reason ?? ''}）`;
          const target = item.suggest.drop ? `「${item.suggest.drop.title}」` : '';
          const at = item.suggest.value ? `「${String(item.suggest.value).slice(0, 40)}」` : '';
          return `建议：${action}${target}${at}（${item.suggest.reason ?? ''}）`;
        };
        lines.push(
          `疑似过时 ${counts.stale} 条 / 可能没用 ${counts.unused} 条 / 可以合并 ${counts.merge} 组 / 缺出处 ${counts.noEvidence ?? 0} 条 / 已过期 ${counts.expired ?? 0} 条。`,
        );
        if (counts.stale) {
          lines.push('', '## 疑似过时');
          for (const item of (value.stale ?? []).slice(0, 10)) {
            lines.push(`- [${item.type}] ${item.title}（${item.days} 天没动，目录 ${item.dirIdleDays} 天没新条目）——${item.why ?? ''} id:${item.id} ${suggestLine(item)}`);
          }
          if ((value.stale ?? []).length > 10) lines.push(`- …还有 ${value.stale.length - 10} 条`);
        }
        if (counts.unused) {
          lines.push('', '## 可能没用（被检索到过，但从没被读过）');
          for (const item of (value.unused ?? []).slice(0, 10)) {
            lines.push(`- [${item.type}] ${item.title}（命中 ${item.hits} 次，reads 0）——${item.why ?? ''} id:${item.id} ${suggestLine(item)}`);
          }
          if ((value.unused ?? []).length > 10) lines.push(`- …还有 ${value.unused.length - 10} 条`);
        }
        if (counts.merge) {
          lines.push('', '## 可以合并');
          for (const item of (value.merge ?? []).slice(0, 10)) {
            lines.push(`- ${item.a.title} ⇄ ${item.b.title}（共同标签：${item.sharedTags.join('、')}，标题重合 ${Math.round(item.titleOverlap * 100)}%）——${item.why ?? ''} ${suggestLine(item)}`);
          }
          if ((value.merge ?? []).length > 10) lines.push(`- …还有 ${value.merge.length - 10} 组`);
        }
        if (counts.noEvidence) {
          lines.push('', '## 已确认但没写出处（证据门）');
          for (const item of (value.noEvidence ?? []).slice(0, 10)) {
            lines.push(`- [${item.type}] ${item.title}（重要度 ${item.importance ?? '-'}）——${item.why ?? ''} id:${item.id} ${suggestLine(item)}`);
          }
          if ((value.noEvidence ?? []).length > 10) lines.push(`- …还有 ${value.noEvidence.length - 10} 条`);
        }
        if (counts.expired) {
          lines.push('', '## 已过期（不再进 L1）');
          for (const item of (value.expired ?? []).slice(0, 10)) {
            lines.push(`- [${item.type}] ${item.title}（设的 ${item.expires} 已过）——${item.why ?? ''} id:${item.id} ${suggestLine(item)}`);
          }
          if ((value.expired ?? []).length > 10) lines.push(`- …还有 ${value.expired.length - 10} 条`);
        }
        if (counts.ignored) {
          lines.push('', '## 你忽略过的（不再出现在上面几组）');
          for (const item of (value.ignoredEntries ?? []).slice(0, 10)) {
            lines.push(`- [${item.type}] ${item.title}（${item.action === 'kept' ? '留着' : '忽略'}）id:${item.id}`);
          }
          if ((value.ignoredEntries ?? []).length > 10) lines.push(`- …还有 ${value.ignoredEntries.length - 10} 条`);
        }
        if (!counts.stale && !counts.unused && !counts.merge && !counts.noEvidence && !counts.expired && !counts.ignored) {
          lines.push('', '单子都是空的。要么库很干净，要么 reads / hits 数据还不够——先用一段时间再看。');
        }
        lines.push('', '（只出单子：要不要归档、合并由你定，这里什么都没改。）');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      const now = args.now ? new Date(`${args.now}T12:00:00`) : new Date();
      const review = reviewVault(vaultPath, { now });
      return { ok: true, ...review };
    },
  };

  const memoryMigrate = {
    name: 'memory_migrate',
    get description() {
      return '把旧记忆库（dsh-memory-evolve 的 MEMORY.md / USER.md / projects/<项目>/KEY.md）迁进 vault：先预览会拆出哪些条目、跳过哪些（库里已有同标题或同内容），确认后以 candidate 写进 Inbox/ 等人确认；旧日记与旧项目日志原样抄到 Archive/ 下留档，不参与检索。默认 dryRun。';
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '旧库根目录（默认 ~/.dsh/memories）' },
        dryRun: { type: 'boolean', description: '默认 true（只看清单）；传 false 才真写' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'dryRun', 'message'],
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          root: { type: 'string' },
          planned: {
            type: 'object',
            additionalProperties: false,
            properties: {
              entries: { type: 'integer' },
              journals: { type: 'integer' },
              logs: { type: 'integer' },
              skipped: { type: 'integer' },
              scannedFiles: { type: 'integer' },
            },
          },
          written: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, title: { type: 'string' }, type: { type: 'string' }, path: { type: 'string' } },
            },
          },
          preview: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, type: { type: 'string' } } } },
          journals: { type: 'integer' },
          logs: { type: 'integer' },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { title: { type: 'string' }, reason: { type: 'string' } },
            },
          },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: `没迁成：${value?.message ?? '未知原因'}` }];
        if (value.dryRun) {
          const planned = value.planned ?? {};
          const lines = [
            `预览：旧库 ${value.root ?? ''}`,
            `会拆出 ${planned.entries ?? 0} 条记忆（写成 candidate，进 Inbox/），日记 ${planned.journals ?? 0} 篇、旧项目日志 ${planned.logs ?? 0} 个抄到 Archive/ 留档；库里已有而跳过的 ${planned.skipped ?? 0} 条。`,
            ...(value.preview ?? []).slice(0, 10).map((item) => `- [${item.type}] ${item.title}`),
            '确认没问题就传 dryRun:false 真写。',
          ];
          return [{ type: 'text', text: lines.join('\n') }];
        }
        return [
          {
            type: 'text',
            text: [
              `迁移完成：写了 ${value.written?.length ?? 0} 条 candidate（进 Inbox/ 等人确认），日记 ${value.journals ?? 0} 篇、旧日志 ${value.logs ?? 0} 个抄到 Archive/。`,
              ...(value.written ?? []).slice(0, 8).map((item) => `- [${item.type}] ${item.title}`),
              ...(value.skipped ?? []).slice(0, 5).map((item) => `- 跳过 ${item.title}：${item.reason}`),
            ].join('\n'),
          },
        ];
      },
    },
    async execute(args) {
      const root = String(args?.root ?? '').trim() || defaultLegacyRoot();
      const dryRun = args?.dryRun !== false;
      const plan = planMigration({ root, vaultPath });
      if (!plan.ok) return { ok: false, dryRun, root, message: plan.message };
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          root,
          planned: plan.counts,
          preview: plan.entries.slice(0, 20).map((entry) => ({ title: entry.title, type: entry.type })),
          journals: plan.journals.length,
          logs: plan.logs.length,
          skipped: plan.skipped.slice(0, 20),
          message: '',
        };
      }
      const applied = applyMigration(plan, { vaultPath });
      if (!applied.ok) return { ok: false, dryRun, root, message: applied.message };
      try {
        writeIndex(vaultPath);
      } catch {
        // 索引失败不影响已落盘的文件
      }
      return {
        ok: true,
        dryRun: false,
        root,
        planned: plan.counts,
        written: applied.written,
        journals: applied.journals.length,
        logs: applied.logs.length,
        skipped: applied.skipped.slice(0, 20),
        message: '',
      };
    },
  };

  const memoryArchive = {
    name: 'memory_archive',
    get description() {
      return '归档 / 恢复一条记忆。归档＝把文件挪进 Archive/（不删，随时能恢复），用于「不再成立但值得留着看」的；如果只是被新结论替代，用 memory_write 的 supersedes 更合适（会留替代关系）。恢复时按 id 在 Archive/ 里找，按 type 挪回对应目录。';
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '记忆 id（或文件路径尾部）' },
        restore: { type: 'boolean', description: 'true = 从 Archive 恢复；默认 false = 归档过去' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'id', 'path'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          from: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) {
          return [{ type: 'text', text: `没成功：${value?.message ?? '未知原因'}` }];
        }
        if (value.action === 'restored') {
          return [
            {
              type: 'text',
              text: [`已从归档恢复：${value.title ?? value.id}`, `文件回到：${value.path}`, value.message ? `注意：${value.message}` : '']
                .filter(Boolean)
                .join('\n'),
            },
          ];
        }
        return [
          {
            type: 'text',
            text: [`已归档：${value.title ?? value.id}`, `文件在：${value.path}`, '没删，随时能恢复（memory_archive 传 restore=true）。']
              .filter(Boolean)
              .join('\n'),
          },
        ];
      },
    },
    async execute(args) {
      const restore = args?.restore === true;
      if (restore) {
        const outcome = restoreMemory(vaultPath, String(args.id ?? ''));
        if (!outcome?.ok) return { ok: false, action: 'restored', id: String(args.id ?? ''), path: '', message: outcome?.message ?? '没找到' };
        const memory = readMemoryFile(outcome.path, vaultPath);
        try {
          writeIndex(vaultPath);
        } catch {
          // 索引重建失败不影响已挪回的文件
        }
        return { ok: true, action: 'restored', id: String(args.id ?? ''), title: memory?.title ?? '', path: outcome.path, message: '' };
      }
      const target = findMemory(loadMemories(vaultPath), String(args?.id ?? ''));
      if (!target) return { ok: false, action: 'archived', id: String(args?.id ?? ''), path: '', message: '找不到这条记忆' };
      const outcome = archiveMemory(target.path, { vaultPath });
      if (!outcome?.ok) return { ok: false, action: 'archived', id: String(args?.id ?? ''), path: '', message: outcome?.message ?? '归档失败' };
      try {
        writeIndex(vaultPath);
      } catch {
        // 索引重建失败不影响已挪走的文件
      }
      return { ok: true, action: 'archived', id: target.id, title: target.title, path: outcome.path, message: '' };
    },
  };

  const memoryLint = {
    name: 'memory_lint',
    get description() {
      return (
        '结构体检：只看文件本身写得对不对——frontmatter 缺字段、type / status 不认识、' +
        'tags 混了类型词或重复、正文为空或太短、id 重复、created_at 晚于 updated_at、目录与类型不符。' +
        '只出单子，不改任何文件；内容层面的过时 / 没用 / 可合并看 memory_review。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        max: { type: 'integer', description: '最多列几条（默认 200）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          scanned: { type: 'number' },
          flagged: { type: 'number' },
          counts: {
            type: 'object',
            properties: {
              error: { type: 'number' },
              warning: { type: 'number' },
              info: { type: 'number' },
            },
            required: ['error', 'warning', 'info'],
            additionalProperties: false,
          },
          codes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                count: { type: 'number' },
              },
              required: ['code', 'count'],
              additionalProperties: false,
            },
          },
          truncated: { type: 'boolean' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                type: { type: 'string' },
                status: { type: 'string' },
                path: { type: 'string' },
                level: { type: 'string' },
                problems: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      level: { type: 'string' },
                      message: { type: 'string' },
                      fix: { type: 'string' },
                    },
                    required: ['code', 'level', 'message'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['id', 'title', 'level', 'problems'],
              additionalProperties: false,
            },
          },
        coexist: {
          type: 'object',
          properties: {
            installed: { type: 'boolean' },
            version: { type: 'string' },
            archives: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  world: { type: 'string' },
                  size: { type: 'number' },
                  at: { type: 'string' },
                },
                required: ['world'],
                additionalProperties: false,
              },
            },
            hint: { type: 'string' },
          },
          required: ['installed'],
          additionalProperties: false,
        },
        },
        required: ['ok', 'scanned', 'flagged', 'counts'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: value?.message ?? '结构体检没跑成' }];
        const counts = value.counts ?? {};
        const lines = [
          '结构体检：扫了 ' + (value.scanned ?? 0) + ' 条，' + (value.flagged ?? 0) + ' 条有结构问题' +
            '（error ' + (counts.error ?? 0) + ' / warning ' + (counts.warning ?? 0) + ' / info ' + (counts.info ?? 0) + '）',
        ];
        const label = { error: '错', warning: '警', info: '提示' };
        for (const row of (value.rows ?? []).slice(0, 10)) {
          const problems = (row.problems ?? []).map((item) => item.message).join('；');
          lines.push('- [' + (label[row.level] ?? row.level) + '] ' + row.title + '：' + problems);
        }
        if ((value.rows ?? []).length > 10 || value.truncated) lines.push('…（还有更多，传 max 调条数）');
        lines.push('', '（只出单子：结构问题由你或 memory_update 改，这里什么都没动。）');
        if (value.coexist?.installed || (value.coexist?.archives ?? []).length) {
          const worlds = (value.coexist.archives ?? []).map((item) => item.world).join('、');
          lines.push('', '共存：这台机器还装了 dsh-world' + (value.coexist.version ? ' ' + value.coexist.version : '') +
            (worlds ? '，它的原话归档在 ' + worlds + ' 的 archive.sqlite' : '') +
            '（跟 vault 不互通）。' + (value.coexist.hint ?? ''));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      const report = lintVault(vaultPath, { max: args.max ?? 200 });
      const coexist = detectCompanionMemory();
      // DSH 的 JSON schema 只认 additionalProperties: boolean，map 形状要转成数组。
      return { ok: true, ...report, coexist, codes: Object.entries(report.codes ?? {}).map(([code, count]) => ({ code, count })) };
    },
  };

  const memoryTend = {
    name: 'memory_tend',
    get description() {
      return (
        '按体检单子的建议处理一批记忆：工具给建议、你点头、它执行、每条留一行痕迹。' +
        '只做可逆动作（标 superseded / 补 evidence / 降为 candidate / 续期 / 合并时两边都保留），绝不删文件；' +
        'decision / preference 两类直接拒绝；每处理一条往 Daily 流水写一行（带 [插件] 标记）。' +
        '默认 dryRun=true 只看会做什么，真要执行传 dryRun:false。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要处理哪几条',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              action: { type: 'string', description: 'supersede / evidence / demote / renew / merge；省略则用体检单上的建议' },
              value: { type: 'string', description: 'evidence 要写的出处，或 renew 的目标日期' },
              drop: { type: 'string', description: 'merge 时让位的那条 id' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
        dryRun: { type: 'boolean', description: 'true 只看会做什么（默认），false 才真动' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          applied: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                action: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' },
                path: { type: 'string' },
              },
              required: ['id', 'title', 'action', 'before', 'after'],
              additionalProperties: false,
            },
          },
          skipped: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['id', 'reason'],
              additionalProperties: false,
            },
          },
          logged: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: value?.message ?? '没处理成' }];
        const lines = [];
        const applied = value.applied ?? [];
        const skipped = value.skipped ?? [];
        const head = value.dryRun ? '（试运行，什么都没改）' : '已处理';
        lines.push(`${head} ${applied.length} 条${skipped.length ? `，跳过 ${skipped.length} 条` : ''}${value.logged ? `，流水记了 ${value.logged} 行` : ''}。`);
        for (const item of applied) {
          lines.push(
            `- ${item.title}（${item.id}）：${item.action}；动之前 ${item.before} → 动之后 ${item.after}；文件 ${item.path ?? ''}`,
          );
        }
        if (skipped.length) {
          lines.push('', '跳过：');
          for (const item of skipped) lines.push(`- ${item.title ?? item.id}：${item.reason}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      return tendVault(vaultPath, {
        items: Array.isArray(args.items) ? args.items : [],
        dryRun: args.dryRun !== false,
        now: new Date(),
      });
    },
  };

  const memoryExport = {
    name: 'memory_export',
    get description() {
      return (
        '把整个记忆库导出成一个记忆包文件夹（Markdown 原样复制 + MANIFEST.json 记录每个文件的 sha256 与字节）。' +
        '默认导到 ~/.dsh/memory-exports/。不导出 .dsh-memory/（索引、锁、备份、hits 是本机运行态）。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        outRoot: { type: 'string', description: '导出到哪个根目录（默认 ~/.dsh/memory-exports）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dir: { type: 'string' },
          files: { type: 'number' },
          counts: {
            type: 'object',
            properties: {
              memories: { type: 'number' },
              daily: { type: 'number' },
              projects: { type: 'number' },
            },
            required: ['memories', 'daily', 'projects'],
            additionalProperties: false,
          },
          at: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: `导出没成功：${value?.message ?? '未知原因'}` }];
        return [
          {
            type: 'text',
            text:
              `已导出 ${value.files} 个文件到：${value.dir}\n` +
              `（记忆 ${value.counts?.memories ?? 0} / 流水 ${value.counts?.daily ?? 0} / 项目 ${value.counts?.projects ?? 0}；MANIFEST.json 里有每个文件的 sha256）`,
          },
        ];
      },
    },
    async execute(args = {}) {
      const outRoot = String(args.outRoot ?? '').trim();
      return exportBundle(vaultPath, outRoot ? { outRoot } : {});
    },
  };

  const memoryImport = {
    name: 'memory_import',
    get description() {
      return (
        '导入一个记忆包（默认 dryRun: true，只报告会写什么）。先逐文件校验 sha256，有一个不符就一条都不写；' +
        '同名但内容不同的文件不覆盖，另存为 `.导入-<时间>.md`。确认清单后用 dryRun: false 真正落盘。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        bundle: { type: 'string', description: '记忆包文件夹路径（含 MANIFEST.json 的那个目录）' },
        dryRun: { type: 'boolean', description: '默认 true（只看清单）；传 false 才真正写入' },
      },
      required: ['bundle'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          dryRun: { type: 'boolean' },
          bundle: { type: 'string' },
          at: { type: 'string' },
          verified: { type: 'number' },
          written: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                target: { type: 'string' },
                conflict: { type: 'boolean' },
              },
              required: ['path', 'target'],
              additionalProperties: false,
            },
          },
          skipped: { type: 'array', items: { type: 'string' } },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                target: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['path', 'target', 'reason'],
              additionalProperties: false,
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['path', 'reason'],
              additionalProperties: false,
            },
          },
          counts: {
            type: 'object',
            properties: {
              memories: { type: 'number' },
              daily: { type: 'number' },
              projects: { type: 'number' },
            },
            required: ['memories', 'daily', 'projects'],
            additionalProperties: false,
          },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) {
          const head = `导入没成功：${value?.message ?? '未知原因'}`;
          const details = (value?.errors ?? []).slice(0, 5).map((item) => `- ${item.path}：${item.reason}`);
          return [{ type: 'text', text: [head, ...details].join('\n') }];
        }
        const written = value.written?.length ?? 0;
        const conflict = (value.conflicts ?? []).length;
        const skipped = (value.skipped ?? []).length;
        const lines = [];
        if (value.dryRun) {
          lines.push(`预览（没有写任何文件）：会写 ${written} 条，其中 ${conflict} 条同名冲突会另存；跳过 ${skipped} 条已存在且内容相同。`);
          lines.push(`校验通过 ${value.verified ?? 0} 个文件，清单来自 ${value.at ?? '未知时间'}。`);
          lines.push('确认后传 dryRun: false 落盘。');
        } else {
          lines.push(`已导入：写 ${written} 条，其中 ${conflict} 条同名冲突另存；跳过 ${skipped} 条已存在且内容相同。`);
        }
        for (const item of (value.conflicts ?? []).slice(0, 5)) {
          lines.push(`- 冲突另存：${item.path} → ${item.target}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      const bundle = String(args.bundle ?? '').trim();
      if (!bundle) return { ok: false, message: '要给 bundle（记忆包文件夹路径）' };
      return importBundle(bundle, { vaultPath, dryRun: args.dryRun !== false });
    },
  };

  // 第 7 条（2026-11-26）：把 L0/L1 的选择摊开——命中词、分数、被哪个阈值挡下。
  const EXPLAIN_ROW_PROPS = {
    id: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    score: { type: 'number' },
    hits: { type: 'number' },
    strongHits: { type: 'number' },
    retention: { type: 'number' },
    final: { type: 'number' },
    matched: { type: 'array', items: { type: 'string' } },
    inL0: { type: 'boolean' },
    pass: { type: 'boolean' },
    blocked: { type: 'array', items: { type: 'string' } },
  };

  const memoryExplain = {
    name: 'memory_explain',
    get description() {
      return (
        '解释这轮的 L0 / L1 为什么是这几条（只读）：' +
        '不传参数看上一轮实际注入的快照；传 query 按这句话预览 L1，列出线索词、每条候选的分数与「被哪个阈值挡下」；' +
        '传 id 解释某一条——为什么没进 L0、用它自己的标题能不能被检索出来。'
      );
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '按这句话预览 L1 检索（像用户刚说的一句话）' },
        id: { type: 'string', description: '解释某一条记忆' },
        max: { type: 'integer', description: '预览最多列几条（默认 10）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          message: { type: 'string' },
          total: { type: 'number' },
          l0Candidates: { type: 'number' },
          at: { type: 'string' },
          session: { type: 'string' },
          chars: {
            type: 'object',
            properties: { l0: { type: 'number' }, l1: { type: 'number' }, budget: { type: 'number' } },
            required: [],
            additionalProperties: false,
          },
          l0: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                importance: { type: 'number' },
                title: { type: 'string' },
                chars: { type: 'number' },
              },
              required: ['id', 'title'],
              additionalProperties: false,
            },
          },
          l1: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                title: { type: 'string' },
                hits: { type: 'number' },
                matched: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
              },
              required: ['id', 'title'],
              additionalProperties: false,
            },
          },
          query: { type: 'string' },
          tokens: { type: 'array', items: { type: 'string' } },
          thresholds: {
            type: 'object',
            properties: {
              maxItems: { type: 'number' },
              minHits: { type: 'number' },
              minScore: { type: 'number' },
              minStrongHits: { type: 'number' },
            },
            required: [],
            additionalProperties: false,
          },
          selected: { type: 'number' },
          rows: {
            type: 'array',
            items: { type: 'object', properties: EXPLAIN_ROW_PROPS, required: ['id', 'title'], additionalProperties: false },
          },
          id: { type: 'string' },
          title: { type: 'string' },
          type: { type: 'string' },
          status: { type: 'string' },
          pinned: { type: 'boolean' },
          importance: { type: 'number' },
          updated: { type: 'string' },
          expires: { type: 'string' },
          reads: { type: 'number' },
          inL0: { type: 'boolean' },
          dead: { type: 'array', items: { type: 'string' } },
          self: { type: 'object', properties: EXPLAIN_ROW_PROPS, required: ['id', 'title'], additionalProperties: false },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value?.ok) return [{ type: 'text', text: value?.message ?? '解释不出来（多半是参数没对上）' }];
        if (value.mode === 'state') {
          const used = (Number(value.chars?.l0) || 0) + (Number(value.chars?.l1) || 0);
          const lines = [
            `上一轮注入（${value.at || '还没记录'}）：L0 ${value.l0?.length ?? 0} 条 / L1 ${value.l1?.length ?? 0} 条，共 ${used} 字（预算 ${value.chars?.budget ?? 0}）。`,
            `库里共 ${value.total ?? 0} 条，其中 L0 候选 ${value.l0Candidates ?? 0} 条。`,
          ];
          for (const item of value.l0 ?? []) lines.push(`- L0 [${item.type}·${item.importance}] ${item.title}（${item.id}）`);
          for (const item of value.l1 ?? []) {
            const matched = item.matched?.length ? `：${item.matched.join('、')}` : '';
            lines.push(
              `- L1 [${item.type}] ${item.title}（${item.id}）— 命中 ${item.hits ?? 0} 个词${matched}，分 ${Math.round((Number(item.score) || 0) * 10) / 10}`,
            );
          }
          if (!(value.l0?.length || value.l1?.length)) lines.push('上一轮 L0/L1 都没带东西（空会话，或刚重载还没跑过一轮）。');
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (value.mode === 'recall') {
          const lines = [
            `线索词：${value.tokens?.length ? value.tokens.join('、') : '（没切出可用的词）'}`,
            `阈值：命中 ≥${value.thresholds?.minHits} 个词、分数 ≥${value.thresholds?.minScore}、标题/标签命中 ≥${value.thresholds?.minStrongHits ?? 0}；最多 ${value.thresholds?.maxItems} 条。`,
          ];
          if (!value.tokens?.length) lines.push('这句话切不出 2 个以上的词，L1 不会注入任何东西。');
          for (const row of value.rows ?? []) {
            const flag = row.pass ? '✓' : '✗';
            const matched = row.matched?.length ? `（${row.matched.join('、')}）` : '';
            const detail = row.pass ? '会被注入' : `被挡：${row.blocked.join('；')}`;
            lines.push(
              `${flag} [${row.type}] ${row.title}（${row.id}）— 分 ${row.score} × 保留 ${row.retention} = ${row.final}；命中 ${row.hits} 个${matched}；${detail}`,
            );
          }
          lines.push(`这批里会注入 ${value.selected ?? 0} 条。`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        const lines = [
          `${value.title}（${value.id}）`,
          `type=${value.type}，status=${value.status}，pinned=${value.pinned ? '是' : '否'}，重要度 ${value.importance}，读过 ${value.reads} 次，updated ${value.updated || '(空)'}。`,
          value.inL0
            ? 'L0：在（pinned 的 verified decision/preference，每轮都带）。'
            : `L0：不在${value.dead?.length ? `（${value.dead.join('；')}）` : ''}。`,
        ];
        if (value.self) {
          lines.push(
            `L1 自测（用它自己的标题当线索）：分 ${value.self.score} × 保留 ${value.self.retention} = ${value.self.final}，${value.self.pass ? '会被选中' : `被挡：${value.self.blocked.join('；')}`}。`,
          );
        } else {
          lines.push('L1 自测：用它自己的标题检索不到它——标题里的词对不上词表，检索时会漏。');
        }
        if (value.dead?.length) lines.push(`不注入的原因：${value.dead.join('；')}。`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args = {}) {
      if (args.query) return explainRecall(vaultPath, args.query, { max: args.max });
      if (args.id) return explainOne(vaultPath, args.id);
      return explainState(vaultPath);
    },
  };

  return [memorySearch, memoryGet, memoryWrite, memoryUpdate, memoryDigest, memoryReview, memoryTend, memoryLint, memoryArchive, memoryMigrate, memoryExport, memoryImport, memoryExplain];
}
