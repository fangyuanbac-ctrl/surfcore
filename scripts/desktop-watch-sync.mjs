#!/usr/bin/env node
/**
 * desktop-watch-sync.mjs
 *
 * 电脑陪看（see-now）的「记忆落盘」旁路。
 *
 * 起因：see-now 的 say 只写 ~/.dsh/see-now/chat.jsonl；聊天一压缩，
 *   模型就不知道刚才看了什么、答应过什么；日记和 watch-history 也不含电脑陪看。
 *
 * 做法：
 *  1) 常驻 --watch 读取 chat.jsonl 的新 assistant 台词，写进
 *     characters/<id>/memory/desktop-watch-history.jsonl（原始、可回溯）。
 *  2) 按 15 分钟空白切段，把每段整理成：
 *     - memory/desktop-watch-diary.md（电脑陪看专用私密日记）
 *     - bili/whale-diary-private.md 的「电脑陪看」小节（只写私密日记，不碰公开面）
 *     - memory/memory-inbox.jsonl 一条 platform=pet 的私密记忆，供记忆卡摄取
 *  3) --note 可手动补一条标题/摘要（模型陪看结束后调用），同样落到以上三处。
 *
 * 不读取 QQ 消息，不碰 whale-diary.md（B站公开面），不修改角色人设。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = process.env.USERPROFILE || 'C:\\Users\\1';
const SEE_DIR = path.join(HOME, '.dsh', 'see-now');
const CHAT = path.join(SEE_DIR, 'chat.jsonl');
const CHAR_ROOT = path.join(HOME, '.dsh', 'surfcore', 'characters');

function readCurrentCharacterDir() {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(CHAR_ROOT, 'current.json'), 'utf8'));
    if (current && typeof current.dir === 'string' && current.dir.trim()) return current.dir;
  } catch {}
  return path.join(CHAR_ROOT, 'char-mw6qslxp');
}

const CHAR_DIR = readCurrentCharacterDir();
const MEM_DIR = path.join(CHAR_DIR, 'memory');
const BILI_DIR = path.join(CHAR_DIR, 'bili');
const HISTORY = path.join(MEM_DIR, 'desktop-watch-history.jsonl');
const DIARY = path.join(MEM_DIR, 'desktop-watch-diary.md');
const PRIVATE_DIARY = path.join(BILI_DIR, 'whale-diary-private.md');
const INBOX = path.join(MEM_DIR, 'memory-inbox.jsonl');
const STATE = path.join(HOME, '.dsh', 'see-now', 'desktop-watch-sync-state.json');
const LOG = path.join(HOME, '.dsh', 'see-now', 'desktop-watch-sync.log');

const GAP_MS = 15 * 60 * 1000;
const MAX_SUMMARY_LINES = 6;
const MAX_LINE_CHARS = 100;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function appendText(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, 'utf8');
}

function log(line) {
  const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}\n`;
  ensureDir(path.dirname(LOG));
  fs.appendFileSync(LOG, text, 'utf8');
  process.stdout.write(text);
}

function hash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function dateOnly(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseAt(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

const INTERNAL_PREFIX = /^(Quiet|Still|Nothing|No new|Skipping|The closing|He's|He is|Waiting|Silent|Staying|Stop|Looks|Look|A |An |It |That |Good|Okay|Fine|So |I |We |She |He |The |This |Just |Only |Keep |Stay |Watch|收|先停|安静|继续看|等他|等下一|他刚|他还在|他那边|我这边|说完了|那我再看|我明白了|看完了|看到|好，先停)/i;
const INTERNAL_NOISE = /【当前时间】|【续】|【现在】|Asia\/Shanghai|不用重新自我介绍|接着刚才的聊|系统提示词|工具协议/;

function isUsefulChinese(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (!/[\u4e00-\u9fff]/.test(t)) return false;
  if (INTERNAL_PREFIX.test(t)) return false;
  if (INTERNAL_NOISE.test(t)) return false;
  if (t.length > 260) return false;
  return true;
}

function cleanLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\-•]\s*/, '')
    .trim()
    .slice(0, MAX_LINE_CHARS);
}

function summarizeLines(lines) {
  const useful = lines.map((item) => cleanLine(item.text)).filter(isUsefulChinese);
  const picked = useful.slice(-MAX_SUMMARY_LINES);
  return picked.length ? picked.join('；') : '';
}

function readChat() {
  try {
    const raw = fs.readFileSync(CHAT, 'utf8');
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed);
        if (!item || typeof item !== 'object') continue;
        if (String(item.role ?? '') !== 'assistant') continue;
        const text = String(item.text ?? '').trim();
        if (!text) continue;
        const at = parseAt(item.at, Date.now());
        entries.push({ role: 'assistant', text, at });
      } catch {}
    }
    return entries;
  } catch {
    return [];
  }
}

