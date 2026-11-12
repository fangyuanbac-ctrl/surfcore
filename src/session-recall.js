/**
 * 「翻旧聊天」——QQ 侧没有本地工具，但 DSH 把每个会话都压存成 zstd JSONL。
 * 主人问「昨天/某天/上次/记得吗」时，桥接直接翻旧会话里她说过的话和他真正发的消息，
 * 只把匹配的一小段塞进这一轮提示词。
 *
 * 参考了市场插件 dsh-plugin-recall 的思路（按需全文检索历史），但不依赖被禁用的 FTS 索引：
 * 这里只读本地 zstd 会话文件、按时间/关键词过滤，够用且不装第三方。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** 「昨天/前天/上次/记得/某月某日」→ { dates:Set, latest:boolean } */
export function recallIntent(text, now = new Date()) {
  const s = String(text ?? '')
  const dates = new Set()
  let latest = false
  const addDays = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); dates.add(dayOf(d)) }
  if (/前天/.test(s)) addDays(2)
  if (/昨天|昨晚/.test(s)) addDays(1)
  if (/大前天/.test(s)) addDays(3)
  if (/今天|刚才|今晚/.test(s)) addDays(0)
  if (/上次|之前|记得|记不记得|那晚|那天|什么时候|翻旧|聊过/.test(s)) latest = true
  const re = /(?:(\d{4})[-/.])?(\d{1,2})[月./-](\d{1,2})[日号]?/g
  let m
  while ((m = re.exec(s))) {
    const year = m[1] ? Number(m[1]) : now.getFullYear()
    const month = Number(m[2])
    const day = Number(m[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) dates.add(`${year}-${pad(month)}-${pad(day)}`)
  }
  return { dates, latest }
}

const STOP = new Set(['记得', '记不记得', '之前', '上次', '那天', '那晚', '我们', '你还', '你', '我', '的', '了', '吗', '呢', '吧', '啊', '什么', '怎么', '时候', '聊', '过', '说', '给', '和', '跟', '是', '在', '有', '没'])

/** 从一句话里抽 2~4 个检索词（中文没空格：先剥掉功能词，再取剩余片段） */
export function keywordsOf(text) {
  let s = String(text ?? '').replace(/[【】「」《》()（）\[\]{}，,。.!！？?～~、\s]/g, ' ')
  const stops = ['记不记得', '记得', '之前', '上次', '那天', '那晚', '我们', '你还', '时候', '什么', '怎么', '后来', '然后', '一起', '那个', '这个', '你', '我', '的', '了', '吗', '呢', '吧', '啊', '聊', '还', '那', '这', '事', '过', '说', '给', '和', '跟', '是', '在', '有', '没', '要', '想', '去', '会', '就', '都']
  for (const w of stops) s = s.split(w).join(' ')
  const out = []
  for (const w of s.split(/\s+/)) {
    const v = w.trim()
    if (v.length < 2 || out.length >= 4) continue
    out.push(v.slice(0, 12))
  }
  return out
}

function sessionRootFor(workspaceDir) {
  const root = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'sessions')
  const folder = `--${String(workspaceDir).replace(/[:\\/]+/g, '-')}--`
  return path.join(root, folder)
}

function readSessionMessages(file) {
  try {
    const raw = fs.readFileSync(file)
    if (raw.length > 20 * 1024 * 1024) return []
    const text = zlib.zstdDecompressSync(raw).toString('utf8')
    const out = []
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.length > 200000) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const t = Number(o.time)
      if (!Number.isFinite(t)) continue
      const type = String(o.type ?? '')
      const blocks = Array.isArray(o.data?.message?.content)
        ? o.data.message.content
        : (Array.isArray(o.data?.content) ? o.data.content : [])
      const body = blocks
        .filter((b) => b && (b.type === 'text' || b.type === undefined || b.type === ''))
        .map((b) => String(b?.text ?? ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!body) continue
      if (type === 'assistant/message') {
        if (body.startsWith('【')) continue
        out.push({ t, who: '她', text: body.slice(0, 200) })
      } else if (type === 'user/message') {
        // 唤醒提示也会以 user/message 落盘；真正的主人消息很短、不以【开头
        if (body.startsWith('【') || body.length > 300) continue
        if (/Time sampled|Time sampled while|The approval policy changed/i.test(body)) continue
        out.push({ t, who: '主人', text: body.slice(0, 200) })
      }
    }
    return out
  } catch { return [] }
}

/**
 * @param {object} opts
 * @param {string[]} opts.dirs 工作区目录（QQ agents / B站 bili-agents）
 * @param {string} opts.text 主人最近的话
 * @param {number} [opts.maxChars]
 * @param {number} [opts.sessionsPerDir]
 */
export function sessionRecallBlock({ dirs = [], text = '', maxChars = 1200, sessionsPerDir = 3 } = {}) {
  const { dates, latest } = recallIntent(text)
  const keys = keywordsOf(text)
  if (!dates.size && !latest) return ''

  const hits = []
  for (const dir of dirs) {
    const root = sessionRootFor(dir)
    let subs = []
    try { subs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { continue }
    const files = subs
      .map((name) => ({ name, file: path.join(root, name, 'session.v4.jsonl.zstd') }))
      .filter((x) => { try { return fs.statSync(x.file).isFile() } catch { return false } })
      .map((x) => ({ ...x, mtime: fs.statSync(x.file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, sessionsPerDir)
    for (const { file } of files) {
      for (const msg of readSessionMessages(file)) {
        const day = dayOf(new Date(msg.t))
        // 有明确日期时只按日期取；关键词只用于“没给日期”的模糊回忆
        if (dates.size) {
          if (!dates.has(day)) continue
        } else if (keys.length && !keys.some((k) => msg.text.includes(k))) continue
        hits.push(msg)
        if (hits.length >= 60) break
      }
      if (hits.length >= 60) break
    }
    if (hits.length >= 60) break
  }
  if (!hits.length) return ''
  hits.sort((a, b) => a.t - b.t)
  const lines = hits.slice(-20).map((h) => `· ${dayOf(new Date(h.t)).slice(5)} ${hhmm(new Date(h.t))} ${h.who}：${h.text.slice(0, 90)}`)
  let out = `【翻到的旧聊天】（只在主人问到过去时用；用自然的话说，别逐条念）\n${lines.join('\n')}\n\n`
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…\n\n`
  return out
}
