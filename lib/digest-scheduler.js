/**
 * 收盘定时器：插件自己到点跑收盘，不依赖「自动化任务 / 工作区 / 某个会话」。
 *
 * 为什么放在插件里（主人 2026-11-22 决定）：
 *   - 自动化任务会绑定一个工作区，另一个班次看不到；
 *   - 收盘本来就是记忆插件的职责，跟插件一起全局生效才合理。
 *
 * 边界：
 *   - 随 DSH 进程存活：DSH 没开就不跑（与自动化任务同）；
 *   - 一天只跑一次（.dsh-memory/digest-state.json 记 lastRunDate）；
 *   - 过了 23:00 才启动 DSH 也会补跑当天；
 *   - 失败不静默：当天流水里留「收盘没跑成，原因：X」，state 里也记 lastError。
 *
 * 模型调用走宿主 ctx.llm（不用另配 key）：provider/model 优先用插件 Config，
 * 没配就从 ctx.llm.listProviders() 里挑第一个有模型的。
 */

import fs from 'node:fs';
import path from 'node:path';

import { localDateStamp } from './stream.js';
import { noteFailure, readDaily, summaryPathOf, validateSentences, writeSummary } from './digest.js';

const DEFAULT_AT = '23:00';
const DEFAULT_TICK_MS = 60_000;
const MIN_SENTENCES = 3;
const MAX_SENTENCES = 6;

const DIGEST_SYSTEM = [
  '你是记忆归拢助手。用户会把一天的流水（每条一行，带时间）交给你。',
  '把这些流水收成 3–6 条有主语的完整句子，保留做了什么、为什么、结果。',
  '只输出句子本身，每行一句；不要编号、不要解释、不要标题、不要空行。',
  '不要编造流水里没有的事；流水太碎就合并，不要逐行复述。',
  '每条不超过 80 字，必须以句号、问号或叹号结尾；写不完整就少写一条，不要留半句。',
].join('\n');

/** "23:00" → {hour, minute}；不合法返回 null。 */
export function parseAt(at) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(at ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function statePathOf(vaultPath) {
  return path.join(vaultPath, '.dsh-memory', 'digest-state.json');
}

export function readDigestState(vaultPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePathOf(vaultPath), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDigestState(vaultPath, state) {
  const file = statePathOf(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function asList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

/**
 * 版本兼容读 settings 命名空间：
 * - 老宿主（≤0.1.5）：settings.get(ns)；
 * - 新宿主（0.2.0+）：settings.describe() 返回 [{ns, value}]，按 ns 查。
 * 读不到一律 undefined（按「未配置」处理，不让收盘因此崩掉）。
 */
export function readSettingsValue(settings, ns) {
  if (!settings || typeof ns !== 'string' || ns === '') return undefined;
  try {
    if (typeof settings.get === 'function') return settings.get(ns);
    if (typeof settings.describe === 'function') {
      const list = settings.describe();
      if (Array.isArray(list)) {
        const hit = list.find((entry) => entry && entry.ns === ns);
        if (hit) return hit.value;
      }
    }
  } catch {
    // 命名空间未注册 / schema 校验失败：按未配置处理。
  }
  return undefined;
}

/** 按路径取对象里的值（settingsPath 形如 ['providers','amazon-bedrock']）。 */
function getPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/** 从 settings 的 provider 配置里读 models 清单（每项 id 字符串）。 */
function modelsFromSettings(settings, entry) {
  if (!entry || typeof entry !== 'object') return [];
  const value = readSettingsValue(settings, entry.settingsNs);
  if (value === undefined) return [];
  const profile = Array.isArray(entry.settingsPath) && entry.settingsPath.length
    ? getPath(value, entry.settingsPath)
    : value;
  const raw = profile && Array.isArray(profile.models) ? profile.models : [];
  return raw
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((item) => typeof item === 'string' && item);
}

/**
 * 从 llm + settings 里挑一个能用的 provider/model；Config 优先。
 * listProviders() 只给 id/name（实测没有 models），模型清单在 settings 的
 * provider 配置里（ns=entry.settingsNs，settingsPath 未配时就是 value.models）；
 * 都取不到时退回 adapter 的 listModels()（可能是 Promise）。
 */
export async function listModelCandidates(llm, { provider, model, settings } = {}) {
  if (provider && model) return [{ provider: String(provider), model: String(model) }];
  const active = new Set(asList(llm?.listProviders?.()).map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.provider ?? entry?.name ?? entry?.key)).filter(Boolean));
  const entries = asList(llm?.listConfigurableProviders?.());
  const candidates = [];
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.provider ?? entry?.id ?? entry?.name;
    if (typeof id !== 'string' || !id) continue;
    if (!active.has(id)) continue;
    if (provider && id !== provider) continue;
    let models = modelsFromSettings(settings, entry);
    if (!models.length) {
      try {
        models = asList(await llm?.listModels?.(id))
          .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.model ?? item?.name))
          .filter((item) => typeof item === 'string' && item);
      } catch {
        models = [];
      }
    }
    if (!models.length) continue;
    if (model) {
      if (models.includes(model)) candidates.push({ provider: id, model });
      continue;
    }
    for (const each of models) candidates.push({ provider: id, model: each });
  }
  // 显式指定的 provider 排最前；账号登录型（id 含 account）优先于官方直连——
  // 官方直连用的是 provider 自己的 key，账号型用的是本机登录态，后者通常才是能用的那个。
  const rank = (item) => (item.provider === provider ? 0 : /account/i.test(item.provider) ? 1 : 2);
  return candidates.sort((a, b) => rank(a) - rank(b));
}

