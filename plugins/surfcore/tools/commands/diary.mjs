// 「她的一天」—— 让主人看得见她做了什么（可见性层，2026-10-14 主人问"我怎么知道她做了什么"）
//
// 用法:
//   node diary.mjs show [--days 1]      人读摘要：今天看了什么 / 想了什么 / 发了什么 / 额度还剩多少
//   node diary.mjs log <kind> [--target X] [--note "…"]   记一条结构化事件到 ~/.dsh/surfcore/bili/whale-log.jsonl
//   node diary.mjs tail [--n 20]        最近的结构化事件
//   node diary.mjs inbox-append --text "…" [--visibility public|private]   QQ 窗口只写收件箱
//   node diary.mjs inbox-merge          B站窗口把收件箱并进两本日记并归档
//
// 三个数据源（各司其职）：
//   ~/.dsh/surfcore/bili/whale-diary.md      叙事（她自己的话：看过的、想法池、谁回过她）—— 给人读
//   ~/.dsh/surfcore/bili/quota.json      发言账（每条对外发言，含"自主/主人授权"标记）—— 给闸门与审计用
//   ~/.dsh/surfcore/bili/whale-log.jsonl     事件流（看/想/发/被回… 结构化）—— 给程序与其他端用
//
// 关键约定（写进 AGENTS.md）：**自主发言之后必须主动通知主人**（notify_wechat），
// 因为"她自己决定的对外动作"必须让主人事后可见 —— 这是 B 档能成立的前提。
import { accountBili, biliState, biliStateDir } from '../lib/state-paths.mjs'
import { appendSelfNote } from '../../../../src/shared-memory.js'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
// 设置页的「日记总开关」真的生效（2026-10-18 修）：关掉就什么都不记
if (config().diary?.enabled === false) { console.log('（日记总开关关着 —— 这次不记）'); process.exit(0) }
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  else if (!opt._a) opt._a = argv[i]
}
const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const DIARY = biliState('whale-diary.md')
const PRIVATE = biliState('whale-diary-private.md')
// QQ 窗口只写这一个收件箱；两本正式日记只由 B站窗口合并/写入，避免两边同时改同一文件。
const INBOX = biliState('qq-diary-inbox.md')
const INBOX_ARCHIVE = biliState('qq-diary-inbox.merged.md')
const INBOX_LOCK = biliState('.qq-diary-inbox.lock')
const QUOTA = biliState('quota.json')
const LOG = biliState('whale-log.jsonl')
const today = () => new Date().toLocaleDateString('sv-SE')
const hhmm = (iso) => String(iso).slice(11, 16)
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 收件箱锁：QQ 追加和 B站 合并都走这里。`wx` 是原子创建；锁超过 60 秒视为上一个进程
// 崩溃留下的孤儿锁。锁只覆盖 inbox，正式日记仍由 B站 单个窗口写。
function withInboxLock(fn) {
  fs.mkdirSync(path.dirname(INBOX), { recursive: true })
  let fd = null
  for (let i = 0; i < 40; i += 1) {
    try {
      fd = fs.openSync(INBOX_LOCK, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(INBOX_LOCK).mtimeMs > 60_000) {
          fs.rmSync(INBOX_LOCK, { force: true })
          continue
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i < 10 ? 50 : 150)
    }
  }
  if (fd === null) throw new Error('日记收件箱忙，锁等待超时')
  try {
    fs.writeSync(fd, String(process.pid))
    return fn()
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.rmSync(INBOX_LOCK, { force: true }) } catch {}
  }
}

function parseInboxEntries(text) {
  const entries = []
  let cur = null
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) {
      if (cur) entries.push(cur)
      cur = { heading: h[1].trim(), body: [] }
      continue
    }
    if (cur) cur.body.push(line)
    else if (line.trim()) {
      if (!entries.length) entries.push({ heading: '', body: [] })
      entries[0].body.push(line)
    }
  }
  if (cur) entries.push(cur)
  return entries.filter((entry) => entry.heading || entry.body.join('').trim())
}

function mergeInbox() {
  return withInboxLock(() => {
    let raw = ''
    try { raw = fs.readFileSync(INBOX, 'utf8') } catch {}
    if (!raw.trim()) return { count: 0, public: 0, private: 0 }
    const entries = parseInboxEntries(raw)
    let pub = 0
    let priv = 0
    for (const entry of entries) {
      const heading = entry.heading || stamp()
      const isPublic = /\[(公开|public)\]/i.test(heading)
      const cleanHeading = heading
        .replace(/\[(公开|私密|public|private)\]/ig, '')
        .replace(/^QQ\s*[·:：-]\s*/i, '')
        .trim() || stamp()
      const body = entry.body.join('\n').trim()
      if (!body) continue
      const block = `\n\n## QQ · ${cleanHeading}\n${body}\n`
      if (isPublic) {
        fs.appendFileSync(DIARY, block, 'utf8')
        pub += 1
      } else {
        fs.appendFileSync(PRIVATE, block, 'utf8')
        priv += 1
      }
    }
    // 先归档原文再清空：万一写日记中途失败，用户还能从归档/原 inbox 里找回。
    fs.appendFileSync(INBOX_ARCHIVE, `\n\n<!-- merged ${new Date().toISOString()} -->\n${raw}`, 'utf8')
    fs.writeFileSync(INBOX, '', 'utf8')
    return { count: pub + priv, public: pub, private: priv }
  })
}

