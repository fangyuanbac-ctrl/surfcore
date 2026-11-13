#!/usr/bin/env node
// scripts/check-prompt-contract.mjs — 提示词契约自检（2026-11-12，报告 §103）
//
// 背景：行为规则靠「提示词里写一遍」不可持续——改一处忘一处、两处口径打架，
// 只能等她真说出「看完了」才发现。这个脚本把「可机械核对的部分」变成断言：
//   1. 规则编号不重复（4.99 重号这类）；
//   2. 已被推翻的硬口径不再出现在提示词里（必须发言 / 额度花完 / 字幕=看完）；
//   3. 提示词里写的数字 == 配置里的数字（私聊单轮上限）；
//   4. 跨平台记忆的承诺与实际注入一致（qqToBili 关闭时不许承诺「共享近况」）；
//   5. AGENTS.md 的视频口径与 scheduler 4.1/4.2 一致（默认抽帧，不是「subtitles 最省」）。
//
// 用法：node scripts/check-prompt-contract.mjs [--json]
// 退出码：0 全过；1 有失败（CI/定时任务可直接用）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { biliPolicy, qqPolicy, displayPolicy } from '../plugins/surfcore/tools/lib/prompt-policy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const home = process.env.USERPROFILE || process.env.HOME || ''

const F = {
  scheduler: path.join(repo, 'plugins/surfcore/lib/scheduler.js'),
  bridge: path.join(repo, 'src/bridge.js'),
  config: path.join(repo, 'config.json'),
  biliConfig: path.join(home, '.dsh/surfcore/bili.config.json'),
  biliAgents: path.join(home, '.dsh/surfcore/state/bili-agents/AGENTS.md'),
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const S = { scheduler: read(F.scheduler), bridge: read(F.bridge), biliAgents: read(F.biliAgents) }
let cfg = {}
try { cfg = JSON.parse(read(F.config) || '{}') } catch { cfg = {} }
let biliCfg = {}
try { biliCfg = JSON.parse(read(F.biliConfig) || '{}') } catch { biliCfg = {} }

const results = []
const check = (id, name, fn) => {
  let ok = false
  let detail = ''
  try {
    const r = fn()
    ok = r === true || (r && r.ok === true)
    detail = r && r.detail ? r.detail : ''
  } catch (e) {
    ok = false
    detail = String(e && e.message ? e.message : e)
  }
  results.push({ id, name, ok, detail })
}

// 1. 规则编号唯一（4.7/4.8/4.9/4.99/5… 这种行首编号）
check('rule-number-unique', 'scheduler.js 规则编号不重复', () => {
  const seen = new Map()
  const dup = []
  for (const m of S.scheduler.matchAll(/^\s{0,6}(\d+(?:\.\d+)?)\)\s/gm)) {
    const n = m[1]
    if (seen.has(n)) dup.push(n)
    seen.set(n, true)
  }
  return dup.length === 0 ? true : { ok: false, detail: `重复编号：${[...new Set(dup)].join(', ')}` }
})

// 2. 被推翻的硬口径不能再回来
check('no-mandatory-speech', '提示词不含「必须发言 / 额度花完」这类硬口径', () => {
  const bad = ['至少发一条主动评论', '额度要花完', '这一轮至少搭', '这一步是强制的']
  const hit = bad.filter((s) => S.scheduler.includes(s))
  return hit.length === 0 ? true : { ok: false, detail: `仍在：${hit.join(' / ')}` }
})

// 3. 陈旧章节引用（AGENTS.md 已没有这些章节）
check('no-stale-section-refs', '提示词不引用已不存在的 AGENTS.md 章节', () => {
  const stale = ['看的那晚', '不看的那晚', '倾听 · 直播间']
  const hit = stale.filter((s) => S.scheduler.includes(s))
  return hit.length === 0 ? true : { ok: false, detail: `仍在：${hit.join(' / ')}` }
})

// 4. QQ 提示词的数字来自 prompt-policy（config → qqPolicy），桥接不再写死
check('token-guard-matches-config', 'QQ 提示词的条数/字数与 config 一致且走 prompt-policy', () => {
  const tg = cfg?.socialV2?.tokenGuard ?? {}
  if (!tg.privateMaxOutboundPerTurn) return { ok: false, detail: 'config 缺 socialV2.tokenGuard.privateMaxOutboundPerTurn' }
  const QP = qqPolicy(cfg)
  if (Number(tg.privateMaxOutboundPerTurn) !== QP.privateMaxOutboundPerTurn) return { ok: false, detail: 'qqPolicy 与 config 不一致' }
  if (!S.bridge.includes('QP.privateMaxOutboundPerTurn') || !S.bridge.includes('QP.maxCharsPerMessage')) {
    return { ok: false, detail: 'bridge.js 没有用 qqPolicy 插值条数/字数' }
  }
  return true
})

