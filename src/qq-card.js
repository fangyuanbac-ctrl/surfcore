// QQ / OneBot「json」消息段 → 可读文本（纯逻辑，无 IO）
//
// 背景（2026-11-11）：桥接以前把 json 卡片一律渲染成 `[卡片消息]`，标题和链接全丢。
// 主人在 QQ 分享 B 站视频时，她只看到「[卡片消息]」，不知道发的是什么、更看不了。
// 这里把卡片 JSON 里能拿到的 title / desc / 链接抠出来，尽量还原成一句话。
//
// 兼容的形态：
//   · OneBot 11:  { type:'json', data:{ data:'{"app":"com.tencent.structmsg",...}' } }
//   · SnowLuma 也可能直接给结构化对象
//   · 小程序卡：app="com.tencent.miniapp_01"，链接常在 meta.detail_1.qqdocurl
//   · 新闻/分享卡：app="com.tencent.structmsg"，链接常在 meta.news.jumpUrl

const URL_KEYS = new Set(['jumpurl', 'jump_url', 'qqdocurl', 'url', 'link', 'share_url', 'source_url', 'weburl'])
const TITLE_KEYS = new Set(['title', 'name', 'prompt'])
const DESC_KEYS = new Set(['desc', 'description', 'summary', 'content', 'text'])
const MAX_CHARS = 300

const BV_RE = /\bBV[0-9A-Za-z]{10}\b/
const BILI_URL_RE = /https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}[^\s"']*|https?:\/\/b23\.tv\/[0-9A-Za-z]+/i

/** 从任意文本里找 BV 号 */
export function bvidOf(text) {
  const m = String(text ?? '').match(BV_RE)
  return m ? m[0] : ''
}

/** 从任意文本里找 B 站链接（含 b23.tv 短链） */
export function biliUrlOf(text) {
  const m = String(text ?? '').match(BILI_URL_RE)
  return m ? m[0] : ''
}

function isHttp(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s.trim())
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return ''
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(String(k).toLowerCase()) && typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

// 深度找：优先 meta.news / meta.detail_1 / meta.detail，找不到再全树扫
function pick(obj) {
  const out = { title: '', desc: '', url: '' }
  if (!obj || typeof obj !== 'object') return out

  const meta = obj.meta
  if (meta && typeof meta === 'object') {
    for (const key of ['news', 'detail_1', 'detail', 'music', 'video']) {
      const sub = meta[key]
      if (!sub || typeof sub !== 'object') continue
      out.title ||= firstString(sub, TITLE_KEYS)
      out.desc ||= firstString(sub, DESC_KEYS)
      for (const [k, v] of Object.entries(sub)) {
        if (URL_KEYS.has(String(k).toLowerCase()) && isHttp(v)) { out.url ||= v.trim(); break }
      }
    }
  }
  // 全树兜底
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return }
    for (const [k, v] of Object.entries(node)) {
      const key = String(k).toLowerCase()
      if (typeof v === 'string') {
        if (!out.title && TITLE_KEYS.has(key) && v.trim()) out.title = v.trim()
        else if (!out.desc && DESC_KEYS.has(key) && v.trim()) out.desc = v.trim()
        else if (!out.url && URL_KEYS.has(key) && isHttp(v)) out.url = v.trim()
        else if (!out.url && isHttp(v) && /bilibili\.com|b23\.tv/i.test(v)) out.url = v.trim()
      } else if (v && typeof v === 'object') walk(v, depth + 1)
    }
  }
  walk(obj, 0)
  return out
}

function normalize(raw) {
  if (raw && typeof raw === 'object') {
    // OneBot: data.data 可能是 JSON 字符串
    if (typeof raw.data === 'string') {
      try { return JSON.parse(raw.data) } catch { /* 继续按对象处理 */ }
    }
    return raw
  }
  const s = String(raw ?? '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

/**
 * 卡片 → 一行可读文本；解析不出东西返回 null（调用方回退到 `[卡片消息]`）。
 * @param {any} raw  OneBot json 段的 data（对象或 JSON 字符串）
 * @returns {string|null}
 */
export function extractCardText(raw) {
  const obj = normalize(raw)
  if (!obj) {
    // 不是 JSON、但有 B 站链接的纯文本，也认
    const url = biliUrlOf(String(raw ?? ''))
    return url ? `[分享] ${url}` : null
  }
  const { title, desc, url } = pick(obj)
  const parts = []
  if (title) parts.push(title)
  if (desc && desc !== title) parts.push(desc)
  if (url && !parts.some((p) => p.includes(url))) parts.push(url)
  if (!parts.length) {
    // 连字段名都不认识：至少把卡片里的 B 站链接找出来
    const anyUrl = biliUrlOf(JSON.stringify(obj))
    if (anyUrl) parts.push(anyUrl)
  }
  if (!parts.length) return null
  let text = parts.join('｜')
  if (/bilibili\.com|b23\.tv/i.test(text)) text = `[B站分享] ${text}`
  return text.slice(0, MAX_CHARS)
}
