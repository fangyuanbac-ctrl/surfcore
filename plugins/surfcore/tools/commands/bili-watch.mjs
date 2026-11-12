// 让 agent 真"看"视频：取直链 → 抽帧拼成一张九宫格 → 输出图片路径（再交给 read_image 看）
//
// 用法: node bili-watch.mjs <BV号> [列x行，默认 3x3] [outDir] [--range 起-止] [--download] [--keep-mp4] [--uniform]
//   例: node bili-watch.mjs BV1iLYm6VET3            → 3x3 九宫格，原片默认清理
//       node bili-watch.mjs BV1iLYm6VET3 4x4        → 16 格，看得更细
//       node bili-watch.mjs BV... --range 600-1200  → 只看 10:00~20:00 这段（长视频用）
//       node bili-watch.mjs BV... --keep-mp4         → 保留原片，方便换参数重抽
//
// 2026-11-11（长视频支持）：时长 ≥ 20 分钟的片子不再下载整片，直接对 B站 直链按时间点
// 远程 seek 抽帧（HTTP Range，一帧约 3 秒）。50 分钟的教程抽 9 帧约 30 秒，不用下载几百 MB。
// 短片子仍走原来的「下载整片 + scene 吸附」路径；--download 可强制回旧路径。
//
// 依赖：ffmpeg（查找顺序见 lib/ffmpeg.mjs：$FFMPEG → PATH → bin/ → ~/.dsh/surfcore/bili/bin → 本机剪映）
import { accountBili, biliState, biliStateDir } from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireFfmpeg } from '../lib/ffmpeg.mjs'
import { appendWatch } from '../lib/watch-history.mjs'
import { formatShotsStats, pruneShots, shotsPath } from '../lib/shots-cache.mjs'

let FFMPEG
try { FFMPEG = requireFfmpeg() } catch (e) { console.error(String(e.message)); process.exit(2) }
const argv = process.argv.slice(2)
// 带值的旗标不算位置参数（以前 `--range 600-1200` 会被当成 grid，踩过一次）
const FLAGS_WITH_VALUE = new Set(['--range', '--samples'])
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    if (FLAGS_WITH_VALUE.has(argv[i])) i += 1
    continue
  }
  positional.push(argv[i])
}
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const keepMp4 = argv.includes('--keep-mp4') || process.env.SURFCORE_KEEP_MP4 === '1'
const bvid = positional[0]
const grid = (positional[1] ?? '3x3').toLowerCase()
const outDir = positional[2] ?? shotsPath('video')
const isDefaultOutDir = path.resolve(outDir) === path.resolve(shotsPath('video'))
if (!bvid) { console.error('用法: node bili-watch.mjs <BV号> [列x行] [outDir] [--range 起-止] [--download] [--keep-mp4] [--uniform]'); process.exit(2) }
const [cols, rows] = grid.split('x').map(Number)
if (!cols || !rows) { console.error('格子格式应是 3x3 这样'); process.exit(2) }
const N = cols * rows
// mm:ss 或纯秒
const parseTime = (s) => {
  const v = String(s ?? '').trim()
  if (/^\d+:\d{1,2}$/.test(v)) { const [m, sec] = v.split(':').map(Number); return m * 60 + sec }
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }

const view = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: H })).json()
if (view.code !== 0) { console.error(`view 失败 code=${view.code} ${view.message}`); process.exit(3) }
const { cid, title, duration, owner } = { ...view.data, owner: view.data.owner?.name }
console.log(`标题: ${title}`)
console.log(`UP: ${owner}   时长: ${duration}s   cid=${cid}`)

