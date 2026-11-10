#!/usr/bin/env node
/**
 * 视频互动（2026-11-10 主人定：按权重点赞/投币/收藏，可以只用其中几种组合）
 *
 *   node bili.mjs engage <BV> [--score N] [--dry|--go] [--json]
 *   node bili.mjs engage <BV> --actions like,coin        # 显式指定组合（跳过随机）
 *   node bili.mjs engage --status [--json]               # 看今天用了多少、下次能不能用
 *
 * 规则（代码强制）：
 *   ① 只给**她自己打过分的视频**做互动（没看过就别三连）；--score 可现场补，但更推荐先 `score`。
 *   ② 权重 = 分数 / 20，越喜欢越可能往上走：
 *        先掷「点不点赞」(pLike·w) → 点了再掷「投不投币」(pCoin·w) → 投了再掷「收藏」(pFav·w)
 *      所以自然出现四种结果：什么都不做 / 只点赞 / 点赞+投币 / 一键三连。分数高也不保证三连。
 *   ③ 每天上限：点赞 8 · 投币 3 · 收藏 2（收藏还要再过 fav 自己的判据）；两次 engage 至少隔 5 分钟。
 *   ④ **投币不可撤回**：只有真喜欢才投，一次一个币；--dry 先看计划，--go 才真发。
 *   ⑤ 沉默逛（interact.enabled=false）时一律拒绝。
 *
 * 为什么不做成"自动每次必三连"：B站的风控和真人观感都更在意"节奏"，一直三连是刷的状态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { assertInteractEnabled } from '../lib/interact.mjs'
import { loadScores } from '../lib/scores.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BILI_CLI = path.join(HERE, '..', 'bili.mjs')
const STATE = biliState('engage.json')
const today = () => new Date().toLocaleDateString('sv-SE')

const cfg = config()
const E = cfg.engage ?? {}
const P = { like: 0.55, coin: 0.45, fav: 0.40, ...(E.probabilities ?? {}) }
const CAP = {
  like: Number(E.likeDaily ?? 8),
  coin: Number(E.coinDaily ?? 3),
  fav: Number(E.favDaily ?? 2),
}
const MIN_GAP_MS = Number(E.minGapMin ?? 5) * 60000
const PENDING_TTL_MS = 10 * 60000

// ── 参数 ───────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = {}
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else positional.push(argv[i])
}
const bv = positional[0] ?? ''
const DRY = !!opt.dry
const GO = !!opt.go
const JSON_OUT = !!opt.json

const loadState = () => {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} }
}
const saveState = (s) => {
  try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n') } catch {}
}
const state = loadState()
const day = today()
const used = state.daily?.[day] ?? { like: 0, coin: 0, fav: 0 }

const cred = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
    return c?.sessdata && c?.bili_jct ? c : null
  } catch { return null }
})()
const cookie = cred ? `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}${cred.buvid3 ? `; buvid3=${cred.buvid3}` : ''}` : ''
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', ...(cookie ? { cookie } : {}) }

function print(obj) {
  if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); return }
  if (obj.text) console.log(obj.text)
}

function scoreOf(bvid) {
  if (opt.score !== undefined) return { score: Number(opt.score), source: '--score' }
  const all = loadScores()
  let best = null
  for (const list of Object.values(all ?? {})) {
    for (const x of Array.isArray(list) ? list : []) {
      if (x?.bv === bvid && (!best || Number(x.score) > Number(best.score))) best = x
    }
  }
  return best ? { score: Number(best.score), source: 'scores.json', reason: best.reason, title: best.title } : null
}

// ── --status ─────────────────────────────────────────────
if (opt.status) {
  const lastAt = Number(state.lastAt ?? 0)
  const gapLeft = lastAt ? Math.max(0, MIN_GAP_MS - (Date.now() - lastAt)) : 0
  const out = {
    date: day,
    used,
    cap: CAP,
    gapLeftMin: Math.ceil(gapLeft / 60000),
    enabled: E.enabled !== false,
    probabilities: P,
    text: [
      `今天（${day}）互动：点赞 ${used.like}/${CAP.like} · 投币 ${used.coin}/${CAP.coin} · 收藏 ${used.fav}/${CAP.fav}`,
      gapLeft ? `距离上次互动还要等 ${Math.ceil(gapLeft / 60000)} 分钟` : '现在可以互动',
      `概率：点赞 ${P.like} · 投了再投币 ${P.coin} · 投了再收藏 ${P.fav}（按分数权重打折）`,
    ].join('\n'),
  }
  print(out)
  process.exit(0)
}

if (!DRY && !assertInteractEnabled('给视频点赞/投币/收藏')) process.exit(3)
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) {
  console.error('用法：node bili.mjs engage <BV> [--score N] [--dry|--go] [--actions like,coin,fav]')
  process.exit(2)
}

const sc = scoreOf(bv)
if (!sc) {
  console.error(`✗ [ENGAGE_NO_SCORE] 没找到 ${bv} 的评分记录：先看完再 \`score ${bv} --score N --reason "…"\`，`)
  console.error('  或者直接传 --score N（不推荐：三连应该建立在真看过的基础上）。')
  process.exit(4)
}
const weight = Math.max(0, Math.min(1, sc.score / 20))

// ── 决策 ─────────────────────────────────────────────────
function decide() {
  if (opt.actions) {
    const list = String(opt.actions).split(',').map((s) => s.trim()).filter(Boolean)
    const bad = list.filter((x) => !['like', 'coin', 'fav'].includes(x))
    if (bad.length) { console.error(`✗ --actions 里有不认识的：${bad.join(',')}（只能是 like/coin/fav）`); process.exit(2) }
    const set = new Set(list)
    if (set.has('coin')) set.add('like')      // 投币必伴随点赞（B站 语义）
    if (set.has('fav') && !set.has('coin')) { /* 允许只收藏 */ }
    return ['like', 'coin', 'fav'].filter((a) => set.has(a))
  }
  const actions = []
  if (Math.random() < P.like * weight) actions.push('like')
  if (actions.includes('like') && Math.random() < P.coin * weight) actions.push('coin')
  if (actions.includes('coin') && Math.random() < P.fav * weight) actions.push('fav')
  return actions
}

