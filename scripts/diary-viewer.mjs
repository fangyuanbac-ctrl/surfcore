#!/usr/bin/env node
// 她的日记阅读器 —— 只读、本地回环的小网页。
//
// 背景（2026-11-14，用户「写个插件，方便我读日记」）：
//   · 日记本体是 Markdown（whale-diary.md / whale-diary-private.md），一条一条按「## 」分节；
//   · QQ/B站 每段收尾有一句摘要写在 shared/digest.jsonl；
//   · 她实际被注入的「记忆卡」也有对应 prompt 文件，一起给主人看，方便对照"她记得什么"。
//
// 只读、不写任何文件；默认只监听 127.0.0.1。
// 手机上看得开「局域网模式」：scripts/diary-viewer.config.json 里 {"lan":true}，
// 监听 0.0.0.0，但所有非回环请求必须带访问码（自动生成在 ~/.dsh/surfcore/diary-viewer-token，
// URL 带 ?key=<访问码> 一次即可，之后浏览器会记 cookie）。
//
// 用法：
//   node scripts/diary-viewer.mjs            # 起服务，浏览器手动开 http://127.0.0.1:8787
//   node scripts/diary-viewer.mjs --open     # 起服务并自动打开浏览器
//   DIARY_VIEWER_PORT=8888 node scripts/diary-viewer.mjs
//
// 数据源（全部只读）：
//   ~/.dsh/surfcore/characters/char-mw6qslxp/bili/whale-diary.md
//   ~/.dsh/surfcore/characters/char-mw6qslxp/bili/whale-diary-private.md
//   ~/.dsh/surfcore/shared/digest.jsonl
//   ~/.dsh/surfcore/characters/char-mw6qslxp/memory/memory-card-prompt-qq.md
//   ~/.dsh/surfcore/characters/char-mw6qslxp/memory/memory-card-prompt-bili.md
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const CHAR_DIR = path.join(DSH_HOME, 'surfcore', 'characters', 'char-mw6qslxp');
const BILI_DIR = path.join(CHAR_DIR, 'bili');
const MEM_DIR = path.join(CHAR_DIR, 'memory');
const DIGEST_FILE = path.join(DSH_HOME, 'surfcore', 'shared', 'digest.jsonl');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const HTML_FILE = path.join(HERE, 'diary-viewer.html');
const CONFIG_FILE = path.join(HERE, 'diary-viewer.config.json');
const TOKEN_FILE = path.join(DSH_HOME, 'surfcore', 'diary-viewer-token');

let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { fileCfg = {}; }
const LAN = fileCfg.lan === true || process.env.DIARY_VIEWER_LAN === '1';
const PORT = Number(process.env.DIARY_VIEWER_PORT || fileCfg.port || 8787);
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

// 局域网访问码：优先 env/配置，其次 token 文件，最后自动生成并写文件。
function loadToken() {
  if (process.env.DIARY_VIEWER_TOKEN) return String(process.env.DIARY_VIEWER_TOKEN);
  if (fileCfg.token) return String(fileCfg.token);
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString('hex');
  try { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, t + '\n', 'utf8'); } catch {}
  return t;
}
const TOKEN = LAN ? loadToken() : '';
const isLoopback = (remote) => remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
function safeEq(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function keyOk(req, url) {
  if (!LAN) return true;
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|;\s*)dv_key=([^;]+)/);
  const cands = [url.searchParams.get('key') || '', String(req.headers['x-diary-key'] || ''), m ? decodeURIComponent(m[1]) : ''];
  return cands.some((c) => c && safeEq(c, TOKEN));
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function statInfo(file) {
  try {
    const s = fs.statSync(file);
    return { exists: true, bytes: s.size, mtime: s.mtimeMs };
  } catch { return { exists: false, bytes: 0, mtime: 0 }; }
}

function extractDate(header) {
  const m = String(header).match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return { date: '', time: '' };
  return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : '' };
}