function loadHistoryIds() {
  const ids = new Set();
  try {
    const raw = fs.readFileSync(HISTORY, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item?.id) ids.add(String(item.id));
      } catch {}
    }
  } catch {}
  return ids;
}

function loadPrivateDiary() {
  try {
    return fs.readFileSync(PRIVATE_DIARY, 'utf8');
  } catch {
    return '';
  }
}

function loadInboxTexts() {
  const texts = new Set();
  try {
    const raw = fs.readFileSync(INBOX, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item?.text) texts.add(String(item.text));
      } catch {}
    }
  } catch {}
  return texts;
}

function backupPrivateDiaryOnce() {
  if (!fs.existsSync(PRIVATE_DIARY)) return;
  const stamp = dateOnly(Date.now()).replace(/-/g, '');
  const backup = `${PRIVATE_DIARY}.bak-desktop-watch-${stamp}`;
  if (!fs.existsSync(backup)) {
    try {
      fs.copyFileSync(PRIVATE_DIARY, backup);
      log(`已备份私密日记：${backup}`);
    } catch (error) {
      log(`私密日记备份失败：${error.message}`);
    }
  }
}

function appendPrivateDiarySection(sectionId, title, lines) {
  const text = fs.existsSync(PRIVATE_DIARY) ? fs.readFileSync(PRIVATE_DIARY, 'utf8') : '';
  if (text.includes(`<!-- ${sectionId} -->`)) return false;
  backupPrivateDiaryOnce();
  const body = [
    '',
    `### ${title}`,
    ...lines.map((line) => `- ${line}`),
    `<!-- ${sectionId} -->`,
    '',
  ].join('\n');
  appendText(PRIVATE_DIARY, body);
  return true;
}

function appendDiarySection(sectionId, title, lines) {
  const text = fs.existsSync(DIARY) ? fs.readFileSync(DIARY, 'utf8') : '';
  if (text.includes(`<!-- ${sectionId} -->`)) return false;
  if (!text.trim()) {
    appendText(DIARY, '# 电脑陪看日记\n\n> 只记录电脑屏幕前的陪看，私密，不进 B站 公开面。\n');
  }
  const body = [
    '',
    `## ${title}`,
    ...lines.map((line) => `- ${line}`),
    `<!-- ${sectionId} -->`,
    '',
  ].join('\n');
  appendText(DIARY, body);
  return true;
}

function appendInboxEvent(text, at) {
  const known = loadInboxTexts();
  if (known.has(text)) return false;
  appendJsonl(INBOX, {
    platform: 'pet',
    isOwner: true,
    isSelf: false,
    private: true,
    direct: true,
    sender: '电脑陪看',
    senderId: 'desktop-watch-v2',
    conversationKey: 'desktop-watch',
    at,
    text,
  });
  return true;
}

function writeSession({ start, end, lines, title = '', summary = '' }) {
  const useful = lines.filter((line) => isUsefulChinese(line.text));
  const date = dateOnly(start);
  const sectionId = `watch-${hash(`${date}|${start}|${end}|${title}`)}`;
  const sectionTitle = `${date} ${hhmm(start)}–${hhmm(end)}${title ? ` · ${title}` : ''}`;
  const displayLines = useful.map((line) => `${hhmm(line.at)} ${cleanLine(line.text)}`);
  const finalLines = displayLines.slice(0, 120);

  const historyIds = loadHistoryIds();
  let addedHistory = 0;
  for (const line of useful) {
    const id = `say-${hash(`${line.at}|${line.text}`)}`;
    if (historyIds.has(id)) continue;
    appendJsonl(HISTORY, {
      id,
      kind: 'say',
      at: line.at,
      atText: new Date(line.at).toISOString(),
      role: 'assistant',
      text: line.text,
      source: 'see-now',
    });
    historyIds.add(id);
    addedHistory += 1;
    if (addedHistory >= 200) break; // 单次回填上限，避免一次写爆
  }

  // 没有可用的中文台词就只留历史，不写日记，也不往记忆里塞。
  if (!finalLines.length) {
    log(`跳过空段 ${sectionTitle}：history +${addedHistory}`);
    return;
  }

  let summaryText = String(summary ?? '').trim() || summarizeLines(lines);
  let addedDiary = false;
  addedDiary = appendDiarySection(sectionId, sectionTitle, finalLines) || addedDiary;
  addedDiary = appendPrivateDiarySection(sectionId, sectionTitle, finalLines) || addedDiary;

  let addedInbox = false;
  if (summaryText) {
    const inboxText = `【电脑陪看】${date} ${hhmm(start)}–${hhmm(end)}${title ? `（${title}）` : ''}：${summaryText.slice(0, 1000)}`;
    addedInbox = appendInboxEvent(inboxText, start);
  }

  // 手动 note 时额外写一条 session 摘要，方便按标题回溯。
  if (title || summary) {
    const id = `session-${sectionId}`;
    if (!historyIds.has(id)) {
      appendJsonl(HISTORY, {
        id,
        kind: 'session',
        at: start,
        atText: new Date(start).toISOString(),
        endAt: end,
        endAtText: new Date(end).toISOString(),
        title: String(title ?? '').trim(),
        summary: String(summary ?? '').trim(),
        lines: finalLines,
        source: 'desktop-watch-sync',
      });
    }
  }

  log(`落盘 ${sectionTitle}：history +${addedHistory}，diary=${addedDiary ? 'yes' : 'no'}，inbox=${addedInbox ? 'yes' : 'no'}`);
}

