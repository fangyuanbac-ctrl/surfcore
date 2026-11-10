#!/usr/bin/env node
/**
 * 看一条视频的高赞评论（只读）—— 学语感用，不是抄内容。
 *
 *   node bili.mjs hot <BV> [--n 8] [--json]
 *
 * 2026-11-10（主人要求）：她回评论太像人机。发评论/搭话前先看热评怎么说话：
 *   多短、怎么起头、有没有标点、是不是一句就完。学的是语气，不是句子。
 * 只打表情/纯符号的评论会被过滤（学不到东西）。
 */
import fs from 'node:fs'
import { accountBili } from '../lib/state-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const argv = process.argv.slice(2)
const opt = {}
const pos = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2)
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) { opt[k] = argv[i + 1]; i += 1 } else opt[k] = true
  } else pos.push(argv[i])
}
const bv = pos[0] ?? ''
const n = Math.max(1, Math.min(20, Number(opt.n) || 8))
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) {
  console.error('用法：node bili.mjs hot <BV> [--n 8] [--json]')
  process.exit(2)
}

function loadCookie() {
  try {
    const c = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
    if (!c?.sessdata) return ''
    return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct ?? ''}${c.buvid3 ? `; buvid3=${c.buvid3}` : ''}`
  } catch { return '' }
}
const cookie = loadCookie()

async function get(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bv}/`, ...(cookie ? { cookie } : {}) },
  })
  return r.json()
}

const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`)
if (view?.code !== 0) {
  console.error(`✗ 取视频信息失败：code=${view?.code ?? '?'} ${view?.message ?? ''}`)
  process.exit(3)
}
const aid = view.data.aid
const title = String(view.data.title ?? '')

// sort=1：按点赞数排（热评口径）
const rep = await get(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=1&ps=20&pn=1`)
if (rep?.code !== 0) {
  console.error(`✗ 取评论失败：code=${rep?.code ?? '?'} ${rep?.message ?? ''}`)
  process.exit(3)
}

const rows = (rep.data?.replies ?? [])
  .map((x) => ({
    rpid: String(x.rpid),
    name: String(x.member?.uname ?? ''),
    like: Number(x.like ?? 0),
    text: String(x.content?.message ?? '').replace(/\s+/g, ' ').trim(),
  }))
  .filter((x) => x.text && !/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\[\]（）()、，。！？~～\-—_]+$/u.test(x.text))
  .sort((a, b) => b.like - a.like)
  .slice(0, n)
  .map((x) => ({ ...x, len: [...x.text].length, endsWithPeriod: /[。.]\s*$/.test(x.text) }))

if (opt.json) {
  console.log(JSON.stringify({ bv, aid, title, comments: rows }, null, 2))
  process.exit(0)
}

console.log(`高赞评论 · ${bv}「${title.slice(0, 40)}」（共 ${rows.length} 条）\n`)
for (const x of rows) {
  console.log(`  [赞 ${x.like}] ${x.len} 字${x.endsWithPeriod ? '（结尾有句号）' : ''}  ${x.text.slice(0, 100)}`)
}
console.log('\n看语感：多短、怎么起头、有没有标点、是不是一句就完。学语气，别抄内容也别抄句子。')
