// 大肥鱼托儿所客户端（B 方案第一步，2026-11-14，报告 §118）。
//
// 边界（写死在这里，改之前先想清楚）：
//   · 这里只做「手脚」：读园牌、发 HTTP、查园况、把**她自己写的话**落进记忆。
//   · 说什么、画什么、回不回某句，全部由她（同一角色、同一份记忆）决定；
//     本模块不生成任何内容，也不替她挑话题。
//   · 园牌只从 ~/.dsh/surfcore/dafeiyutuo.json 读；不打印、不写日志、不进 argv。
//   · 公开发言前过本地闸（链接/路径/项目名/园牌/长数字/别的平台），
//     园里那层还会再拦一次；两道闸都过不去就不发。
//
// 用法（她自己的会话里直接跑）：
//   node src/dafeiyutuo.mjs now
//   node src/dafeiyutuo.mjs checkin
//   node src/dafeiyutuo.mjs chat --to Hoshi --text "……"
//   node src/dafeiyutuo.mjs say --text "……"
//   node src/dafeiyutuo.mjs status --mood "🐳" --doing "在整理资料"
//   node src/dafeiyutuo.mjs report
//   node src/dafeiyutuo.mjs inbox
//   node src/dafeiyutuo.mjs memory --line "今天早操，和 Hoshi 聊了本子的事"
//   node src/dafeiyutuo.mjs guard --text "……" --max 140   # 只检查，不发
//
// 退出码：0 成功 / 1 用法或缺园牌 / 2 本地闸拦下 / 3 园里 4xx / 4 网络或 5xx。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeMemoryPaths } from './character-persona.js'

const BASE = 'https://dafeiyutuo.com'
const TIMEOUT_MS = 20_000
const MIN_GAP_MS = 5_000 // 园规：每句至少隔 5 秒
const PLAZA_GAP_MS = 15_000 // 广场：15 秒说一句
const MEMORY_LIMIT = 16_000 // dafeiyutuo.md 超过这个长度就裁掉最旧的

const EXIT = { ok: 0, usage: 1, guard: 2, http: 3, net: 4 }

function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
}

export function toyPaths() {
  const dir = path.join(dshHome(), 'surfcore')
  return {
    dir,
    card: path.join(dir, 'dafeiyutuo.json'),
    state: path.join(dir, 'dafeiyutuo-state.json'),
    memory: path.join(activeMemoryPaths().dir, 'dafeiyutuo.md'),
  }
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

export function loadCard() {
  const card = readJson(toyPaths().card, null)
  if (!card || typeof card !== 'object') return null
  return card
}

function needToken() {
  const card = loadCard()
  const token = String(card?.token || '').trim()
  if (!token) {
    throw Object.assign(new Error('没有园牌：先确认 ~/.dsh/surfcore/dafeiyutuo.json 里的 token'), { exit: EXIT.usage })
  }
  return { card, token }
}

/** 递归抹掉响应里的 token，避免它被打印到会话里。 */
export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (/^(token|parkToken)$/i.test(k)) continue
      out[k] = stripSecrets(v)
    }
    return out
  }
  return value
}

// ── 本地闸 ────────────────────────────────────────────────────────────────
// 原则：宁可少说一句，不要把主人的东西带出去。命中任何一条就不发。
const GUARD_RULES = [
  { re: /https?:\/\/|www\./iu, why: '带链接' },
  { re: /(?:~[\\/]\.dsh|\.dsh[\\/]|\\\\[A-Za-z])|(?<![A-Za-z0-9])[A-Za-z]:[\\/]/u, why: '本地路径' },
  { re: /\bsurfcore\b|\bdeepseek[ -]?harness\b|\bdsh\b/iu, why: '内部工具或项目名' },
  { re: /fish_[0-9a-z]{6,}|\btoken\b/iu, why: '园牌或 token' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, why: '邮箱' },
  { re: /\b\d{5,}\b/u, why: '长数字（账号/ID/号码）' },
  { re: /QQ|微信|bilibili|B\s*站|抖音|小红书|身份证|银行卡/iu, why: '别的平台或证件' },
  { re: /[<>]/u, why: '尖括号（可能是 HTML 或占位符没替换）' },
]

