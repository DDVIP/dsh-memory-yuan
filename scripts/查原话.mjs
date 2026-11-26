#!/usr/bin/env node
/**
 * 查原话：在 DSH 会话存档里按关键词找原文。
 *
 * 存档是每批事件一帧的 zstd 拼接（session.v4.jsonl.zstd），整文件解压只得第一帧，
 * 所以要按帧魔数 28 B5 2F FD 切开逐帧解压。
 *
 * 省的做法：
 *   --list            只列会话清单（不解压正文，读 mtime/大小/第一帧的 createdAt）
 *   --session <前缀>  只解压那一个会话
 *   --date/--from/--to 按时间过滤，命中够了就停
 *   --limit N         最多返回几条（默认 5）
 *
 * 用法：
 *   node 查原话.mjs "关键词"            默认只扫房间工作区
 *   node 查原话.mjs "关键词" --list     先看有哪些会话
 *   node 查原话.mjs "关键词" --session c9713597
 *   node 查原话.mjs "关键词" --date 2026-11-25
 *   node 查原话.mjs "关键词" --workspace all
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SESSIONS_ROOT = path.join(process.env.USERPROFILE ?? 'C:/Users/17207', '.dsh', 'sessions');
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const WORKSPACES = {
  room: '--C-Users-17207-.dsh-worlds-default-room--',
  home: '--C-Users-17207-.dsh-fish-home--',
};

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : true;
}

const has = (name) => process.argv.includes(`--${name}`);

/** 本地时间（Asia/Shanghai，固定 +08:00）。 */
function stamp(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function dayOf(ms) {
  const date = new Date(ms + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function* frames(buf) {
  let start = -1;
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === FRAME_MAGIC[0] && buf[i + 1] === FRAME_MAGIC[1] && buf[i + 2] === FRAME_MAGIC[2] && buf[i + 3] === FRAME_MAGIC[3]) {
      if (start >= 0) yield buf.subarray(start, i);
      start = i;
    }
  }
  if (start >= 0) yield buf.subarray(start);
}

function decompressFrame(frame) {
  try {
    return zlib.zstdDecompressSync(frame).toString('utf8');
  } catch {
    return '';
  }
}

/** 会话文件：<工作区>/<session-xxx>/session.v4.jsonl.zstd */
function listFiles() {
  const wantDir = arg('session', null);
  const workspaceArg = arg('workspace', null);
  // 指定了会话就跨所有工作区找；否则默认只扫房间
  const wantAll = workspaceArg === 'all' || (!!wantDir && !workspaceArg);
  const out = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return out;
  for (const dirName of fs.readdirSync(SESSIONS_ROOT)) {
    const dir = path.join(SESSIONS_ROOT, dirName);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!wantAll && WORKSPACES[workspaceArg ?? 'room'] && dirName !== WORKSPACES[workspaceArg ?? 'room']) continue;
    for (const id of fs.readdirSync(dir)) {
      if (!id.startsWith('session-')) continue;
      if (wantDir && !id.includes(String(wantDir))) continue;
      const file = path.join(dir, id, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      out.push({ dirName, id, file, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return out;
}

function listMode(files) {
  console.log(`会话存档 ${files.length} 个（工作区 ${arg('workspace', 'room')}）`);
  files.sort((a, b) => b.size - a.size);
  for (const item of files) {
    let createdAt = '';
    try {
      const buf = fs.readFileSync(item.file);
      const first = frames(buf).next().value;
      const text = first ? decompressFrame(first) : '';
      const line = text.split('\n').find((entry) => entry.includes('"type":"session"'));
      if (line) createdAt = stamp(JSON.parse(line).createdAt);
    } catch {}
    const mb = (item.size / 1024 / 1024).toFixed(2);
    console.log(`  ${item.id.slice(8, 16)}  ${mb.padStart(6)} MB  建于 ${createdAt || '?'}  ${item.dirName.replace(/^--/, '').slice(0, 30)}`);
  }
}

function messagesIn(file, { fromDay, toDay, words, limit }) {
  const buf = fs.readFileSync(file);
  const found = [];
  for (const frame of frames(buf)) {
    const text = decompressFrame(frame);
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
      const day = dayOf(event.time);
      if (fromDay && day < fromDay) continue;
      if (toDay && day > toDay) continue;
      // 用户消息正文在 data.content；助手消息在 data.message.content（含 reasoning / tool-call，只取 text）
      const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content;
      const parts = (Array.isArray(content) ? content : []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text);
      const body = parts.join(' ').trim();
      if (!body) continue;
      // 每轮自动注入的世界提示不是原话，跳过
      if (/^(【我写过的认识】|<system-reminder|【记忆)/.test(body) || body.includes('这是我们的聊天记录')) continue;
      const lower = body.toLowerCase();
      if (words.length && !words.every((word) => lower.includes(word))) continue;
      found.push({ time: event.time, role: event.type === 'user/message' ? '你' : '我', body });
    }
    // 命中够了就不再往下解：帧是按时间推进的
    if (limit && found.length >= limit) break;
  }
  return found;
}

function main() {
  const query = (arg('q', null) ?? process.argv[2]) === true ? '' : String(arg('q', null) ?? process.argv[2] ?? '');
  const words = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const files = listFiles();
  if (has('list')) {
    listMode(files);
    return;
  }
  if (!words.length) {
    console.log('用法：node 查原话.mjs "关键词" [--session 前缀] [--date 2026-11-25] [--from/--to] [--workspace room|all] [--limit 5] [--chars 80|--full] [--list]');
    return;
  }
  const date = arg('date', null);
  const from = arg('from', date || null);
  const to = arg('to', date || null);
  const limit = Number(arg('limit', 5)) || 5;
  const chars = has('full') ? 0 : (Number(arg('chars', 80)) || 80);

  const hits = [];
  let scanned = 0;
  let bytes = 0;
  for (const item of files) {
    // 文件最后写入早于起始日：那天的原话不可能在这份文件里，直接跳过（不解压）
    if (from && dayOf(item.mtime) < from) continue;
    scanned += 1;
    bytes += item.size;
    for (const hit of messagesIn(item.file, { fromDay: from, toDay: to, words, limit: limit - hits.length })) {
      hits.push({ session: item.id.slice(8, 16), ...hit });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  if (!hits.length) {
    console.log(`没找到「${query}」（扫了 ${scanned} 个会话，${(bytes / 1024 / 1024).toFixed(1)} MB）`);
    console.log('可以 --list 看看有哪些会话，或 --workspace all 扫全部；日期不确定就去掉 --date。');
    return;
  }
  hits.sort((a, b) => b.time - a.time);
  console.log(`命中 ${hits.length} 条（扫了 ${scanned} 个会话，${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  for (const hit of hits) {
    const body = chars && hit.body.length > chars ? `${hit.body.slice(0, chars)}…` : hit.body;
    console.log(`[${stamp(hit.time)}] ${hit.session}·${hit.role}：${body.replace(/\s+/g, ' ')}`);
  }
}

main();
