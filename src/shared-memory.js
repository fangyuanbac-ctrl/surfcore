// 跨平台共享记忆（QQ ⇄ B站）——"同一个她"
//
// 2026-11-11 主人定（方案 C）：主要在 QQ 聊，但两个平台要是同一个人。
// 两个 DSH 会话不共享上下文，所以用共享文件 + 每轮唤醒前注入：
//   · hot-<平台>.jsonl：热层，只存最近 15 分钟、主人↔她的对话（≤80 字/条，过隐私闸门）；
//     对方平台唤醒时注入【刚才在另一边聊过】。解决"前一秒 B站 说完、下一秒 QQ 就忘"。
//   · self.md：她自己的近况/心情（两边可写可读），长期"自我"记忆。
// 硬边界：只同步主人和她本人之间的话；第三方私信/群友内容/号码/地址/密钥一律不落盘。
// 隐私策略 v3 → v4（本文件是唯一新增出口，且只走 hot 层 + 15 分钟 TTL）。

import fs from 'node:fs'
import path from 'node:path'
import { scanText } from '../plugins/surfcore/lib/privacy.js'

const HOME = process.env.USERPROFILE || process.env.HOME || '/'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const DIR = path.join(DSH_HOME, 'surfcore', 'shared')

export const HOT_TTL_MS = 15 * 60 * 1000
export const HOT_TEXT_MAX = 80
export const HOT_BLOCK_MAX = 420
const HOT_KEEP_LINES = 100
const HOT_PRUNE_BYTES = 128 * 1024

const hotFile = (platform) => path.join(DIR, `hot-${platform === 'bili' ? 'bili' : 'qq'}.jsonl`)
const selfFile = () => path.join(DIR, 'self.md')

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }) } catch {}
}

function pruneHot(file) {
  try {
    const st = fs.statSync(file)
    if (st.size < HOT_PRUNE_BYTES) return
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-HOT_KEEP_LINES)
    fs.writeFileSync(file, lines.join('\n') + '\n')
  } catch {}
}

/** 过隐私闸门 + 截断：命中任何敏感命中就整条丢弃（宁可不同步，也不泄露）。 */
export function safeHotText(text) {
  let s = String(text ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim()
  if (!s) return ''
  if (/^\[(图片|表情|语音|视频|文件|转发消息|拍一拍)[^\]]*\]$/.test(s)) return ''
  try {
    const scan = scanText(s)
    if ((scan.hits ?? []).length) return ''
  } catch { return '' }
  return s.slice(0, HOT_TEXT_MAX)
}

/** 记录一条热事件（主人或她本人）。platform: qq | bili；who: owner | self */
export function appendHotEvent({ platform, who, text, ts = Date.now() }) {
  const p = platform === 'bili' ? 'bili' : 'qq'
  const safe = safeHotText(text)
  if (!safe) return false
  const ev = { ts: Number(ts) || Date.now(), platform: p, who: who === 'self' ? 'self' : 'owner', text: safe }
  try {
    ensureDir()
    const file = hotFile(p)
    fs.appendFileSync(file, JSON.stringify(ev) + '\n')
    pruneHot(file)
    return true
  } catch { return false }
}

/** 读另一边平台最近 15 分钟的热事件（按时间合并）。 */
export function readHotOther({ platform, ttlMs = HOT_TTL_MS } = {}) {
  const other = platform === 'bili' ? 'qq' : 'bili'
  const cutoff = Date.now() - Math.max(60_000, Number(ttlMs) || HOT_TTL_MS)
  const rows = []
  try {
    const text = fs.readFileSync(hotFile(other), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (!ev || !Number.isFinite(Number(ev.ts)) || Number(ev.ts) < cutoff) continue
        if (!ev.text) continue
        rows.push({ ts: Number(ev.ts), who: ev.who === 'self' ? 'self' : 'owner', text: String(ev.text).slice(0, HOT_TEXT_MAX) })
      } catch {}
    }
  } catch { /* 文件不存在 = 没有 */ }
  rows.sort((a, b) => a.ts - b.ts)
  return rows.slice(-8)
}

function relTime(ms) {
  const d = Math.max(0, Date.now() - Number(ms))
  const min = Math.round(d / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  return `${Math.round(min / 60)} 小时前`
}

/** 给另一边平台唤醒时注入：刚才在主战场聊过什么（≤420 字）。 */
export function renderHotBlock({ platform, ttlMs = HOT_TTL_MS } = {}) {
  const rows = readHotOther({ platform, ttlMs })
  if (!rows.length) return ''
  const lines = rows.map((r) => `· ${relTime(r.ts)} · ${r.who === 'owner' ? '主人' : '你'}：${r.text}`)
  let out = `【刚才在另一边聊过】（仅你和主人；${Math.round((ttlMs || HOT_TTL_MS) / 60000)} 分钟内）\n${lines.join('\n')}`
  if (out.length > HOT_BLOCK_MAX) {
    const kept = []
    let len = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (len + lines[i].length + 1 > HOT_BLOCK_MAX - 40) break
      kept.unshift(lines[i])
      len += lines[i].length + 1
    }
    out = `【刚才在另一边聊过】（仅你和主人；只显示最近几条）\n${kept.join('\n')}`
  }
  return out
}

