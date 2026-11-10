// B 站私信内容解析（纯逻辑，无 IO）
//
// 背景（2026-11-11）：主人用 B 站「分享→私信」发视频给她时，dm-await 以前只取
// content/text 字段，视频分享卡里的 BV 很可能拿不到 → 她被叫醒了却不知道是哪个视频。
// 这里统一解析：文本私信照旧，分享卡尽量抠出 BV / 链接并补成可读文本。
//
// B站私信 content 常见形态：
//   · 文本：{"content":"…"}
//   · 分享卡（msg_type 7）：JSON 里带 bvid / jump_url / 嵌套的 {"id":...} 等
//   · 其它：JSON 里只有描述文字

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/
const BILI_URL_RE = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}[^\s"']*|https?:\/\/b23\.tv\/[0-9A-Za-z]+/i
const MAX_CHARS = 600

export function bvidOf(text) {
  const m = String(text ?? '').match(BV_RE)
  return m ? m[0] : ''
}

function findFirstUrl(text) {
  const m = String(text ?? '').match(BILI_URL_RE)
  return m ? m[0] : ''
}

function deepFirst(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return ''
  const arr = Array.isArray(obj) ? obj : Object.values(obj)
  // 先看当前层
  if (!Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(String(k).toLowerCase()) && typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  for (const v of arr) {
    if (v && typeof v === 'object') {
      const got = deepFirst(v, keys, depth + 1)
      if (got) return got
    }
  }
  return ''
}

const TITLE_KEYS = new Set(['title', 'video_title', 'name'])
const DESC_KEYS = new Set(['content', 'text', 'desc', 'description', 'summary'])

/**
 * @param {any} content 私信 content（JSON 字符串或纯文本）
 * @returns {{text:string,bvid:string,url:string,isShare:boolean}}
 */
export function parseDmContent(content) {
  const raw = String(content ?? '')
  let j = null
  try { j = JSON.parse(raw) } catch { j = null }

  if (!j || typeof j !== 'object') {
    const bvid = bvidOf(raw)
    const url = findFirstUrl(raw) || (bvid ? `https://www.bilibili.com/video/${bvid}/` : '')
    return { text: raw.trim().slice(0, MAX_CHARS), bvid, url, isShare: Boolean(url) }
  }

  // 文本字段（老行为）：content / text 直接是字符串
  let text = ''
  for (const k of ['content', 'text']) {
    const v = j[k]
    if (typeof v === 'string' && v.trim()) { text = v.trim(); break }
  }

  const bvid = deepFirst(j, new Set(['bvid', 'bv', 'bvid_str'])) || bvidOf(raw)
  let url = deepFirst(j, new Set(['jump_url', 'jumpurl', 'url', 'link', 'share_url'])) || findFirstUrl(raw)
  if (!url && bvid) url = `https://www.bilibili.com/video/${bvid}/`

  // 分享卡：文本字段可能只是标题/描述，补上链接
  if (!text) text = deepFirst(j, TITLE_KEYS) || deepFirst(j, DESC_KEYS)
  const hasLinkInText = Boolean(bvidOf(text) || findFirstUrl(text))
  if (url && !hasLinkInText) {
    text = text ? `${text} 视频：${url}` : `分享了一个视频：${url}`
  }

  return {
    text: String(text || raw).trim().slice(0, MAX_CHARS),
    bvid,
    url,
    isShare: Boolean(bvid || (url && /bilibili\.com|b23\.tv/i.test(url))),
  }
}