if (cmd === 'inbox-append') {
  const text = String(opt.text ?? opt.note ?? opt._a ?? '').trim()
  if (!text) {
    console.error('用法: diary.mjs inbox-append --text "内容" [--visibility public|private]')
    process.exit(1)
  }
  const visibility = opt.visibility === 'public' ? '公开' : '私密'
  try {
    withInboxLock(() => {
      fs.appendFileSync(INBOX, `\n## ${opt.at ? String(opt.at) : stamp()} [${visibility}]\n${text}\n`, 'utf8')
    })
    console.log(`已写入 QQ 日记收件箱（${visibility}）：${INBOX}`)
    process.exit(0)
  } catch (error) {
    console.error(`写收件箱失败：${error?.message ?? error}`)
    process.exit(1)
  }
}

if (cmd === 'inbox-merge') {
  try {
    const result = mergeInbox()
    console.log(result.count
      ? `已合并 QQ 日记 ${result.count} 条（公开 ${result.public} · 私密 ${result.private}）：${INBOX}`
      : `QQ 日记收件箱为空：${INBOX}`)
    process.exit(0)
  } catch (error) {
    console.error(`合并 QQ 日记失败：${error?.message ?? error}`)
    process.exit(1)
  }
}

if (cmd === 'log') {
  const kind = opt._a ?? 'event'
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, target: opt.target ?? null, note: opt.note ?? null }) + '\n')
  // 2026-11-11：B站 这边的心情/事件也进跨平台"自我层"，QQ 的她才知道 B站 的生活
  try { if (opt.note) appendSelfNote({ platform: 'bili', text: String(opt.note) }) } catch {}
  console.log(`已记：${kind}${opt.target ? ' → ' + opt.target : ''}`)
  process.exit(0)
}

if (cmd === 'tail') {
  const n = Number(opt.n ?? 20)
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) { console.log('（还没有事件记录）'); process.exit(0) }
  for (const l of lines.slice(-n)) {
    try { const e = JSON.parse(l); console.log(`  ${String(e.at).slice(0, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) }
    catch { console.log('  ' + l) }
  }
  process.exit(0)
}

if (cmd === 'show' || !cmd) {
  const days = Number(opt.days ?? 1)
  const since = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('sv-SE')
  const title = config().persona?.diaryTitle ?? '今日摘要'
  console.log(`════════ ${title}（${since} ~ ${today()}）════════\n`)

  // ① 叙事部分：解析日记
  let text = ''
  try { text = fs.readFileSync(DIARY, 'utf8') } catch { console.log(`（读不到日记 ${DIARY}）`) }
  if (text) {
    const sections = {}
    let cur = null
    for (const line of text.split('\n')) {
      const h = line.match(/^##\s+(.+)$/)
      if (h) { cur = h[1].trim(); sections[cur] = []; continue }
      if (cur) sections[cur].push(line)
    }
    // 看过的：表格里日期匹配的
    const seenKey = Object.keys(sections).find((k) => k.includes('看过')) ?? ''
    const rows = (sections[seenKey] ?? []).filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !l.includes('| 时间 |'))
    const hit = rows.filter((r) => r.includes(since) || r.includes(today()))
    console.log(`【看过 ${hit.length} 条】`)
    for (const r of hit) {
      const c = r.split('|').map((s) => s.trim()).filter(Boolean)
      console.log(`  · ${c[2] ?? c[0]}  ${String(c[3] ?? '').slice(0, 46)}`)
      if (c[4]) console.log(`      她的想法：${String(c[4]).slice(0, 120)}`)
    }
    // 想法池
    const wantKey = Object.keys(sections).find((k) => k.includes('想说')) ?? ''
    const wants = (sections[wantKey] ?? []).filter((l) => l.trim().startsWith('-') && !/^-\s*（空/.test(l.trim()))
    console.log(`\n【想说但还没说 ${wants.length} 条】`)
    for (const w of wants) console.log('  ' + w.trim().replace(/^-\s*/, '  · ').slice(0, 150))
  }

  // ② 发言账（她真的对外说了什么）
  console.log('\n【对外发言（今天）】')
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA, 'utf8'))
    const todayLog = (q.log ?? []).filter((x) => String(x.at).startsWith(today()))
    const auto = todayLog.filter((x) => x.auto).length
    console.log(`  共 ${todayLog.length} 条（自主 ${auto}/${q.daily}，主人授权 ${todayLog.length - auto}）`)
    for (const x of todayLog) console.log(`  · ${hhmm(x.at)}  ${x.type}${x.auto ? '（自主）' : ''}  ${x.target ?? ''}  ${x.note ?? ''}`)
    if (!todayLog.length) console.log('  （今天一条都没发）✓')
  } catch { console.log('  （还没有发言记录 —— 发第一条时 `quota record` 会自动建 quota.json）✓') }

  // ③ 事件流
  console.log('\n【最近事件】')
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) console.log('  （还没有事件记录 —— `diary log` 会往这里写）')
  for (const l of lines.slice(-6)) {
    try { const e = JSON.parse(l); console.log(`  · ${String(e.at).slice(5, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) } catch {}
  }
  console.log('\n（她是主动来找你的：自主发言后必须 notify_wechat —— 见 AGENTS.md「日子」一节）')
  process.exit(0)
}

console.log('用法: node diary.mjs show [--days 1] | log <kind> [--target X] [--note "…"] | tail [--n 20]')