/** 她自己的近况/心情（长期"自我"记忆）。两边都可写，读取尾部 200 字。 */
export function appendSelfNote({ platform, text, ts = Date.now() }) {
  const safe = safeHotText(text)
  if (!safe) return false
  try {
    ensureDir()
    const line = `- [${new Date(Number(ts) || Date.now()).toLocaleString('zh-CN', { hour12: false })}]（${platform === 'bili' ? 'B站' : 'QQ'}）${safe}`
    fs.appendFileSync(selfFile(), line + '\n')
    return true
  } catch { return false }
}

export function renderSelfBlock({ maxChars = 200 } = {}) {
  try {
    const raw = fs.readFileSync(selfFile(), 'utf8').split('\n').filter(Boolean)
    if (!raw.length) return ''
    let tail = []
    let len = 0
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      if (len + raw[i].length + 1 > maxChars) break
      tail.unshift(raw[i])
      len += raw[i].length + 1
    }
    return tail.length ? `【你自己的近况】（两边共享）\n${tail.join('\n')}` : ''
  } catch { return '' }
}

// ── 摘要层（跨天延续）────────────────────────────────────────────
// 只存"和主人聊到哪、下次怎么接"的抽象摘要（来自收尾摘要），不存原文。
const DIGEST_KEEP = 200
const DIGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DIGEST_TEXT_MAX = 160

const digestFile = () => path.join(DIR, 'digest.jsonl')

function safeDigestText(text) {
  let s = String(text ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim()
  if (!s) return ''
  try {
    const scan = scanText(s)
    if ((scan.hits ?? []).length) return ''
  } catch { return '' }
  return s.slice(0, DIGEST_TEXT_MAX)
}

/** 记一条跨平台摘要（gist=聊到哪，next=下次怎么接）。同内容 10 分钟内去重。 */
export function appendDigest({ platform, gist, next = '', ts = Date.now() }) {
  const safe = safeDigestText(gist)
  if (!safe) return false
  const ev = {
    ts: Number(ts) || Date.now(),
    platform: platform === 'bili' ? 'bili' : 'qq',
    gist: safe,
    next: safeDigestText(next),
  }
  try {
    ensureDir()
    const file = digestFile()
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      if (last && last.gist === ev.gist && ev.ts - Number(last.ts) < 10 * 60 * 1000) return false
    } catch {}
    fs.appendFileSync(file, JSON.stringify(ev) + '\n')
    try {
      const all = fs.readFileSync(file, 'utf8').trim().split('\n')
      if (all.length > DIGEST_KEEP) fs.writeFileSync(file, all.slice(-DIGEST_KEEP).join('\n') + '\n')
    } catch {}
    return true
  } catch { return false }
}

/** 读最近几天的摘要（最新的在最后）。 */
export function readDigest({ limit = 3, maxAgeMs = DIGEST_MAX_AGE_MS } = {}) {
  try {
    const cutoff = Date.now() - Number(maxAgeMs || DIGEST_MAX_AGE_MS)
    const rows = []
    for (const line of fs.readFileSync(digestFile(), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (!ev || !ev.gist || !Number.isFinite(Number(ev.ts)) || Number(ev.ts) < cutoff) continue
        rows.push({ ts: Number(ev.ts), platform: ev.platform === 'bili' ? 'bili' : 'qq', gist: String(ev.gist), next: String(ev.next ?? '') })
      } catch {}
    }
    rows.sort((a, b) => a.ts - b.ts)
    return rows.slice(-Math.max(1, Number(limit) || 3))
  } catch { return [] }
}

/** 给唤醒提示注入：最近和主人聊到哪、下次怎么接（≤240 字）。 */
export function renderDigestBlock({ limit = 3, maxChars = 240 } = {}) {
  const rows = readDigest({ limit })
  if (!rows.length) return ''
  const day = (ts) => {
    const d = new Date(ts)
    const now = new Date()
    const same = d.toDateString() === now.toDateString()
    if (same) return '今天'
    const days = Math.round((now.setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000)
    return days === 1 ? '昨天' : `${Math.max(2, days)} 天前`
  }
  const lines = rows.map((r) => `· ${day(r.ts)} · 聊到「${r.gist}」${r.next ? `；下次可接：${r.next}` : ''}`)
  let block = `【最近和主人聊过】（跨天延续，别重复问）\n${lines.join('\n')}`
  if (block.length > maxChars) {
    const kept = []
    let len = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (len + lines[i].length + 1 > maxChars - 30) break
      kept.unshift(lines[i])
      len += lines[i].length + 1
    }
    block = `【最近和主人聊过】（跨天延续，别重复问）\n${kept.join('\n')}`
  }
  return block
}

