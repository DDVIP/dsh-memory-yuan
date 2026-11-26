/**
 * 敏感内容扫描：记忆是明文 md，钥匙、token、私钥这类东西写进来就落盘了。
 *
 * 这里只做「提醒」，不做拦截——名字里带 password 的正常讨论（比如「密码不能写进记忆」）
 * 不该被拦。命中后由写入口把原样摘出来的片段脱敏（只留首尾各 4 个字符），提醒模型和主人。
 *
 * 2026-11-26 第 6 条（敏感内容）引入。
 */

export const SENSITIVE_KINDS = {
  privateKey: '私钥块',
  apiKey: 'API key / token 赋值',
  knownPrefix: '已知格式的密钥（sk-/ghp_/AKIA…）',
  bearer: 'Bearer 凭据',
  idCard: '身份证号',
  bankCard: '银行卡号',
  passwordUrl: '带账号密码的 URL',
};

/** 只留首尾各 4 个字符，中间打码。 */
function mask(value) {
  const s = String(value);
  if (s.length <= 12) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/** 摘出一个命中片段：前后各截 30 字，中间那截脱敏。 */
function excerptOf(line, match, keep = 26) {
  const start = Math.max(0, (match.index ?? 0) - keep / 2);
  const before = line.slice(start, match.index ?? 0);
  const after = line.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + keep);
  return `${String(before).trim()}${mask(match[1] ?? match[0])}${String(after).trim()}`.slice(0, 90);
}

const PATTERNS = [
  {
    kind: 'privateKey',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    whole: true,
  },
  {
    kind: 'apiKey',
    // key = value / key: value / "token": "value"；值至少 12 位，避免把「密码是六个字」误报
    re: /(api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=.]{12,})/i,
  },
  {
    kind: 'knownPrefix',
    re: /\b(sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  },
  {
    kind: 'bearer',
    re: /\bBearer\s+([A-Za-z0-9\-._~+/]{20,})/,
  },
  {
    kind: 'idCard',
    re: /\b(\d{17}[\dXx])\b/,
  },
  {
    kind: 'bankCard',
    re: /\b(\d{16,19})\b/,
  },
  {
    kind: 'passwordUrl',
    re: /(https?:\/\/[^/\s:@]+:)([^@\s/]{4,})@/,
  },
];

/**
 * 扫一段文本，返回命中的敏感片段。
 * @param {string} text
 * @param {{ max?: number }} [options]
 * @returns {Array<{kind: string, label: string, line: number, excerpt: string}>}
 */
export function scanSensitive(text, { max = 10 } = {}) {
  const body = String(text ?? '');
  if (!body) return [];
  const out = [];
  const seen = new Set();
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    for (const pattern of PATTERNS) {
      if (out.length >= max) return;
      const match = line.match(pattern.re);
      if (!match) continue;
      const key = `${pattern.kind}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: pattern.kind,
        label: SENSITIVE_KINDS[pattern.kind] ?? pattern.kind,
        line: index + 1,
        excerpt: excerptOf(line, match),
      });
    }
  });
  return out;
}

/** 人话提醒（写入口的 render 用）。 */
export function describeSensitive(hits) {
  if (!hits || !hits.length) return '';
  return [
    `⚠️ 正文里扫到 ${hits.length} 处像敏感信息的东西（记忆是明文 md，已经在盘上了）：`,
    ...hits.map((hit) => `- 第 ${hit.line} 行 ${hit.label}：${hit.excerpt}`),
    '建议：存「在哪」而不是「值本身」（比如「key 在 .env 的 DEEPSEEK_KEY」），或者删掉这段再写。',
  ].join('\n');
}