// 5. qqToBili 关闭时不许承诺「共享最近近况」
check('qq-to-bili-claim', 'B站 人设块对跨平台记忆的承诺与实际开关一致', () => {
  const enabled = cfg?.memory?.qqToBili?.enabled === true
  const guarded = S.scheduler.includes('qqToBili?.enabled === true')
  if (!guarded) return { ok: false, detail: 'scheduler.js 的「共享近况」文案没有按 qqToBili.enabled 分支' }
  return true
})

// 6. AGENTS.md 视频口径：默认抽帧；不接受「subtitles 最省 = 看完」
check('bili-agents-video-rule', 'bili-agents/AGENTS.md 视频口径与 4.1/4.2 一致', () => {
  if (!S.biliAgents) return { ok: false, detail: `读不到 ${F.biliAgents}` }
  const bad = ['认真看完（`subtitles', 'subtitles ` 最省']
  const hit = bad.filter((s) => S.biliAgents.includes(s))
  const hasDebrief = /debrief/.test(S.biliAgents)
  const hasRange = /--range/.test(S.biliAgents)
  if (hit.length) return { ok: false, detail: `仍是「字幕=看完」口径：${hit.join(' / ')}` }
  if (!hasDebrief || !hasRange) return { ok: false, detail: '缺 debrief / --range 的「真看完」口径' }
  return true
})

// 7. 「只读了字幕就不许说看过」在两个层都写着（代码闸的提示行 + 规则）
check('honesty-rule-present', '「没抽帧不能说看过」在代码闸与规则里都在', () => {
  const inScheduler = /只读了字幕/.test(S.scheduler)
  const inAgents = /只看了字幕|只读了字幕/.test(S.biliAgents)
  const inComment = fs.existsSync(path.join(repo, 'plugins/surfcore/tools/commands/comment.mjs'))
    && read(path.join(repo, 'plugins/surfcore/tools/commands/comment.mjs')).includes('真抽帧闸')
  return inScheduler && inAgents && inComment ? true : { ok: false, detail: `scheduler=${inScheduler} agents=${inAgents} commentGate=${inComment}` }
})

// 8. scheduler 提示词里的 B站 数字必须来自 biliPolicy，不再出现字面量
check('bili-prompt-uses-policy', 'scheduler 的收藏/鱼赞/总结/字数数字来自 prompt-policy', () => {
  const need = ['P.favDaily', 'P.fishLikeDaily', 'P.fishLikePerRun', 'P.dmSummaryDaily', '.quietShareDaily',
    'P.replyCharsMin', 'P.publicCommentMaxChars', 'P.dmShareCharsMin', 'P.dmReplyDaily']
  const miss = need.filter((s) => !S.scheduler.includes(s))
  if (miss.length) return { ok: false, detail: `缺插值：${miss.join(', ')}` }
  const literals = [
    /一天最多\s*\d+\s*条/,
    /每天最多\s*\d+\s*个/,
    /每天最多\s*\d+\s*个\s*·\s*每次最多\s*\d+\s*个/,
    /一条一般\s*\d+~\d+\s*字/,
    /\b\d+~\d+\s*字，先说看完/,
    /一天共\s*\d+\s*条/,
    /超\s*\d+\s*字\s*→\s*直接拒/,
    /同一视频\s*\d+\s*天一次/,
    /理由\s*≥\d+\s*字/,
    /≥\d+\s*字\s*\/\s*每天上限/,
  ]
  const hit = literals.filter((re) => re.test(S.scheduler)).map((re) => String(re))
  return hit.length ? { ok: false, detail: `仍有字面量：${hit.join(' / ')}` } : true
})

// 9. biliPolicy 的计算结果与 bili.config.json 一致
check('policy-matches-bili-config', 'biliPolicy 与 bili.config.json 一致', () => {
  const P = biliPolicy(biliCfg)
  const expect = [
    ['favDaily', Number(biliCfg?.engage?.favDaily ?? 2)],
    ['fishLikeDaily', Number(biliCfg?.fishGuard?.maxLikesPerDay ?? 6)],
    ['fishLikePerRun', Number(biliCfg?.fishGuard?.maxLikesPerRun ?? 4)],
  ]
  const bad = expect.filter(([k, v]) => P[k] !== v).map(([k, v]) => `${k}=${P[k]}≠${v}`)
  const enabledKinds = Object.values(biliCfg?.dynamics?.kinds ?? {}).filter((v) => v && v.enabled !== false).length
  if (P.dmSummaryDaily !== enabledKinds) bad.push(`dmSummaryDaily=${P.dmSummaryDaily}≠${enabledKinds}`)
  return bad.length ? { ok: false, detail: bad.join('; ') } : true
})