// 画质实测（2026-10-14）：html5 + qn=32 会被压到 360p（返回 quality=16，界面小字全糊）；
// 改 platform=pc + qn=80 可拿到 720p（返回 quality=64），依旧是普通 mp4 直链，不必碰 dash。
const p = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&platform=pc&high_quality=1`, { headers: H })).json()
const url = p.data?.durl?.[0]?.url
if (!url) { console.error(`没拿到直链（code=${p.code}）——有些视频要登录或只有 dash 流`); process.exit(4) }
const QN = { 16: '360P', 32: '480P', 64: '720P', 80: '1080P' }
const qualityText = QN[p.data.quality] ?? String(p.data.quality ?? '?')
console.log(`实际画质: ${qualityText}`)

fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const mp4 = path.join(outDir, `${bvid}-${stamp}.mp4`)
const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)

// ── 长视频：不下载整片，远程按时间点抽帧（2026-11-11）──
// 背景：50 分钟的教程整片下载要几百 MB，agent 判断“等不起”就只看字幕 → 说“看过”但画面一眼没看。
// 远程 seek 一帧约 3 秒，9 帧 ≈ 30 秒，代价小到可以真看；短片子仍走原来的整片下载。
const LONG_VIDEO_SEC = 1200
const wantDownload = argv.includes('--download') || keepMp4
const rangeRaw = flagValue('range')
let rangeStart = 0
let rangeEnd = Number(duration) || 0
if (rangeRaw) {
  const [a, b] = String(rangeRaw).split('-')
  const start = parseTime(a)
  const end = parseTime(b)
  if (Number.isFinite(start)) rangeStart = Math.max(0, Math.min(start, (duration || 1) - 1))
  if (Number.isFinite(end)) rangeEnd = Math.max(rangeStart + 1, Math.min(end, duration || end))
}
if (!(rangeEnd > rangeStart)) { rangeStart = 0; rangeEnd = Number(duration) || 1 }
const useRemote = Boolean(argv.includes('--remote')) || (!wantDownload && Number(duration) >= LONG_VIDEO_SEC)
let mp4Downloaded = false
if (!useRemote) {
  const r = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', range: 'bytes=0-' } })
  if (!r.ok) { console.error(`下载失败 HTTP ${r.status}`); process.exit(5) }
  fs.writeFileSync(mp4, Buffer.from(await r.arrayBuffer()))
  mp4Downloaded = true
  console.log(`已下载: ${mp4}  (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB)`)
}

// ── 取帧方式：优先"画面变化点"，不够再退回等间隔（2026-10-14 参考 K3 的做法）
// 画面变化由 ffmpeg 的 scene 过滤器给出：空跑一次，把 pts_time 抓出来，再从中均匀挑 N 个。
// 好处：等间隔会漏掉"只出现一两秒的关键画面"，画面变化点天然落在场景切换处。
function sceneTimes(file, th) {
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-i', file, '-vf',
      `select='gt(scene,${th})',metadata=print:file=-`, '-an', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    const ts = [...out.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]))
    return [...new Set(ts)].filter((t) => t > 0.2)
  } catch { return [] }
}
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const pickEvenly = (list, n) =>
  n <= 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])

const span = Math.max(1, rangeEnd - rangeStart)
const uniform = Array.from({ length: N }, (_, i) => rangeStart + ((i + 0.5) * span) / N)
let times = uniform
let how = `等间隔（每 ${(span / N).toFixed(1)} 秒一帧）`
if (useRemote) {
  // 远程抽帧：不做 scene 检测（要整片扫描），用等间隔覆盖采样段
  how = `远程抽帧（不下载整片）· ${N} 点覆盖 ${fmt(rangeStart)}~${fmt(rangeEnd)}，每 ${(span / N).toFixed(1)} 秒一帧`
} else if (!argv.includes('--uniform')) {
  // 阈值阶梯：录屏/讲解类画面变化平缓，0.3 常只检出几处 → 逐级放宽
  let st = [], used = 0.3
  for (const th of [0.3, 0.15, 0.08]) { used = th; st = sceneTimes(mp4, th); if (st.length >= N) break }

  if (st.length > 0) {
    // 关键设计（2026-10-14 踩过两次才定）：
    //   ① 只按"变化点里均匀挑"会出事——转场全挤在开头，中段 50 秒一帧没有，叙事线直接断
    //   ② 只按等间隔会漏掉"只闪一两秒的关键画面"
    //   ⇒ 用**等间隔当骨架保证覆盖**，再把每帧**吸附到 ±半格内最近的变化点**（吸不到就保持等间隔）
    const half = span / N / 2
    let snapped = 0
    times = uniform.map((u) => {
      const near = st.filter((s) => Math.abs(s - u) <= half)
      if (!near.length) return u
      snapped += 1
      return near.reduce((b, s) => (Math.abs(s - u) < Math.abs(b - u) ? s : b), near[0])
    })
    how = `等间隔骨架（保覆盖）+ 吸附画面变化点（阈值 ${used} 检出 ${st.length} 处；${snapped}/${N} 帧吸到了变化点）`
  } else {
    how = `纯等间隔（阈值 0.08 也未检出变化 → 每 ${(span / N).toFixed(1)} 秒一帧）`
  }
}
if (rangeEnd < duration) console.log(`只看一段: ${fmt(rangeStart)}~${fmt(rangeEnd)}（整片 ${fmt(duration)}）`)
console.log(`取帧方式: ${how}`)
console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmt(t)}`).join('  ')}`)

// 抽帧：每个时间点各抽一张原始分辨率，再拼图——这样 SHEET 与 SUBS 干净地共用同一批帧
const tmp = path.join(outDir, `.frames-${stamp}`)
fs.mkdirSync(tmp, { recursive: true })
let frameError = null
let got = 0
try {
  try {
    if (useRemote) {
      // 远程：直接对直链 seek 抽帧（不落 mp4）。CDN 偶发 416/断流 → 每帧最多重试 3 次。
      const okTimes = []
      let failed = 0
      for (const t of times) {
        const out = path.join(tmp, `f${String(okTimes.length).padStart(2, '0')}.jpg`)
        let ok = false
        let lastErr = null
        for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
          try {
            execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2),
              '-headers', `referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`,
              '-i', url, '-frames:v', '1', '-q:v', '3', out],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
            ok = fs.existsSync(out) && fs.statSync(out).size > 2000
            if (!ok) lastErr = new Error('帧文件为空')
          } catch (e) { lastErr = e }
        }
        if (ok) okTimes.push(t)
        else {
          failed += 1
          if (lastErr) console.error(`抽帧失败 ${fmt(t)}：${String(lastErr.message).split('\n')[0].slice(0, 160)}`)
        }
      }
      if (!okTimes.length) throw new Error('远程抽帧全部失败（直链可能拒绝 Range 请求）')
      if (failed) console.log(`⚠️ ${N} 帧里成功 ${okTimes.length} 帧（${failed} 帧重试后仍失败，已跳过）`)
      times = okTimes
      got = okTimes.length
      // tile 需要满格：不够就用最后一帧补齐（图里会重复，但不会缺格/报错）
      for (let i = got; i < N; i += 1) {
        fs.copyFileSync(path.join(tmp, `f${String(got - 1).padStart(2, '0')}.jpg`), path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`))
      }
      got = N
      console.log(`（远程抽帧完成：${okTimes.length}/${N} 帧真实采样，其余补位）`)
    } else {
      times.forEach((t, i) => {
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', mp4,
          '-frames:v', '1', path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)], { stdio: 'inherit' })
      })
      got = N
    }
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
      `scale=480:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet], { stdio: 'inherit' })
    if (!fs.existsSync(sheet)) throw new Error('九宫格没生成')
    console.log(`\nSHEET: ${sheet}`)
  } catch (e) {
    console.error('ffmpeg 抽帧失败：' + e.message)
    frameError = e
  }

  // 字幕条版：裁掉画面、只留底部字幕带再放大，竖着拼 N 条。
  // 依据（2026-10-14 实测）：这类"讲解型"视频字幕就是全部信息量，全画幅九宫格会把字幕压糊；
  // 同样预算下只留字幕带，9 条字幕能全部读清。用的是同一批帧。
  const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
  if (!frameError) {
    try {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(tmp, 'f%02d.jpg'), '-vf',
        `crop=iw:ih*0.17:0:ih*0.83,scale=1280:-1,tile=1x${got}`, '-frames:v', '1', subs], { stdio: 'inherit' })
      if (fs.existsSync(subs)) {
        console.log(`SUBS:  ${subs}\n（${useRemote
          ? `远程模式：这 ${got} 条只是采样点的字幕带，不是全片字幕——全片字幕请用 \`node bili.mjs subtitles <BV>\``
          : `同一批帧的底部字幕带，竖排 ${got} 条`}）`)
      }
    } catch {
      console.log('（字幕条版生成失败，忽略——不影响 SHEET）')
    }
  }
} finally {
  // 无论 ffmpeg 成功失败都清临时帧；以前失败会留下 .frames-*。
  fs.rmSync(tmp, { recursive: true, force: true })
}
if (frameError) process.exit(6)
const subs = path.join(outDir, `${bvid}-${stamp}-subs.jpg`)
if (mp4Downloaded && keepMp4) {
  console.log(`（原片保留: ${mp4}；加 --uniform 可强制等间隔）`)
} else if (mp4Downloaded) {
  try { fs.rmSync(mp4, { force: true }) } catch {}
  console.log('（原片已清理；需要换参数重抽时加 --keep-mp4）')
} else {
  console.log('（长视频远程抽帧：没有下载原片；想细看某一段就加 --range 起-止，例如 --range 600-1200）')
}
if (isDefaultOutDir) {
  try { console.log(formatShotsStats(pruneShots())) } catch {}
} else {
  console.log('（自定义 outDir：跳过默认 shots 清理）')
}
console.log('（提示：这条视频若有官方字幕，先跑 `node bili.mjs subtitles <BV>` 更省也更准——' +
  '抽帧是给"字幕没官方轨、或要看画面/界面"的情况用的）')
if (Number(duration) >= LONG_VIDEO_SEC) {
  console.log('（长视频：默认远程抽帧覆盖全片；想认真看某一段就加 `--range 起-止`，例如 `--range 600-1200` 只看 10:00~20:00）')
}

// 观看历史：直接调 watch-video 时记一笔；被 debrief 调用时由 debrief 统一记账，避免重复。
if (!process.env.SURFCORE_WATCH_PARENT && !process.argv.includes('--no-history')) {
  const rec = appendWatch({
    at: new Date().toISOString(),
    bvid,
    aid: String(view.data.aid ?? ''),
    title,
    up: owner,
    upMid: view.data.owner?.mid ?? '',
    duration,
    tname: view.data.tname ?? '',
    mode: 'frames',
    frames: true,
    source: process.env.SURFCORE_WATCH_SOURCE || 'watch',
    sheet,
    subs: fs.existsSync(subs) ? subs : '',
  })
  if (rec.ok) console.log(`[观看历史] 已记一笔：${bvid}（抽帧）`)
}