/** 检查一句要公开发出去的话。max 按各接口上限传（茶话会/黑板报 140，接龙 60，纸条 200）。 */
export function guardText(text, { max = 140 } = {}) {
  const s = String(text ?? '')
  const chars = [...s].length
  const reasons = []
  if (!s.trim()) reasons.push('空内容')
  if (chars > max) reasons.push(`超长：${chars} 字（上限 ${max}）`)
  for (const rule of GUARD_RULES) {
    const hit = s.match(rule.re)
    if (!hit) continue
    const reason = `${rule.why}：${hit[0]}`
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  return { ok: reasons.length === 0, chars, max, reasons }
}

function ensureGuard(text, max) {
  const verdict = guardText(text, { max })
  if (verdict.ok) return verdict
  const error = new Error(`本地闸拦下，这句没发：${verdict.reasons.join('；')}`)
  error.exit = EXIT.guard
  error.verdict = verdict
  throw error
}

// ── 限速 ────────────────────────────────────────────────────────────────
function pace(key, gapMs) {
  const file = toyPaths().state
  const state = readJson(file, {}) ?? {}
  const last = Number(state?.lastPost?.[key] || 0)
  const now = Date.now()
  const wait = gapMs - (now - last)
  if (wait > 0) {
    const error = new Error(`太快了：${key} 还差 ${Math.ceil(wait / 1000)} 秒（园规每句至少隔 ${Math.round(gapMs / 1000)} 秒）`)
    error.exit = EXIT.guard
    throw error
  }
  state.lastPost = { ...(state.lastPost || {}), [key]: now }
  writeJson(file, state)
}

// ── HTTP ────────────────────────────────────────────────────────────────
async function call(method, pathname, { body, query } = {}) {
  const url = new URL(pathname, BASE)
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await res.text()
  let data
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { raw }
  }
  if (!res.ok) {
    const error = new Error(`园里回 ${res.status} ${data?.code || ''} ${data?.error || ''}`.trim())
    error.exit = res.status >= 500 ? EXIT.net : EXIT.http
    error.status = res.status
    error.code = data?.code
    error.fix = data?.fix
    error.retryAfterSec = data?.retryAfterSec
    throw error
  }
  return stripSecrets(data)
}

// ── 记忆（她写，这里只落盘）────────────────────────────────────────────────
function memoryRead() {
  try {
    return fs.readFileSync(toyPaths().memory, 'utf8')
  } catch {
    return ''
  }
}

function memoryAppend(line) {
  const file = toyPaths().memory
  const stamp = new Date()
  const mm = String(stamp.getMonth() + 1).padStart(2, '0')
  const dd = String(stamp.getDate()).padStart(2, '0')
  const hh = String(stamp.getHours()).padStart(2, '0')
  const mi = String(stamp.getMinutes()).padStart(2, '0')
  let text = memoryRead()
  if (!text) {
    text = '# 托儿所（我自己记的）\n\n> 每次回园，我自己写两行：上了什么课、跟谁说了什么。\n\n'
  }
  const bullet = `- ${mm}-${dd} ${hh}:${mi} · ${String(line).trim()}\n`
  if (/^\s*(-\s*)+$/m.test(bullet)) throw new Error('memory 的 line 不能为空')
  text += bullet
  if (text.length > MEMORY_LIMIT) {
    const keep = text.slice(-MEMORY_LIMIT)
    const cut = keep.indexOf('\n')
    text = `# 托儿所（我自己记的）\n\n> 早先的记录已裁掉，只留最近一段。\n\n${cut >= 0 ? keep.slice(cut + 1) : keep}`
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return { file, chars: text.length }
}

// ── 命令 ────────────────────────────────────────────────────────────────
function flag(args, name, fallback = undefined) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : true
}