/** 兼容旧调用：取第一个可用候选。 */
export async function pickModel(llm, options = {}) {
  const candidates = await listModelCandidates(llm, options);
  return candidates[0] ?? null;
}

/** 模型输出 → 句子数组：去编号/列表符/标题行，保留非空行（条数交给 validateSentences 判）。 */
export function parseSentences(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, ''))
    .map((line) => line.replace(/^\d+[.、)]\s*/, ''))
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 同步读模型输出（llm.stream 是异步可迭代）。 */
async function generateSentences(llm, chosen, prompt) {
  let text = '';
  const stream = llm.stream({
    provider: chosen.provider,
    model: chosen.model,
    system: DIGEST_SYSTEM,
    maxTokens: 1600,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    purpose: 'memory-yuan-digest',
  });
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(chunk.reason.failure?.message ?? '模型返回 error');
    }
  }
  return text;
}

/**
 * 跑一次收盘：读当天流水 → 模型收句 → 写 summary。
 * 返回 {ok, skipped?, date, path?, count?, provider?, model?, message?}。
 */
export async function runDigest({ vaultPath, llm, settings, provider, model, date = localDateStamp(), now = new Date(), force = false } = {}) {
  const target = summaryPathOf(vaultPath, date);
  // force 是面板上「重跑收盘」用的：已有 summary 也重新生成（writeSummary 会先备份旧版）。
  if (!force && fs.existsSync(target)) return { ok: true, skipped: 'already', date, path: target };

  const daily = readDaily(vaultPath, date);
  if (!daily.ok) return { ok: true, skipped: 'empty', date, message: daily.message };
  if (!daily.lines.length) return { ok: true, skipped: 'empty', date, path: daily.path };

  const candidates = await listModelCandidates(llm, { provider, model, settings });
  if (!candidates.length) {
    const message = '没有可用的模型（llm.listProviders 为空），收盘没跑成';
    const noted = noteFailure(vaultPath, date, message);
    return { ok: false, date, message: `${message}${noted ? '（已在当天流水里留了一行）' : ''}` };
  }

  const prompt = [
    `日期：${date}`,
    ...(daily.lines.length > 200
      ? [`（流水共 ${daily.lines.length} 条，这里只给最近 200 条，更早的已省略）`]
      : []),
    '',
    '当天流水：',
    ...(daily.lines.length > 200 ? daily.lines.slice(-200) : daily.lines),
    '',
    `请收成 ${MIN_SENTENCES}–${MAX_SENTENCES} 条有主语的完整句子，每行一句，不要编号、不要解释。`,
  ].join('\n');

  let lastError = '';
  for (const chosen of candidates) {
    let hint = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let text = '';
      try {
        const retryPrompt = attempt === 1
          ? prompt
          : `${prompt}\n\n上一版没通过校验（${hint}）。请重写：3–6 条，每条以 。！？ 结尾、单条不超过 80 字，不要编号、不要解释。`;
        text = await generateSentences(llm, chosen, retryPrompt);
      } catch (error) {
        lastError = `${chosen.provider}/${chosen.model} 调模型失败：${error?.message ?? String(error)}`;
        break;
      }

      const sentences = parseSentences(text);
      const shape = validateSentences(sentences);
      if (!shape.ok) {
        hint = shape.reason;
        lastError = `${chosen.provider}/${chosen.model} 句子不合格（第 ${attempt} 次）：${shape.reason}`;
        continue;
      }

      const written = writeSummary(vaultPath, { date, sentences, at: now });
      if (!written.ok) {
        return { ok: false, date, provider: chosen.provider, model: chosen.model, ...written };
      }
      return {
        ok: true,
        date,
        path: written.path,
        count: written.count,
        provider: chosen.provider,
        model: chosen.model,
      };
    }
  }

  const noted = noteFailure(vaultPath, date, lastError || '没有模型能收成句子');
  return {
    ok: false,
    date,
    message: `${lastError || '没有模型能收成句子'}${noted ? '（已在当天流水里留了一行）' : ''}`,
  };
}

