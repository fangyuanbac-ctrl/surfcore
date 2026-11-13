#!/usr/bin/env node
// 「手机看日记」小工具 —— 双击桌面快捷方式即可。
//
// 它做的事：
//   1. 确认日记阅读器在跑（没跑就后台拉起来）；
//   2. 取当前电脑的局域网 IPv4、读访问码，拼出手机可直接打开的链接；
//   3. 生成一个本地二维码页面（scripts/diary-viewer-phone.html），用默认浏览器打开；
//   4. 手机扫码即可，不需要手动输入长链接。
//
// 只读、不改任何数据。换 Wi-Fi 后 IP 会变，重新双击一次即可。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { exec, spawn } from 'node:child_process';

const HOME = process.env.USERPROFILE || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SERVER = path.join(HERE, 'diary-viewer.mjs');
const HTML = path.join(HERE, 'diary-viewer-phone.html');
const CONFIG_FILE = path.join(HERE, 'diary-viewer.config.json');
const TOKEN_FILE = path.join(DSH_HOME, 'surfcore', 'diary-viewer-token');

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }
function jsonGet(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = {};
try { cfg = JSON.parse(readText(CONFIG_FILE).replace(/^\uFEFF/, '')) || {}; } catch { cfg = {}; }
const PORT = Number(process.env.DIARY_VIEWER_PORT || cfg.port || 8787);
const TOKEN = readText(TOKEN_FILE).trim();

if (!TOKEN) {
  console.error(`没有找到访问码文件：${TOKEN_FILE}\n先正常启动一次日记阅读器（桌面「鲸眠日记」）再试。`);
  process.exit(1);
}

// 1) 服务在不在
let health = await jsonGet(PORT, '/health');
if (!health) {
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 12 && !health; i++) { await sleep(400); health = await jsonGet(PORT, '/health'); }
}
if (!health) {
  console.error('日记阅读器没起来。先双击桌面「鲸眠日记」看看，再试一次。');
  process.exit(1);
}
if (!health.lan) {
  console.error('阅读器现在只监听本机（lan=false）。把 scripts/diary-viewer.config.json 改成 {"lan": true} 再重开阅读器。');
  process.exit(1);
}

// 2) 收集局域网 IPv4（跳过回环/链路本地），优先常见内网段
const ips = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const it of list || []) {
    if (it.family !== 'IPv4' || it.internal) continue;
    if (it.address.startsWith('169.254.')) continue;
    ips.push(it.address);
  }
}
const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
ips.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

if (!ips.length) {
  console.error('没找到局域网 IP（电脑没连 Wi-Fi/网线？）。');
  process.exit(1);
}

const targets = ips.map((ip) => ({ ip, url: `http://${ip}:${PORT}/?key=${encodeURIComponent(TOKEN)}` }));

// 3) 生成二维码页
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>手机看日记 · 扫码</title>
<style>
  body { background:#0b0f15; color:#e8eef8; font-family:"Segoe UI","Microsoft YaHei",sans-serif; margin:0; padding:28px 20px 60px; }
  h1 { font-size:20px; margin:0 0 6px; } .sub { color:#8a97aa; font-size:13px; margin-bottom:22px; }
  .card { background:#121926; border:1px solid #223047; border-radius:14px; padding:22px; margin:0 auto 18px; max-width:520px; }
  .ip { color:#8a97aa; font-size:13px; margin-bottom:10px; }
  .qr { background:#fff; border-radius:10px; padding:10px; display:inline-block; }
  .qr img { display:block; width:260px; height:260px; image-rendering:pixelated; }
  .url { margin-top:14px; font-size:12px; color:#9fb0c8; word-break:break-all; user-select:all; }
  .tip { color:#8a97aa; font-size:12.5px; line-height:1.7; margin-top:16px; }
  .err { color:#ff9d9d; }
</style></head><body>
<h1>手机看日记</h1>
<div class="sub">手机和电脑连同一个 Wi-Fi，用相机/微信扫下面的码；或直接打开链接。</div>
<div id="cards"></div>
<div class="tip">
  只读页面，含访问码（相当于钥匙），别截图发给别人。<br/>
  打不开先确认手机连的是同一个 Wi-Fi；换 Wi-Fi 后重新双击桌面「手机看日记」。
</div>
<script src="vendor/qrcode.js"></script>
<script>
  const targets = ${JSON.stringify(targets)};
  const box = document.getElementById('cards');
  for (const t of targets) {
    const card = document.createElement('div'); card.className = 'card';
    const ip = document.createElement('div'); ip.className = 'ip'; ip.textContent = '本机地址 ' + t.ip;
    const qr = document.createElement('div'); qr.className = 'qr';
    try {
      const q = qrcode(0, 'M'); q.addData(t.url); q.make();
      qr.innerHTML = q.createImgTag(6, 8);
    } catch (e) { qr.textContent = 'QR 生成失败: ' + e.message; }
    const u = document.createElement('div'); u.className = 'url'; u.textContent = t.url;
    card.append(ip, qr, u); box.appendChild(card);
  }
</script>
</body></html>`;
fs.writeFileSync(HTML, html, 'utf8');

// 4) 打开本地二维码页
const fileUrl = 'file:///' + HTML.replace(/\\/g, '/');
exec(`cmd /c start "" "${fileUrl}"`, () => {});
console.log(`手机看日记：${targets.map((t) => t.url).join('  |  ')}`);
console.log(`二维码页：${HTML}`);