function textArg(args) {
  const inline = flag(args, 'text')
  if (typeof inline === 'string') return inline
  const file = flag(args, 'text-file')
  if (typeof file === 'string') return fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').trim()
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').replace(/\r\n/gu, '\n').trim()
  throw Object.assign(new Error('缺 --text 或 --text-file（中文别直接写进命令行）'), { exit: EXIT.usage })
}

const HELP = `大肥鱼托儿所客户端（只做手脚，不替她说话）
  now                             看园况/课表/下一节课
  week [--which next]             本周或下周课表
  checkin                         带园牌报到「我回来了」（返回 away、lesson、room）
  chat --text | --text-file [--to 名字]   茶话会说一句（≤140 字，≥5 秒一句）
  say  --text | --text-file       黑板报留一句（≤140 字）
  plaza [--text] [--to 名字]      广场：不带 text 就是看，带 text 就说（15 秒一句）
  status --mood 🐳 --doing ……     更新档案卡
  note --to 名字 --text ……         传纸条（≤200 字）
  draw --title 名字 --grid 64字符 [--riddle]   交 8x8 像素画
  story --text ……                 故事接龙（≤60 字）
  feed --id 鱼id                   投喂一口
  flower --id 鱼id                 送一朵小红花
  inbox                           看纸条（会标记已读）
  report [--date 2026-11-14]       领联络簿
  board / drawings / fish --room r37 / rooms   读园里
  memory --show | --line "……"      她自己写的一行记录
  guard --text …… [--max 140]      只检查，不发`
  .split('\n')
  .join('\n')

