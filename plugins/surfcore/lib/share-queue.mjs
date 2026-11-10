// 主人分享视频的「待回」队列（纯逻辑，无 IO）
//
// 2026-11-11 主人改口：**不要固定 20 分钟**了 ——
//   她自己决定什么时候回（时间不限、限制少、要主观能动性）。
// 这里只记「他发过哪些视频、她还没回」；下次她自然醒（生物钟/私信/评论区）时温和提醒一条，
// 回不回、什么时候回、回什么，都由她自己定。
//
// 状态存 bili 角色目录的 dm-share-pending.json：[{ bv, text, addedAt, doneAt }]

export const KEEP_ENTRIES = 20
export const DEDUPE_HOURS = 72

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(String(v ?? '')))

export function makeEntry({ bv, text = '', now = Date.now() } = {}) {
  if (!bv) throw new Error('bv required')
  return {
    bv: String(bv),
    text: String(text ?? '').slice(0, 300),
    addedAt: new Date(now).toISOString(),
    doneAt: null,
  }
}

/** 追加；同一个 BV 72 小时内只排一次（她被重复唤醒时不重复记） */
export function addEntry(list, entry, { now = Date.now(), keepHours = DEDUPE_HOURS } = {}) {
  const arr = Array.isArray(list) ? [...list] : []
  const dup = arr.find((e) => e && e.bv === entry.bv && now - toMs(e.addedAt) < keepHours * 3_600_000)
  if (dup) return arr
  arr.push(entry)
  return arr.slice(-KEEP_ENTRIES)
}

/** 还没回的分享（repliedAtMs = 她最近一次私信主人的时间，之后回答过的不再提醒） */
export function pendingEntries(list, { repliedAtMs = 0 } = {}) {
  const arr = Array.isArray(list) ? list : []
  return arr.filter((e) => e && !e.doneAt && toMs(e.addedAt) > Number(repliedAtMs || 0))
}

/** 标记已回 */
export function markDone(list, bv, now = Date.now()) {
  const arr = Array.isArray(list) ? list : []
  return arr.map((e) => (e && e.bv === bv && !e.doneAt ? { ...e, doneAt: new Date(now).toISOString() } : e))
}
