/**
 * B站黑话学习（2026-11-11 主人要求）
 *
 * 为什么单独一套：QQ 侧的黑话来自群里聊天（bridge 的 slang-learner），B站侧她面对的是
 * 弹幕/热评/视频标题里的梗和缩写（如「整活」「典」「绷」「这波不亏」），来源和确认方式不同。
 * 存储放在当前角色的 bili 目录，和 QQ 黑话分开；同一套字段/上限复用 src/slang-learner.js。
 *
 * 状态：candidate（她看到/猜的，还没确认）→ confirmed（同一个词在另一处又见过，或她确认了）
 *       已确认的会注入她的 B站 唤醒提示，评论里可以自然用；candidate 不注入，避免用错。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  SLANG_STATUS, normalizeSlangEntry, capSlangEntries, upsertSlangEntry, createSlangEntry,
} from '../../../src/slang-learner.js'

const FILE = 'bili-slang.json'

function fileOf(dir) {
  return path.join(dir, FILE)
}

export function loadBiliSlang(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'))
    const rows = Array.isArray(j?.entries) ? j.entries : []
    return capSlangEntries(rows.map((e) => normalizeSlangEntry(e)).filter(Boolean)).entries
  } catch { return [] }
}

function saveBiliSlang(dir, entries) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fileOf(dir), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2)}\n`)
}

/** 记一个黑话候选：重复提交会累积 evidence，第二次见到（不同出处）自动确认。 */
export function addBiliSlang(dir, { content, meaning = '', usage = '', example = '', source = 'bili', evidence = '' } = {}) {
  const term = String(content ?? '').trim()
  if (!term) return null
  const entries = loadBiliSlang(dir)
  const before = entries.find((e) => e.content === term)
  const { entries: next, entry } = upsertSlangEntry(entries, term, { meaning, usage, example, source })
  if (entry) {
    const ev = { source: String(evidence || source || '') }
    entry.evidence = [...(entry.evidence ?? []), ev].slice(-10)
    if ((before?.evidence?.length ?? 0) >= 1 && meaning) entry.status = SLANG_STATUS.CONFIRMED
    entry.updatedAt = new Date().toISOString()
  }
  saveBiliSlang(dir, next)
  return entry
}

/** 确认一个候选（她自己在不同语境核过） */
export function confirmBiliSlang(dir, content, patch = {}) {
  const term = String(content ?? '').trim()
  if (!term) return null
  const entries = loadBiliSlang(dir)
  const { entries: next, entry } = upsertSlangEntry(entries, term, { ...patch, status: SLANG_STATUS.CONFIRMED })
  saveBiliSlang(dir, next)
  return entry
}

/** 删一个词（每周复盘时清掉猜错的/过时的） */
export function removeBiliSlang(dir, content) {
  const term = String(content ?? '').trim()
  if (!term) return null
  const entries = loadBiliSlang(dir)
  const hit = entries.find((e) => e.content === term)
  if (!hit) return null
  saveBiliSlang(dir, entries.filter((e) => e.content !== term))
  return hit
}

/** 查一个词（先看自己学没学过） */
export function queryBiliSlang(dir, term) {
  const q = String(term ?? '').trim().toLowerCase()
  if (!q) return []
  return loadBiliSlang(dir).filter((e) => String(e.content ?? '').toLowerCase().includes(q))
}

/** 注入唤醒提示的已确认黑话（≤max 条，按最近更新） */
export function buildBiliSlangPromptBlock(dir, max = 8) {
  const rows = loadBiliSlang(dir)
    .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, Math.max(0, Math.min(20, max)))
  if (!rows.length) return ''
  const lines = rows.map((e) => `· ${e.content}：${String(e.meaning).slice(0, 30)}${e.usage ? `（${String(e.usage).slice(0, 24)}）` : ''}`)
  return `【你会的B站黑话】（评论/搭话时自然用，别硬套）\n${lines.join('\n')}\n\n`
}

export { SLANG_STATUS }
