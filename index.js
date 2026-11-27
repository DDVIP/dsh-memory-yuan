/**
 * dsh-memory-yuan
 * ================
 * 渊自己的记忆插件。当前完成到「下一步清单」第 4 条：L0 注入 + 三个工具 + L1 线索检索，
 * 外加 room/记忆插件-UI设计.md 要的「这一轮带了什么」页签（client 侧）。
 *
 * 三步走（见 room/记忆插件-设计.md）：
 *   L0 每轮全量  —— pinned 的 decision/preference，本文件注入（order 600）
 *   L1 按线索     —— 命中本轮对话关键词才注入摘要，每行一条（order 9000，放尾部）
 *   L2 按需       —— 日记/交接/笔记只给路径（未做）
 *
 * 关键写法（踩过坑）：`inject` 必须是静态导出；动态 `ctx.inject(...)` 这个版本静默失效。
 * `text` 可以是函数，每轮调用一次 —— 所以改记忆文件不用重启 DSH。
 *
 * UI 数据靠 vault/.dsh-memory/{last-inject,index}.json：L1 渲染时顺手写一份快照，
 * client 用 fetch('/memory-yuan/state') 拿。
 */
import { DEFAULT_VAULT, loadMemories } from './lib/vault.js';
import { L0_DEFAULTS, renderL0, selectL0 } from './lib/l0.js';
import { L1_DEFAULTS, buildL1, collectConversationTexts, selectL1 } from './lib/l1.js';
import { createTools } from './lib/tools.js';
import { charCount, l0Snapshot, l1Snapshot, readHits, writeInjection, writeIndex } from './lib/snapshot.js';
import { registerRoutes } from './lib/api.js';
import { runDigestNow, startDigestScheduler } from './lib/digest-scheduler.js';
import { effectiveL1Options } from './lib/l1settings.js';

export const name = 'memory-yuan';
/**
 * 只声明「缺了就不能活」的服务。webServer / llm / settings 是可选能力：
 * 放进静态 inject 会让插件在没装这些服务的宿主上直接不激活（开源给别人用时常见），
 * 所以改用下面的 ctx.inject([...]) 按需挂，缺了只是少一个 HTTP 面或停掉收盘。
 */
export const inject = ['systemPrompt', 'tools'];

const STANDING_NAME = 'memory-yuan:standing';
const RECALL_NAME = 'memory-yuan:recall';

/** memory-evolve 的快照在 order 500，L0 紧跟其后。 */
const STANDING_ORDER = 600;
/**
 * L1 每轮内容都会变；系统提示词按前缀缓存，放太靠前会让后面所有段失配。
 * 放到 HARNESS_SOURCE(10000) 之前，只让尾部一小段失效。
 */
const RECALL_ORDER = 9000;