// 日记文件是「一个人一个 H1、一天一段 `## `」的混合结构：
//   # 她的一天 · 2026-11-09（周六，夜）      ← 只出现一次，给出基线日期
//   ## 一、今天看了什么                       ← 11-09 的节（标题无日期，继承基线）
//   ## 六、轻醒 · 2026-11-10 夜               ← 实际是 11-10 的一节（标题带日期，更新基线）
// 所以按 `## ` 拆条目，日期 = 标题里的日期，否则继承上一个已知日期；H1 只更新基线。
function parseDiary(file, label) {
  const raw = readText(file);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const items = [];
  let cur = null;
  let curDate = '';
  const pushCur = () => {
    if (!cur) return;
    cur.body = cur.lines.join('\n').replace(/^\s+|\s+$/g, '');
    cur.searchText = `${cur.header} ${cur.body}`;
    delete cur.lines;
    items.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (/^#\s+/.test(line) && !/^##\s/.test(line)) {
      pushCur();
      const dates = extractDate(line);
      if (dates.date) curDate = dates.date;
      continue;
    }
    if (/^##\s+/.test(line)) {
      pushCur();
      const header = line.replace(/^##\s+/, '').trim();
      const dates = extractDate(header);
      if (dates.date) curDate = dates.date;
      cur = { header, date: curDate, time: dates.time, lines: [], label, kind: label };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  pushCur();
  // 兜底：标题和正文都没日期时，从正文里找一次
  for (const it of items) {
    if (!it.date) {
      const d = extractDate(it.body);
      if (d.date) { it.date = d.date; it.time = it.time || d.time; }
    }
  }
  return items;
}

function parseDigest() {
  const raw = readText(DIGEST_FILE);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Number(o.ts);
    const d = new Date(Number.isFinite(ts) ? ts : Date.now());
    out.push({
      label: 'QQ/B站 摘要',
      kind: o.platform === 'bili' ? 'bili' : 'qq',
      date: dayOf(d),
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      header: `${o.platform === 'bili' ? 'B站' : 'QQ'} · ${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
      body: `**摘要**：${String(o.gist ?? '')}${o.next ? `\n\n**下次可以接着**：${String(o.next)}` : ''}`,
      searchText: `${o.gist ?? ''} ${o.next ?? ''}`,
    });
  }
  return out;
}

function buildPayload() {
  const pub = parseDiary(path.join(BILI_DIR, 'whale-diary.md'), '公开日记');
  const priv = parseDiary(path.join(BILI_DIR, 'whale-diary-private.md'), '私密日记');
  const digest = parseDigest();
  const memory = {
    qq: readText(path.join(MEM_DIR, 'memory-card-prompt-qq.md')),
    bili: readText(path.join(MEM_DIR, 'memory-card-prompt-bili.md')),
    owner: readText(path.join(MEM_DIR, 'owner-understanding.md')),
  };
  const files = {
    public: statInfo(path.join(BILI_DIR, 'whale-diary.md')),
    private: statInfo(path.join(BILI_DIR, 'whale-diary-private.md')),
    digest: statInfo(DIGEST_FILE),
    memoryQq: statInfo(path.join(MEM_DIR, 'memory-card-prompt-qq.md')),
    memoryBili: statInfo(path.join(MEM_DIR, 'memory-card-prompt-bili.md')),
    memoryOwner: statInfo(path.join(MEM_DIR, 'owner-understanding.md')),
  };
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    character: path.basename(CHAR_DIR),
    sources: files,
    public: pub,
    private: priv,
    digest,
    memory,
  };
}

function serveHtml(res) {
  try {
    const html = fs.readFileSync(HTML_FILE, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`读取页面模板失败：${HTML_FILE}\n${String(e?.message ?? e)}`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);
  const remote = req.socket.remoteAddress || '';
  if (!isLoopback(remote)) {
    if (!keyOk(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('需要访问码：在你的电脑上查看 ~/.dsh/surfcore/diary-viewer-token，或让运维会话把带 ?key= 的链接发你。');
      return;
    }
    if (url.searchParams.get('key')) {
      res.setHeader('set-cookie', `dv_key=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return serveHtml(res);
  if (url.pathname === '/api/all') {
    try {
      const body = JSON.stringify(buildPayload());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    }
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, port: PORT, lan: LAN, generatedAt: new Date().toISOString() }));
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

function lanUrls() {
  if (!LAN) return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(`http://${it.address}:${PORT}/?key=${encodeURIComponent(TOKEN)}`);
    }
  }
  return out;
}

function openBrowser() {
  const target = `http://127.0.0.1:${PORT}/`;
  const cmd = process.platform === 'win32'
    ? `cmd /c start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd, () => {});
}

let opened = false;
function start() {
  server.listen(PORT, HOST, () => {
    console.log(`日记阅读器：http://127.0.0.1:${PORT}/`);
    console.log(`  角色目录：${CHAR_DIR}`);
    if (LAN) {
      console.log('  局域网模式：非本机访问需要访问码（已生成/复用 token 文件）');
      for (const u of lanUrls()) console.log(`  手机可开：${u}`);
    }
    if (process.argv.includes('--open') && !opened) { opened = true; openBrowser(); }
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 已经有一个在跑：直接把浏览器开过去，不重复起服务
    console.log(`端口 ${PORT} 已在使用，直接打开 http://${HOST}:${PORT}/`);
    if (process.argv.includes('--open')) openBrowser();
    process.exit(0);
  }
  console.error('日记阅读器启动失败：', e);
  process.exit(1);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

start();