// 10. QQ 字数上限：config 有值、qqPolicy 用它、bridge 插值用它
check('token-guard-chars-matches-config', 'QQ 提示词「每条别超 N 字」与 config 一致', () => {
  const n = cfg?.socialV2?.tokenGuard?.maxCharsPerMessage
  if (!n) return { ok: false, detail: 'config 缺 socialV2.tokenGuard.maxCharsPerMessage' }
  if (qqPolicy(cfg).maxCharsPerMessage !== Number(n)) return { ok: false, detail: 'qqPolicy 与 config 不一致' }
  if (!S.bridge.includes('QP.maxCharsPerMessage')) return { ok: false, detail: 'bridge.js 没插值 QP.maxCharsPerMessage' }
  return true
})

// 11. 展示性常量（评论/私信长度、陌生人私信上限、收藏判据）由 displayPolicy 单一提供
check('display-policy-single-source', 'comment/dm/fav 的闸门数字来自 displayPolicy / biliPolicy', () => {
  const comment = read(path.join(repo, 'plugins/surfcore/tools/commands/comment.mjs'))
  const dm = read(path.join(repo, 'plugins/surfcore/tools/commands/dm.mjs'))
  const fav = read(path.join(repo, 'plugins/surfcore/tools/commands/fav.mjs'))
  const problems = []
  if (!comment.includes('displayPolicy.shareCommentMaxChars') || !comment.includes('displayPolicy.publicCommentMaxChars')) problems.push('comment.mjs 没导入 displayPolicy 的评论长度')
  if (/SHARE \? 120 : 40/.test(comment)) problems.push('comment.mjs 仍有 SHARE ? 120 : 40')
  if (!dm.includes('displayPolicy.dmReplyDaily') || !dm.includes('displayPolicy.dmReplyPerPersonDaily')) problems.push('dm.mjs 没导入 displayPolicy 的陌生人上限')
  if (/const STRANGER_DAILY = 30/.test(dm) || /const PER_PERSON_DAILY = 3/.test(dm) || /const MAX_LEN = 200/.test(dm)) problems.push('dm.mjs 仍有写死的陌生人上限')
  if (!fav.includes('displayPolicy.favReasonMinChars') || !fav.includes('displayPolicy.favRepeatDays') || !fav.includes('biliPolicy(cfg).favDaily')) problems.push('fav.mjs 没走 displayPolicy / biliPolicy')
  if (/todayCount >= 3/.test(fav) || /length < 6/.test(fav) || /days < 30\)/.test(fav)) problems.push('fav.mjs 仍有写死的收藏判据')
  const D = displayPolicy
  if (D.dmReplyDaily < D.dmReplyPerPersonDaily) problems.push(`dmReplyDaily(${D.dmReplyDaily}) < 每人上限(${D.dmReplyPerPersonDaily})，额度用不满`)
  return problems.length ? { ok: false, detail: problems.join('; ') } : true
})

// 12. 「我对主人的认识」：文件存在，且 QQ（bridge）与 B站（scheduler）两侧都注入（2026-11-14，报告 §114）
check('owner-understanding-wired', '「我对主人的认识」文件存在且两侧注入', () => {
  const problems = []
  const hasFile = (() => {
    try {
      const base = path.join(home, '.dsh/surfcore/characters')
      return fs.readdirSync(base).some((d) => fs.existsSync(path.join(base, d, 'memory', 'owner-understanding.md')))
    } catch { return false }
  })()
  if (!hasFile) problems.push('owner-understanding.md 不存在')
  if (!S.bridge.includes('ownerUnderstandingPromptBlock')) problems.push('bridge.js 没注入')
  if (!S.scheduler.includes('ownerUnderstandingBlockForBili')) problems.push('scheduler.js 没注入')
  if (!S.scheduler.includes('owner-understanding.md')) problems.push('scheduler 没告诉她在哪改')
  return problems.length ? { ok: false, detail: problems.join('; ') } : true
})

const failed = results.filter((r) => !r.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2))
} else {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? ` · ${failed.length} 项失败` : ''}`)
}
process.exit(failed.length ? 1 : 0)
