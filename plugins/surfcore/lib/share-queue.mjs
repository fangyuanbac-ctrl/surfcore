// 主人分享视频的「慢回」队列（纯逻辑，无 IO）
//
// 2026-11-11 主人要求：
//   · 分享给她的视频她**看了就行，不需要很快回复**（别秒回「看了」）；
//   · 回复要和她**自己刷到的视频**做出区分度（这是主人专门发给她的）。
// 做法：收到分享 → 先看（subtitles/debrief）→ 只记一条 pending（20~40 分钟后到期）→
//       到期由 scheduler 再叫她回，这时才真正回私信。
//
// 状态以数组存在 bili 角色目录的 dm-share-pending.json：
//   [{ bv, text, addedAt, dueAt, doneAt }]

export const DEFAULT_DELAY_MIN = 25
export const DEFAULT_JITTER_MIN = 12
export const KEEP_ENTRIES = 20
export const DEDUPE_HOURS = 72

/** 新建一条待回：delay = 25 ± 12 分钟（13~37 分钟，落在"不需要很快"里） */
export function makeEntry({ bv, text = '', now = Date.now(), delayMin = DEFAULT_DELAY_MIN, jitterMin = DEFAULT_JITTER_MIN, rand = Math.random } = {}) {
  if (!bv) throw new Error('bv required')
  const jitter = Math.round((rand() * 2 - 1) * jitterMin)
  const delay = Math.max(5, delayMin + jitter)
  return {
    bv: String(bv),
    text: String(text ?? '').slice(0, 300),
    addedAt: new Date(now).toISOString(),
    dueAt: now + delay * 60_000,
    doneAt: null,
  }
}

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(String(v ?? '')))

/** 追加；同一个 BV 72 小时内只排一次（她可能被重复唤醒，别排两次） */
export function addEntry(list, entry, { now = Date.now(), keepHours = DEDUPE_HOURS } = {}) {
  const arr = Array.isArray(list) ? [...list] : []
  const dup = arr.find((e) => e && e.bv === entry.bv && now - toMs(e.addedAt) < keepHours * 3_600_000)
  if (dup) return arr
  arr.push(entry)
  return arr.slice(-KEEP_ENTRIES)
}

/** 到点且还没回的那条（最早一条） */
export function dueEntry(list, now = Date.now()) {
  const arr = Array.isArray(list) ? list : []
  const due = arr
    .filter((e) => e && !e.doneAt && Number.isFinite(toMs(e.dueAt)) && toMs(e.dueAt) <= now)
    .sort((a, b) => toMs(a.dueAt) - toMs(b.dueAt))
  return due[0] ?? null
}

/** 标记已回 */
export function markDone(list, bv, now = Date.now()) {
  const arr = Array.isArray(list) ? list : []
  return arr.map((e) => (e && e.bv === bv && !e.doneAt ? { ...e, doneAt: new Date(now).toISOString() } : e))
}

/**
 * 安静时段（23:30–08:30）到期的，顺延到当天/次日 09:00。
 * 这样半夜收到的分享不会在凌晨把她叫起来回。
 */
export function deferQuiet(entry, { quietStart = 23 * 60 + 30, quietEnd = 8 * 60 + 30, wakeMin = 9 * 60 } = {}) {
  const t = new Date(entry.dueAt)
  const m = t.getHours() * 60 + t.getMinutes()
  const inQuiet = m >= quietStart || m < quietEnd
  if (!inQuiet) return entry
  const next = new Date(t)
  if (m >= quietStart) next.setDate(next.getDate() + 1)
  next.setHours(Math.floor(wakeMin / 60), wakeMin % 60, 0, 0)
  return { ...entry, dueAt: next.getTime() }
}