function groupEntries(entries) {
  const groups = [];
  let current = null;
  for (const entry of entries) {
    if (!current || entry.at - current.end > GAP_MS) {
      if (current) groups.push(current);
      current = { start: entry.at, end: entry.at, lines: [entry] };
    } else {
      current.end = entry.at;
      current.lines.push(entry);
    }
  }
  if (current) groups.push(current);
  return groups;
}

function backfill() {
  const entries = readChat();
  const groups = groupEntries(entries);
  log(`回填：${entries.length} 条 assistant 台词，切出 ${groups.length} 段`);
  for (const group of groups) writeSession(group);
  return groups;
}

function once() {
  const groups = backfill();
  const state = readJson(STATE, { processed: [] });
  state.backfilledAt = new Date().toISOString();
  state.groups = groups.length;
  state.updatedAt = new Date().toISOString();
  writeJson(STATE, state);
  log('回填完成');
}

function noteFromCli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key.slice(2)] = next;
      i += 1;
    } else {
      args[key.slice(2)] = true;
    }
  }
  const now = Date.now();
  const start = args.start ? parseAt(args.start, now) : now;
  const end = args.end ? parseAt(args.end, now) : start;
  const lines = [];
  if (args.summary) {
    for (const piece of String(args.summary).split(/[；;\n]/)) {
      if (piece.trim()) lines.push({ at: start, text: piece.trim() });
    }
  }
  writeSession({
    start,
    end: Math.max(start, end),
    lines,
    title: String(args.title ?? '').trim(),
    summary: String(args.summary ?? '').trim(),
  });
}

function watch() {
  let session = null;
  let lastSeenAt = 0;
  const seen = new Set();

  // 先把已有 chat.jsonl 回填，避免从零开始漏掉今晚这段。
  backfill();

  const tick = () => {
    try {
      const entries = readChat();
      let changed = false;
      for (const entry of entries) {
        if (entry.at <= lastSeenAt) continue;
        const id = hash(`${entry.at}|${entry.text}`);
        if (seen.has(id)) continue;
        seen.add(id);
        changed = true;

        if (!session) session = { start: entry.at, end: entry.at, lines: [entry] };
        else if (entry.at - session.end > GAP_MS) {
          writeSession(session);
          session = { start: entry.at, end: entry.at, lines: [entry] };
        } else {
          session.end = entry.at;
          session.lines.push(entry);
        }
        lastSeenAt = Math.max(lastSeenAt, entry.at);
      }

      const now = Date.now();
      if (session && now - session.end > GAP_MS) {
        writeSession(session);
        session = null;
      }

      if (changed) {
        writeJson(STATE, {
          processed: [...seen].slice(-20000),
          lastSeenAt,
          updatedAt: new Date().toISOString(),
          watching: true,
        });
      }
    } catch (error) {
      log(`watch tick 失败：${error.message}`);
    }
  };

  tick();
  const timer = setInterval(tick, 3000);
  const shutdown = () => {
    if (session) {
      try { writeSession(session); } catch (error) { log(`退出 flush 失败：${error.message}`); }
      session = null;
    }
    clearInterval(timer);
    log('watch 退出');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log('watch 已启动，每 3 秒检查 chat.jsonl');
}

const argv = process.argv.slice(2);
if (argv.includes('--watch')) watch();
else if (argv.includes('--once')) once();
else if (argv.includes('--note')) noteFromCli(argv);
else {
  log('用法：node desktop-watch-sync.mjs --watch | --once | --note --title "..." --summary "..."');
  process.exit(1);
}