/**
 * 把一次收盘的结果记进 digest-state.json（面板靠它显示「上次跑到哪、失败原因」）。
 * 定时器与手动重跑共用这一份写法，避免两边字段不一致。
 */
export function recordDigestResult(vaultPath, date, now, result, { keepDay = false } = {}) {
  const state = readDigestState(vaultPath);
  const next = {
    ...state,
    lastRunDate: keepDay ? state.lastRunDate ?? "" : date,
    lastRunAt: now.toISOString(),
    lastResult: result?.ok ? result.skipped ?? 'ok' : 'failed',
    lastError: result?.ok ? '' : String(result?.message ?? ''),
    lastModel: result?.model ? `${result.provider}/${result.model}` : state.lastModel ?? '',
  };
  writeDigestState(vaultPath, next);
  return next;
}

/**
 * 手动跑一次收盘（面板「重跑收盘」按钮走这里）：跑完顺手记账。
 * 与定时器的区别只有 force——定时器只跑当天、已有 summary 就跳过；
 * 手动重跑默认 force:true，否则永远只会返回 already。
 */
export async function runDigestNow({ vaultPath, llm, settings, provider, model, date = localDateStamp(), now = new Date(), force = true } = {}) {
  const result = await runDigest({ vaultPath, llm, settings, provider, model, date, now, force });
  // 手动重跑不写 lastRunDate：否则白天一点，晚上 23:00 的自动收盘就以为今天跑过了。
  recordDigestResult(vaultPath, date, now, result, { keepDay: true });
  return result;
}

/**
 * 启动每分钟一次的判定：到点、当天没跑过，就补跑。
 * 返回清理函数，交给 ctx.effect。
 */
export function startDigestScheduler({ ctx, vaultPath, config = {}, log = console, now = () => new Date() } = {}) {
  if (config.digestEnabled === false) return () => {};
  const at = parseAt(config.digestAt ?? DEFAULT_AT);
  if (!at) {
    log.warn?.(`[memory-yuan] digestAt 不合法：${config.digestAt}，收盘定时器没启动`);
    return () => {};
  }
  const tickMs = Number(config.digestTickMs) > 0 ? Number(config.digestTickMs) : DEFAULT_TICK_MS;
  let running = false;

  const tick = async () => {
    if (running) return;
    const current = now();
    const stamp = localDateStamp(current);
    if (current.getHours() * 60 + current.getMinutes() < at.hour * 60 + at.minute) return;

    const state = readDigestState(vaultPath);
    if (state.lastRunDate === stamp) return;

    running = true;
    try {
      const result = await runDigest({
        vaultPath,
        llm: ctx?.llm,
        settings: ctx?.settings,
        provider: config.digestProvider,
        model: config.digestModel,
        date: stamp,
        now: current,
      });
      recordDigestResult(vaultPath, stamp, current, result);
      if (!result.ok) log.warn?.(`[memory-yuan] 收盘失败：${result.message}`);
      else if (result.skipped) log.log?.(`[memory-yuan] 收盘跳过（${result.skipped}）：${stamp}`);
      else log.log?.(`[memory-yuan] 收盘已写：${result.path}（${result.count} 句，${result.provider}/${result.model}）`);
    } catch (error) {
      const reason = error?.message ?? String(error);
      noteFailure(vaultPath, stamp, `收盘异常：${reason}`);
      recordDigestResult(vaultPath, stamp, current, { ok: false, message: reason });
      log.warn?.(`[memory-yuan] 收盘异常：${reason}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  if (typeof timer.unref === 'function') timer.unref();

  // 启动时先判定一次：过了 23:00 才开 DSH 也能补跑当天。
  void tick();

  return () => clearInterval(timer);
}