// dry 时把计划存 10 分钟，--go 直接沿用，保证"看到什么就执行什么"
function plannedActions() {
  const p = state.pending
  if (GO && p && p.bv === bv && Date.now() - new Date(p.at).getTime() < PENDING_TTL_MS) return p.actions
  return null
}

const actions = (DRY ? null : plannedActions()) ?? decide()

// 额度裁剪（超了就从后往前砍）
const trimmed = []
for (const a of actions) {
  if (used[a] >= CAP[a]) break
  trimmed.push(a)
}

const vid = { bv, aid: '', title: sc.title ?? '' }

if (!DRY) {
  const view = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { headers: H }).then((r) => r.json()).catch(() => null)
  if (view?.code === 0) { vid.aid = String(view.data.aid); vid.title = String(view.data.title ?? '') }
  if (!vid.aid) { console.error(`✗ 取不到视频信息（view code=${view?.code ?? '?'}）—— 先用 --dry 看看，或晚点再试`); process.exit(5) }
}

const plan = { bv, title: vid.title, score: sc.score, weight: Number(weight.toFixed(2)), actions: trimmed, dry: DRY }
if (DRY) {
  state.pending = { bv, actions: trimmed, at: new Date().toISOString() }
  saveState(state)
  plan.text = [
    `[dry] ${bv}「${vid.title || '（标题未知）'}」分数 ${sc.score}/20 → 权重 ${plan.weight}`,
    `  计划：${trimmed.length ? trimmed.map((a) => ({ like: '点赞', coin: '投币', fav: '收藏' })[a]).join(' + ') : '什么都不做'}`,
    `  今天已用：点赞 ${used.like}/${CAP.like} 投币 ${used.coin}/${CAP.coin} 收藏 ${used.fav}/${CAP.fav}`,
    trimmed.length ? '  确认后加 --go 执行（10 分钟内沿用这份计划）' : '  这一条就这样了（不动作也是正常结果）',
  ].join('\n')
  print(plan)
  process.exit(0)
}

