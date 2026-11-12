/**
 * 主人口味（只读）—— 2026-11-11
 *
 * 她说「关注列表得登录才能看」：B站 网页上确实要登录，但这台机器上主人的 B站 账号
 * 已经扫码登录过（~/.dsh/surfcore/bili/owner-credentials.json），工具链能只读读他的
 * 关注 / 观看历史 / 收藏夹。这里把结果缓存成一行，注入她 B站 醒来提示，别每轮都扫。
 *
 * 隐私：只读、不点赞/不关注、不写主人账号；数据只在她自己的 B站 会话提示里出现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { scanPreferences } from '../tools/lib/pref-scan.mjs'
import { appendSelfNote } from '../../../src/shared-memory.js'

const CACHE_FILE = 'owner-taste.json'
const MAX_AGE_MS = 20 * 60 * 60 * 1000

export function readOwnerTaste(dir, maxAgeMs = MAX_AGE_MS) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'))
    if (!raw?.line) return ''
    if (Date.now() - Number(raw.at ?? 0) > maxAgeMs) return ''
    return String(raw.line)
  } catch { return '' }
}

let refreshing = false

/** 缓存过期才真去扫（一次 3 个只读 GET）；失败静默，不影响生物钟 */
export async function refreshOwnerTaste(dir) {
  if (refreshing) return ''
  if (readOwnerTaste(dir)) return ''
  refreshing = true
  try {
    const result = await scanPreferences({ target: 'owner', sources: ['history', 'favorites', 'following'], limit: 8 })
    const sources = Array.isArray(result?.sources) ? result.sources : []
    const following = sources.find((s) => s.name === 'owner-following')
    const hasOwnerData = sources.some((s) => s.name === 'owner-history' && s.ok)
    if (!hasOwnerData) return ''
    // 标签 / 收藏夹名比标题切片更像人话：优先取带 tag / folder 的来源，再按分数补
    const candidates = (result?.candidates ?? [])
      .filter((c) => String(c?.keyword ?? '').length >= 2)
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
    const preferred = candidates.filter((c) => (c.sources ?? []).some((s) => /-(tag|folder)$/.test(String(s))))
    const words = [...preferred, ...candidates]
      .map((c) => String(c.keyword))
      .filter((w, i, arr) => arr.indexOf(w) === i)
      .slice(0, 3)
    if (!words.length) return ''
    const count = Number(following?.items ?? 0)
    const line = `${count ? `关注 ${count} 个 UP；` : ''}最近常看/收藏：${words.join('、')}`
    const prev = readOwnerTaste(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify({ at: Date.now(), line }, null, 2) + '\n')
    // 同步进共享自我记忆：QQ 那边唤醒时也能看到「主人 B站 爱看什么」（不是每轮都写）
    if (line !== prev) {
      try { appendSelfNote({ platform: 'bili', text: `主人 B站：${line}` }) } catch {}
    }
    return line
  } catch {
    return ''
  } finally {
    refreshing = false
  }
}
