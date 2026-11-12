// B站黑话：看到不懂的梗/缩写，记下来；同一个词再见一次就确认，之后评论里可以自然用。
// 用法:
//   node bili.mjs slang list [--status confirmed|candidate|all] [--json]
//   node bili.mjs slang query <词>
//   node bili.mjs slang add "<词>" --meaning "你猜的意思" [--usage "什么时候用"] [--example "例句"] [--source "BV.../热评"] [--json]
//   node bili.mjs slang confirm <词> [--meaning "..."] [--json]
//   node bili.mjs slang remove <词> [--json]   # 每周复盘：清掉猜错的/过时的
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addBiliSlang, confirmBiliSlang, removeBiliSlang, loadBiliSlang, queryBiliSlang, buildBiliSlangPromptBlock, SLANG_STATUS,
} from '../../lib/bili-slang.js'
import { biliStateDir } from '../lib/state-paths.mjs'

const dir = biliStateDir()

const argv = process.argv.slice(2)
const sub = argv[0] || 'list'
const opt = {}
const rest = []
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) opt[key] = true
    else { opt[key] = next; i += 1 }
  } else rest.push(argv[i])
}
const wantJson = opt.json === true

if (sub === 'list') {
  const status = String(opt.status ?? 'all')
  const rows = loadBiliSlang(dir).filter((e) => status === 'all' || e.status === status)
  if (wantJson) { console.log(JSON.stringify({ dir, entries: rows }, null, 2)); process.exit(0) }
  if (!rows.length) { console.log('还没有学到的 B站 黑话（用 slang add 记词）'); process.exit(0) }
  for (const e of rows) {
    console.log(`[${e.status}] ${e.content}：${String(e.meaning || '').slice(0, 60)}${e.usage ? ` · ${String(e.usage).slice(0, 40)}` : ''}`)
  }
  process.exit(0)
}
if (sub === 'query') {
  const term = rest[0] ?? ''
  const rows = queryBiliSlang(dir, term)
  if (wantJson) { console.log(JSON.stringify({ term, entries: rows }, null, 2)); process.exit(0) }
  if (!rows.length) { console.log(`没学过「${term}」。先记：slang add "${term}" --meaning "你猜的意思" --source "出处"`); process.exit(0) }
  for (const e of rows) console.log(`[${e.status}] ${e.content}：${e.meaning || '（还没有意思）'}${e.usage ? ` · ${e.usage}` : ''}`)
  process.exit(0)
}
if (sub === 'add') {
  const term = rest[0] ?? ''
  if (!term) { console.error('用法: slang add "<词>" --meaning "..." [--usage ...] [--example ...] [--source ...]'); process.exit(2) }
  const entry = addBiliSlang(dir, {
    content: term,
    meaning: String(opt.meaning ?? ''),
    usage: String(opt.usage ?? ''),
    example: String(opt.example ?? ''),
    source: String(opt.source ?? 'bili'),
    evidence: String(opt.source ?? 'bili'),
  })
  if (wantJson) console.log(JSON.stringify(entry, null, 2))
  else console.log(`记下了：${entry?.content}（${entry?.status}）${entry?.status === 'confirmed' ? '，之后可以自然用' : '，再见一次确认'}`)
  process.exit(0)
}
if (sub === 'confirm') {
  const term = rest[0] ?? ''
  if (!term) { console.error('用法: slang confirm <词> [--meaning ...]'); process.exit(2) }
  const entry = confirmBiliSlang(dir, term, { meaning: String(opt.meaning ?? '') })
  if (wantJson) console.log(JSON.stringify(entry, null, 2))
  else console.log(`已确认：${entry?.content}（${entry?.status}）`)
  process.exit(0)
}
if (sub === 'remove') {
  const term = rest[0] ?? ''
  if (!term) { console.error('用法: slang remove <词>'); process.exit(2) }
  const entry = removeBiliSlang(dir, term)
  if (wantJson) console.log(JSON.stringify({ removed: entry }, null, 2))
  else console.log(entry ? `删掉了：${entry.content}（${entry.status}）` : `没找到：${term}`)
  process.exit(0)
}
if (sub === 'prompt') {
  console.log(buildBiliSlangPromptBlock(dir, Number(opt.max ?? 8) || 8) || '（还没有已确认的黑话）')
  process.exit(0)
}
console.error('未知子命令。可用: list / query / add / confirm / remove / prompt')
process.exit(2)