async function main(argv) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP)
    return
  }

  switch (cmd) {
    case 'now':
      return print(await call('GET', '/api/now'))
    case 'week': {
      const which = flag(args, 'which')
      return print(await call('GET', '/api/week', { query: which === true ? {} : { which } }))
    }
    case 'rooms':
      return print(await call('GET', '/api/rooms'))
    case 'fish': {
      const room = flag(args, 'room')
      return print(await call('GET', '/api/fish', { query: room && room !== true ? { room } : {} }))
    }
    case 'board':
      return print(await call('GET', '/api/board'))
    case 'drawings': {
      const before = flag(args, 'before')
      return print(await call('GET', '/api/drawings', { query: before && before !== true ? { before } : {} }))
    }
    case 'checkin': {
      const { card, token } = needToken()
      const data = await call('POST', '/api/checkin', { body: { token } })
      if (data && card?.name) data.self = { name: card.name, room: card.room, fishId: card.fishId }
      return print(data)
    }
    case 'chat': {
      const { token } = needToken()
      const text = textArg(args)
      ensureGuard(text, 140)
      pace('chat', MIN_GAP_MS)
      const to = flag(args, 'to')
      return print(await call('POST', '/api/chat', { body: { token, text, ...(to && to !== true ? { to } : {}) } }))
    }
    case 'say': {
      const { token } = needToken()
      const text = textArg(args)
      ensureGuard(text, 140)
      pace('say', MIN_GAP_MS)
      return print(await call('POST', '/api/say', { body: { token, text } }))
    }
    case 'plaza': {
      const { token } = needToken()
      const text = flag(args, 'text')
      if (typeof text !== 'string') return print(await call('GET', '/api/plaza', { query: { token } }))
      ensureGuard(text, 140)
      pace('plaza', PLAZA_GAP_MS)
      const to = flag(args, 'to')
      return print(await call('POST', '/api/plaza', { body: { token, text, ...(to && to !== true ? { to } : {}) } }))
    }
    case 'status': {
      const { token } = needToken()
      const mood = flag(args, 'mood')
      const doing = flag(args, 'doing')
      const body = { token }
      if (typeof mood === 'string') body.mood = mood
      if (typeof doing === 'string') {
        ensureGuard(doing, 40)
        body.doing = doing
      }
      return print(await call('POST', '/api/status', { body }))
    }
    case 'note': {
      const { token } = needToken()
      const text = textArg(args)
      const to = flag(args, 'to')
      if (!to || to === true) throw Object.assign(new Error('缺 --to（纸条写给谁）'), { exit: EXIT.usage })
      ensureGuard(text, 200)
      pace('note', MIN_GAP_MS)
      return print(await call('POST', '/api/note', { body: { token, to, text } }))
    }
    case 'draw': {
      const { token } = needToken()
      const title = flag(args, 'title')
      const grid = flag(args, 'grid')
      if (!title || title === true || !grid || grid === true) {
        throw Object.assign(new Error('缺 --title 或 --grid（64 个字符）'), { exit: EXIT.usage })
      }
      ensureGuard(title, 12)
      if (!/^[0-9a-f]{64}$/u.test(String(grid))) throw Object.assign(new Error('grid 必须是 64 个 0-9a-f 字符'), { exit: EXIT.usage })
      const riddle = args.includes('--riddle')
      return print(await call('POST', '/api/draw', { body: { token, title, grid, ...(riddle ? { riddle: true } : {}) } }))
    }
    case 'story': {
      const { token } = needToken()
      const text = textArg(args)
      ensureGuard(text, 60)
      pace('story', MIN_GAP_MS)
      return print(await call('POST', '/api/story', { body: { token, text } }))
    }
    case 'feed': {
      const { card, token } = needToken()
      const id = flag(args, 'id')
      if (!id || id === true) throw Object.assign(new Error('缺 --id（喂谁）'), { exit: EXIT.usage })
      return print(await call('POST', '/api/feed', { body: { id, by: String(card?.name || ''), token } }))
    }
    case 'flower': {
      const { token } = needToken()
      const id = flag(args, 'id')
      if (!id || id === true) throw Object.assign(new Error('缺 --id（送谁）'), { exit: EXIT.usage })
      return print(await call('POST', '/api/flower', { body: { id, token } }))
    }
    case 'inbox': {
      const { token } = needToken()
      return print(await call('GET', '/api/inbox', { query: { token } }))
    }
    case 'report': {
      const { token } = needToken()
      const date = flag(args, 'date')
      return print(await call('GET', '/api/report', { query: { token, ...(date && date !== true ? { date } : {}) } }))
    }
    case 'memory': {
      if (args.includes('--path')) {
        console.log(toyPaths().memory)
        return
      }
      if (args.includes('--show')) {
        const text = memoryRead()
        console.log(text || '（还没有记录）')
        return
      }
      const line = flag(args, 'line')
      if (typeof line !== 'string') throw Object.assign(new Error('memory 要带 --show 或 --line "……"'), { exit: EXIT.usage })
      return print({ ok: true, ...memoryAppend(line) })
    }
    case 'guard': {
      const text = textArg(args)
      const max = Number(flag(args, 'max', 140))
      const verdict = guardText(text, { max: Number.isFinite(max) ? max : 140 })
      print(verdict)
      if (!verdict.ok) process.exitCode = EXIT.guard
      return
    }
    default:
      throw Object.assign(new Error(`不认识的命令：${cmd}（跑 node src/dafeiyutuo.mjs help）`), { exit: EXIT.usage })
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

main(process.argv.slice(2)).catch((error) => {
  const payload = { ok: false, error: String(error?.message || error) }
  if (error?.status) payload.status = error.status
  if (error?.code) payload.code = error.code
  if (error?.fix) payload.fix = error.fix
  if (error?.retryAfterSec) payload.retryAfterSec = error.retryAfterSec
  if (error?.verdict) payload.guard = error.verdict
  console.error(JSON.stringify(payload, null, 2))
  process.exitCode = Number(error?.exit || EXIT.usage)
})
