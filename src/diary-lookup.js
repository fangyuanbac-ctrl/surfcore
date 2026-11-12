/**
 * 「翻日记」——QQ 侧没有本地工具，但她是同一个人：
 * 主人问「昨天/前天/某月某日 干了什么、聊了什么」时，桥接替她从现在的日记和聊天摘要里翻，
 * 只把那一小段塞进这一轮提示词。不是每轮都注入，只有问到时间/回忆时才翻。
 *
 * 数据源：
 *   · <角色>/bili/whale-diary.md（她那天的叙事日记）
 *   · <角色>/bili/whale-diary-private.md（私人版；只取极短的一段，避免背出隐私）
 *   · ~/.dsh/surfcore/shared/digest.jsonl（QQ 收尾摘要，按日期过滤）
 */
import fs from 'node:fs'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 从一句话里找“问的是哪几天”。返回 { dates:Set, latest:boolean } */
export function dateHints(text, now = new Date()) {
  const s = String(text ?? '')
  const dates = new Set()
  let latest = false
  const addDays = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); dates.add(dayOf(d)) }
  if (/前天/.test(s)) addDays(2)
  if (/昨天|昨晚/.test(s)) addDays(1)
  if (/大前天/.test(s)) addDays(3)
  if (/今天|刚才|今天早上|今天下午|今天晚上/.test(s)) addDays(0)
  if (/这几天|最近|这阵子|上次|之前|那晚|那天|记不记得|记得|想不起来|日记|什么时候/.test(s)) latest = true
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

function sectionsOf(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const out = []
    let cur = null
    for (const line of lines) {
      if (/^#\s/.test(line)) {
        if (cur) out.push(cur)
        cur = { header: line.trim(), lines: [] }
      } else if (cur) {
        cur.lines.push(line)
      }
    }
    if (cur) out.push(cur)
    return out
  } catch { return [] }
}

function digestEntries() {
  try {
    const p = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'surfcore', 'shared', 'digest.jsonl')
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/**
 * @param {object} opts
 * @param {string} opts.dir 角色 bili 目录
 * @param {string} opts.text 主人最近说的话
 * @param {number} [opts.maxChars]
 * @returns {string} 以两个换行结尾的块；没翻到或没问时间 → ''
 */
export function diaryRecallBlock({ dir, text, maxChars = 1400 } = {}) {
  const { dates, latest } = dateHints(text)
  const asksRecall = dates.size > 0 || latest
  if (!asksRecall || !dir) return ''

  const want = new Set(dates)
  const sections = sectionsOf(path.join(dir, 'whale-diary.md'), 'utf8')
  const privateSections = sectionsOf(path.join(dir, 'whale-diary-private.md'))
  const pick = (list) => list.filter((sec) => {
    const headerDate = (sec.header.match(/(\d{4})-(\d{2})-(\d{2})/) || [])[0]
    return headerDate && (want.size ? want.has(headerDate) : true)
  })

  let chosen = pick(sections)
  let chosenPrivate = pick(privateSections)
  const allDigest = digestEntries()
  const digestFor = (date) => allDigest
    .filter((e) => date && dayOf(new Date(Number(e.ts))) === date)
    .slice(-4)
    .map((e) => `${String(e.gist ?? '').slice(0, 60)}${e.next ? `（下次可接：${String(e.next).slice(0, 40)}）` : ''}`)

  if (!chosen.length && latest) {
    // 没指定日期（“上次/那天/最近”）→ 拿最后一天的
    chosen = sections.slice(-1)
    chosenPrivate = privateSections.slice(-1)
  }

  const parts = []
  for (const sec of chosen.slice(0, 2)) {
    const headerDate = (sec.header.match(/(\d{4})-(\d{2})-(\d{2})/) || [])[0] || ''
    const body = sec.lines.filter((l) => l.trim()).slice(0, 12).join('\n')
    const privateBits = chosenPrivate
      .filter((p) => !headerDate || p.header.includes(headerDate))
      .flatMap((p) => p.lines.filter((l) => /主人|偏好|心情|不爽|开心|累/.test(l)).slice(0, 3))
    const digest = digestFor(headerDate)
    parts.push([
      `· ${headerDate} 的日记：`,
      body,
      privateBits.length ? `· 那天她自己记下的感受：\n${privateBits.join('\n')}` : '',
      digest.length ? `· 那天和主人聊到：${digest.join(' / ')}` : '',
    ].filter(Boolean).join('\n'))
  }

  // 没有日记的那天（比如“不看”的夜晚，或还没写）→ 有当天的聊天摘要也行
  if (!parts.length && want.size) {
    for (const date of want) {
      const digest = digestFor(date)
      if (digest.length) parts.push(`· ${date} 和主人聊到：${digest.join(' / ')}`)
    }
  }
  if (!parts.length) return ''
  let out = `【你翻到的记忆】（主人问到那几天，才用；用自然的话说，别照着念）\n${parts.join('\n\n')}\n\n`
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…\n\n`
  return out
}
