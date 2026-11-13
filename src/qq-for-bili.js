// QQ → B站 的「QQ 那边」摘要通道（2026-11-14，主人要求，报告 §113）。
//
// 背景：B站 侧的她在写私密日记时只能看到 B站 的东西（B站 私信/视频/记忆），
// QQ 私聊走的是 bridge 的收尾摘要（appendDigest → shared/digest.jsonl）。
// 本模块把这些摘要里 platform='qq' 的条目脱敏后写成
// ~/.dsh/surfcore/memory/qq-for-bili.md，B站 唤醒时注入，写日记就能写「QQ 那边」。
//
// 隐私：只搬「摘要」（gist/next），不搬原文；URL/路径/长数字/令牌一律打码。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { activeMemoryPaths } from './character-persona.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 10 * 60 * 1000

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
}

export function digestPath() {
  return path.join(dshHome(), 'surfcore', 'shared', 'digest.jsonl')
}

export function qqForBiliPath() {
  // 当前角色的 memory 目录（与 scheduler 的 activeMemoryPaths().qqForBili 完全一致）。
  return activeMemoryPaths().qqForBili
}

/** 脱敏：保留中文与 BV 号，去掉链接/路径/邮箱/长数字/令牌。 */
export function sanitizeQqLine(text, maxChars = 600) {
  let s = String(text ?? '')
  s = s.replace(/https?:\/\/\S+/gu, '[链接]')
  s = s.replace(/[A-Za-z]:\\[^\s，。；]+/gu, '[路径]')
  s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, '[邮箱]')
  s = s.replace(/\b[0-9a-fA-F]{24,}\b/gu, '[令牌]')
  s = s.replace(/(?<!BV)\b\d{5,12}\b/gu, '[数字]')
  s = s.replace(/\s+/gu, ' ').trim()
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s
}

function stamp(ts) {
  const d = new Date(Number(ts) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

export function readDigestEntries({ now = Date.now(), lookbackDays = 7, maxEntries = 12 } = {}) {
  const from = now - Math.max(1, lookbackDays) * DAY_MS
  const out = []
  let raw = ''
  try {
    raw = fs.readFileSync(digestPath(), 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (item?.platform !== 'qq') continue
    const ts = Number(item.ts) || 0
    if (ts < from) continue
    out.push(item)
  }
  return out.slice(-maxEntries)
}

export function buildQqForBiliMarkdown({ now = Date.now(), lookbackDays = 7, maxEntries = 12, maxChars = 2600 } = {}) {
  const entries = readDigestEntries({ now, lookbackDays, maxEntries })
  const head = [
    '# QQ 那边（给 B站 的她看）',
    '',
    `> 自动生成：${stamp(now)} · 来源：QQ 私聊收尾摘要（脱敏，只有摘要没有原文）`,
    '',
  ]
  if (!entries.length) {
    head.push('（最近没有 QQ 摘要）', '')
    return head.join('\n')
  }
  const lines = []
  for (const item of entries) {
    const gist = sanitizeQqLine(item.gist, 400)
    const next = sanitizeQqLine(item.next, 200)
    if (!gist) continue
    lines.push(`- ${stamp(item.ts)} · 和主人聊到：${gist}`)
    if (next) lines.push(`  · 下次可以接着：${next}`)
  }
  let body = [...head, ...lines].join('\n')
  if (body.length > maxChars) body = `${body.slice(0, maxChars).trimEnd()}\n…（摘要过长已截断）`
  return `${body}\n`
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 生成 qq-for-bili.md。
 * - throttle：默认 10 分钟内不重复写（force 可跳过）
 * - 返回 { ok, skipped?, chars, entries }
 */
export function syncQqForBili({ force = false, now = Date.now(), lookbackDays = 7, maxEntries = 12, maxChars = 2600 } = {}) {
  const file = qqForBiliPath()
  try {
    if (!force) {
      const st = fs.statSync(file)
      if (now - st.mtimeMs < MIN_INTERVAL_MS) {
        return { ok: true, skipped: 'throttled', chars: st.size }
      }
    }
  } catch {}
  const markdown = buildQqForBiliMarkdown({ now, lookbackDays, maxEntries, maxChars })
  try {
    writeAtomic(file, markdown)
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const entries = readDigestEntries({ now, lookbackDays, maxEntries }).length
  return { ok: true, chars: markdown.length, entries, path: file }
}