export function apply(ctx, config = {}) {
  const vaultPath = config.vaultPath || process.env.MEMORY_YUAN_VAULT || DEFAULT_VAULT;
  const options = {
    vaultPath,
    maxItems: config.l0MaxItems ?? L0_DEFAULTS.maxItems,
    maxChars: config.l0MaxChars ?? L0_DEFAULTS.maxChars,
    maxCoreChars: config.l0MaxCoreChars ?? L0_DEFAULTS.maxCoreChars,
  };
  const recallOptions = {
    maxItems: config.l1MaxItems ?? L1_DEFAULTS.maxItems,
    minHits: config.l1MinHits ?? L1_DEFAULTS.minHits,
    minScore: config.l1MinScore ?? L1_DEFAULTS.minScore,
    maxCoreChars: config.l1MaxCoreChars ?? L1_DEFAULTS.maxCoreChars,
  };
  const uiBudget = config.uiBudget ?? 4000;

  /** 注册一个注入段，把 "already registered" 吞掉（旧 loader 会装配两次）。 */
  const registerSection = (section, label) => {
    ctx.effect(
      () => {
        try {
          return ctx.systemPrompt.context(section);
        } catch (error) {
          if (error instanceof Error && error.message.includes('already registered')) {
            console.warn(`[memory-yuan] ${section.name} 已注册，跳过重复注册`);
            return () => {};
          }
          throw error;
        }
      },
      { label },
    );
  };

  // ---- L0：pinned 的硬规矩，每轮全量 ----
  registerSection(
    {
      name: STANDING_NAME,
      order: config.order ?? STANDING_ORDER,
      text: () => {
        try {
          const selected = selectL0(loadMemories(vaultPath), options);
          return renderL0(selected, options);
        } catch (error) {
          console.warn('[memory-yuan] L0 生成失败：', error?.message ?? error);
          return '';
        }
      },
    },
    'memory-yuan: L0 standing',
  );

  // ---- L1：按这轮对话的线索检索，命中才注入；顺手写 UI 快照 ----
  registerSection(
    {
      name: RECALL_NAME,
      order: config.recallOrder ?? RECALL_ORDER,
      text: (context) => {
        try {
          const memories = loadMemories(vaultPath);
          // 每次自己算一遍（0.03ms）：多会话并发时共享的 currentL0 会串到别的会话上。
          const selected = selectL0(memories, options);
          const excludeIds = new Set(selected.map((memory) => memory.id));
          // 开局（用户只说了 1–2 句）多给两条：新窗口第一句最需要上下文，之后回到常态。
          const opening = collectConversationTexts(context).length <= 2;
          const baseRecall = effectiveL1Options(vaultPath, recallOptions);
          const recall = opening ? { ...baseRecall, maxItems: Math.max(6, baseRecall.maxItems) } : baseRecall;
          // 热度：L1 命中的次数（hits.json）+ 被读过（frontmatter reads）一起当强化信号。
          const hits = readHits(vaultPath);
          const recallSet = { ...recall, excludeIds, hits };
          const text = buildL1(memories, context, recallSet);

          const { rows } = selectL1(memories, context, recallSet);
          writeInjection({
            vaultPath,
            session: context?.agent?.session?.header?.id ?? '',
            l0: l0Snapshot(selected),
            l1: l1Snapshot(rows),
            chars: {
              l0: charCount(renderL0(selected, options)),
              l1: charCount(text),
              budget: uiBudget,
            },
          });
          return text;
        } catch (error) {
          console.warn('[memory-yuan] L1 生成失败：', error?.message ?? error);
          return '';
        }
      },
    },
    'memory-yuan: L1 recall',
  );

  // ---- 索引：不依赖任何服务，先建一份给 UI 读 ----
  try {
    writeIndex(vaultPath);
  } catch (error) {
    console.warn('[memory-yuan] 索引初始化失败：', error?.message ?? error);
  }

  // ---- UI：同源 HTTP 路由。webServer 是可选能力，宿主没装就只少一个 HTTP 面 ----
  // 面板上的「重跑收盘」要模型能力（llm + settings），那在另一个作用域里；
  // 这里用 getter 桥一层：没模型能力时 run 为 null，路由回 501 而不是假装成功。
  let digestRunner = null;
  const digestBridge = {
    get run() {
      return digestRunner;
    },
  };
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => {
        try {
          return registerRoutes(scoped, { vaultPath, budget: uiBudget, digest: digestBridge });
        } catch (error) {
          console.warn('[memory-yuan] UI 路由注册失败：', error?.message ?? error);
          return () => {};
        }
      },
      { label: 'memory-yuan: ui routes' },
    );
  });

  // ---- 收盘定时器：插件自己到点跑，不依赖自动化任务/工作区 ----
  // 需要 llm + settings 才能调模型；缺了就别开定时器，记忆本身照常读写。
  ctx.inject(['llm', 'settings'], (scoped) => {
    scoped.effect(
      () => {
        digestRunner = (opts = {}) =>
          runDigestNow({
            vaultPath,
            llm: scoped.llm,
            settings: scoped.settings,
            provider: config.digestProvider,
            model: config.digestModel,
            ...opts,
          });
        return () => {
          digestRunner = null;
        };
      },
      { label: 'memory-yuan: manual digest' },
    );

    scoped.effect(
      () =>
        startDigestScheduler({
          ctx: scoped,
          vaultPath,
          config: {
            digestEnabled: config.digestEnabled,
            digestAt: config.digestAt,
            digestProvider: config.digestProvider,
            digestModel: config.digestModel,
            digestTickMs: config.digestTickMs,
          },
          log: console,
        }),
      { label: 'memory-yuan: digest scheduler' },
    );
  });

  // ---- 工具：memory_search / memory_get / memory_write / memory_digest ----
  // 没命中 L0/L1 的记忆不进上下文，靠这三个工具按线索捞。
  ctx.effect(
    () => {
      const disposers = [];
      for (const tool of createTools({ vaultPath })) {
        try {
          const handle = ctx.tools.register(tool);
          if (typeof handle === 'function') disposers.push(handle);
          else if (handle && typeof handle.dispose === 'function') disposers.push(() => handle.dispose());
        } catch (error) {
          if (error instanceof Error && error.message.includes('already registered')) {
            console.warn(`[memory-yuan] 工具 ${tool.name} 已注册，跳过重复注册`);
            continue;
          }
          throw error;
        }
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    { label: 'memory-yuan: tools' },
  );
}