if (!trimmed.length) {
  state.lastAt = new Date().toISOString()
  saveState(state)
  plan.text = `跳过 ${bv}「${vid.title}」：这次掷到什么都不做（分数 ${sc.score}/20，权重 ${plan.weight}）。`
  print(plan)
  process.exit(0)
}

// ── 执行 ─────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function jitter(min = 1200, max = 2600) { return min + Math.round(Math.random() * (max - min)) }

const done = []
const failed = []
const post = async (url, form) => {
  const body = new URLSearchParams({ ...form, csrf: String(cred?.bili_jct ?? '') })
  const r = await fetch(url, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const hint = (code) => (code === -101 ? '（未登录/SESSDATA 过期，重新扫码登录）'
  : code === -111 ? '（csrf 失效，重新登录一次）'
    : code === -400 ? '（请求被拒，可能是风控）'
      : '')

for (const a of trimmed) {
  await sleep(jitter())
  if (a === 'like') {
    const { status, json } = await post('https://api.bilibili.com/x/web-interface/archive/like', { aid: vid.aid, like: '1' }).catch((e) => ({ status: 0, json: { message: e?.message } }))
    if (json.code === 0) done.push('like')
    else failed.push({ action: 'like', code: json.code, message: json.message, hint: hint(json.code) })
    void status
  } else if (a === 'coin') {
    const { json } = await post('https://api.bilibili.com/x/web-interface/coin/add', {
      aid: vid.aid, multiply: '1', select_like: done.includes('like') ? '0' : '1',
    }).catch((e) => ({ json: { message: e?.message } }))
    if (json.code === 0) done.push('coin')
    else failed.push({ action: 'coin', code: json.code, message: json.message, hint: hint(json.code) })
  } else if (a === 'fav') {
    const reason = String(opt.reason || `${sc.score}/20 分：${vid.title || bv}`).slice(0, 60)
    const r = spawnSync(process.execPath, [BILI_CLI, 'fav', bv, '--reason', reason, '--go'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) done.push('fav')
    else failed.push({ action: 'fav', code: r.status, message: (r.stderr || '').trim().split('\n').slice(-2).join(' ') })
  }
}

if (done.length) {
  state.daily = state.daily ?? {}
  const d = state.daily[day] ?? { like: 0, coin: 0, fav: 0 }
  for (const a of done) d[a] = (d[a] ?? 0) + 1
  state.daily[day] = d
  state.lastAt = new Date().toISOString()
  state.pending = null
  state.log = [...(state.log ?? []), { at: new Date().toISOString(), bv, title: vid.title, score: sc.score, weight: plan.weight, done, failed }].slice(-100)
  saveState(state)
}
void DAY
plan.done = done
plan.failed = failed
plan.text = [
  `engage ${bv}「${vid.title}」分数 ${sc.score}/20 → ${done.length ? done.map((a) => ({ like: '点赞', coin: '投币', fav: '收藏' })[a]).join(' + ') : '无'}`,
  ...(failed.length ? failed.map((f) => `  ✗ ${f.action} 失败：code=${f.code} ${f.message ?? ''}${f.hint ?? ''}`) : []),
  `  今天已用：点赞 ${state.daily?.[day]?.like ?? 0}/${CAP.like} 投币 ${state.daily?.[day]?.coin ?? 0}/${CAP.coin} 收藏 ${state.daily?.[day]?.fav ?? 0}/${CAP.fav}`,
].join('\n')
print(plan)
process.exit(failed.length && !done.length ? 1 : 0)
