/**
 * 会话滚动（session rollover）：一条 DSH 会话聊太久，每次请求都要把整段历史重发一遍。
 *
 * 实测（2026-10-30 报告）：同一条会话 19.5 小时后，单步输入从 6.9 万涨到 43.5 万 token，
 * 常见 25~33 万；而每一轮还会因为工具调用重发 5 次左右。所以"换会话"是成本第一杠杆。
 *
 * 本文件只放**纯逻辑**（零 I/O、零副作用）：
 *   · 该不该换（shouldRollSession）
 *   · 换的时候给下一段会话留什么交接（buildHandoffBlock）
 *
 * 真正的副作用（retireSession / 落盘 / 提示词注入）留在 bridge。
 */

/** 默认关闭：新用户不主动换会话；开启前必须理解上下文会被重置。 */
export const DEFAULT_ROLLOVER = Object.freeze({
  enabled: false,
  tokens: 500000,
  turns: 0,
  summary: true,
  keepRecent: 24,
  summaryMaxChars: 700,
  // 刚建出来的会话（第 1 轮）不滚，否则交接摘要会变成"和空气交接"。
  minTurnsBeforeRoll: 2,
  // 2026-11-16：压缩只在每天凌晨 4 点这一个窗口里做，其他时间不主动滚。
  nightOnly: true,
  nightStartHour: 4,
  nightStartMinute: 0,
  nightWindowMinutes: 60
});

const clampInt = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/**
 * 把 `socialV2.context` 里那一小段配置收成可用形态。
 * 注意：读的是真配置对象，缺省一律回落到 DEFAULT_ROLLOVER。
 */
export function normalizeRolloverConfig(context = {}) {
  const src = context && typeof context === 'object' ? context : {};
  const rawEnabled = src.rolloverEnabled;
  const enabled = rawEnabled === undefined ? DEFAULT_ROLLOVER.enabled : rawEnabled !== false;
  return {
    enabled,
    // 2026-11-07：口径从「累计计费」改为「当前上下文」。
    // 旧字段 rolloverTokens 是累计账单含义，不能继续拿来当上下文阈值；
    // 新字段 rolloverContextTokens 缺省 50 万，老配置里的 8 万不会再误触发。
    tokens: clampInt(src.rolloverContextTokens, DEFAULT_ROLLOVER.tokens, 0, 2_000_000),
    turns: clampInt(src.rolloverTurns, DEFAULT_ROLLOVER.turns, 0, 100_000),
    summary: src.rolloverSummary === undefined ? DEFAULT_ROLLOVER.summary : src.rolloverSummary !== false,
    keepRecent: clampInt(src.rolloverKeepRecent, DEFAULT_ROLLOVER.keepRecent, 4, 200),
    summaryMaxChars: clampInt(src.rolloverSummaryMaxChars, DEFAULT_ROLLOVER.summaryMaxChars, 120, 4000),
    minTurnsBeforeRoll: clampInt(src.rolloverMinTurns, DEFAULT_ROLLOVER.minTurnsBeforeRoll, 0, 1000),
    // 时间窗：默认 4:00–4:59；rolloverNightOnly=false 恢复旧的全天候行为。
    nightOnly: src.rolloverNightOnly === undefined ? DEFAULT_ROLLOVER.nightOnly : src.rolloverNightOnly !== false,
    nightStartHour: clampInt(src.rolloverNightStartHour, DEFAULT_ROLLOVER.nightStartHour, 0, 23),
    nightStartMinute: clampInt(src.rolloverNightStartMinute, DEFAULT_ROLLOVER.nightStartMinute, 0, 59),
    nightWindowMinutes: clampInt(src.rolloverNightWindowMinutes, DEFAULT_ROLLOVER.nightWindowMinutes, 0, 1440)
  };
}

/**
 * 现在是不是「允许主动压缩」的时间窗。
 *
 * 时间按**本机本地时间**算，支持跨午夜（例如 23:30 开始、90 分钟窗口）。
 * `nightWindowMinutes <= 0` 或 `nightOnly === false` 时视为全天允许。
 */
export function isRolloverWindow(now = Date.now(), config = DEFAULT_ROLLOVER) {
  const cfg = { ...DEFAULT_ROLLOVER, ...(config || {}) };
  if (cfg.nightOnly === false || cfg.nightWindowMinutes <= 0) return true;
  const at = new Date(Number(now) || Date.now());
  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = cfg.nightStartHour * 60 + cfg.nightStartMinute;
  const end = start + cfg.nightWindowMinutes;
  if (end <= 1440) return minutes >= start && minutes < end;
  return minutes >= start || minutes < (end - 1440);
}

/**
 * 该不该换会话。
 *
 * 两个阈值是"或"关系：谁先到都算。`tokens <= 0` / `turns <= 0` 表示该维度不启用，
 * 两个都关掉就等于完全不滚。
 *
 * `contextTokens` 是当前这一轮真正带入模型的上下文（不是会话累计账单）。
 * 保留 `usedTokens` 作为旧名兼容测试/调用方。
 *
 * 2026-11-16：`nightOnly` 是配置；纯函数默认 `enforceNightWindow=false` 保留旧阈值语义，
 * 桥接调用时显式传 `enforceNightWindow: true`。机器模式（每条唤醒一条干净会话）
 * 由调用方传 `enforceNightWindow: false`，不受时间窗限制。
 */
export function shouldRollSession({
  usedTokens = 0,
  contextTokens,
  turns = 0,
  config = DEFAULT_ROLLOVER,
  now = Date.now(),
  // 纯函数默认不卡时间窗，保持旧测试/旧调用方的阈值语义；
  // 桥接真正决定要不要滚时必须显式传 true（见 maybeRollSessionV2）。
  enforceNightWindow = false
} = {}) {
  const cfg = { ...DEFAULT_ROLLOVER, ...(config || {}) };
  if (cfg.enabled === false) return false;
  const used = Math.max(0, Math.round(Number(contextTokens ?? usedTokens) || 0));
  const count = Math.max(0, Math.round(Number(turns) || 0));
  if (count < cfg.minTurnsBeforeRoll) return false;
  if (enforceNightWindow && cfg.nightOnly !== false && !isRolloverWindow(now, cfg)) return false;
  const byTokens = cfg.tokens > 0 && used >= cfg.tokens;
  const byTurns = cfg.turns > 0 && count >= cfg.turns;
  return byTokens || byTurns;
}

/** 一条记忆消息压成一行：`谁：内容`，去掉换行、截断。 */
function oneLine(who, text, limit = 120) {
  const name = String(who ?? '').replace(/\s+/g, ' ').trim() || '某人';
  const body = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/【[^】]*】/g, '')
    .trim();
  if (!body) return '';
  const clipped = body.length > limit ? `${body.slice(0, limit)}…` : body;
  return `· ${name}：${clipped}`;
}

function compactText(value, limit = 120) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, limit));
}

/** 只挑「答应过 / 明天要接」的句子，不把整段聊天搬过去。 */
function looksLikePromise(text) {
  return /(答应|说好|明天|下次|回头|等会儿|晚点|记得|别忘了|改天|到时候|我来|我给你|我帮你|我会|等我|还没|没做完|没弄完|卡住|欠)/.test(String(text ?? ''));
}

/** 她自己说过的、带情绪/关系温度的话；折的时候优先留原话，不压成转述。 */
function looksEmotional(text) {
  return /(喜欢|讨厌|难过|开心|高兴|委屈|害怕|担心|心疼|想你|想我|想念|爱你|爱我|生气|哭|舍不得|孤独|温柔|心软|失落|踏实|安心|难受|感动|在意|在乎|吃醋|撒娇|偏心|不安|紧张|放心|抱抱|抱一下|亲亲|亲一下|离不开|不想你走|别走|累了|疲惫|情绪|感情)/.test(String(text ?? ''));
}

/** 会话里还挂着的主题（模型自己记的 activeTopics），优先带 pendingQuestion。 */
function topicLines(topics, limit = 4) {
  const out = [];
  for (const item of Array.isArray(topics) ? topics : []) {
    const text = compactText(item && typeof item === 'object' ? (item.text ?? item.content) : item, 120);
    if (!text) continue;
    const pending = compactText(item?.pendingQuestion, 80);
    out.push(`· ${text}${pending ? `（还欠：${pending}）` : ''}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** 模型记下但还没说出口的话；这条最容易在换会话时丢。 */
function pendingLines(items, limit = 4) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = compactText(item && typeof item === 'object' ? (item.text ?? item.content) : item, 120);
    if (!text) continue;
    const why = compactText(item?.motivation, 60);
    out.push(`· ${text}${why ? `（因为：${why}）` : ''}`);
    if (out.length >= limit) break;
  }
  return out;
}

const HANDOFF_FOOTER = '接着聊就行；不要提"换过会话"这件事，也不用重新自我介绍。';

/**
 * 睡前主要记忆：像睡觉前把明天该记得的几件事收在一起。
 *
 * 规则拼、不额外花模型调用：
 *   1. 刚才收在（closure 的收尾）
 *   2. 还挂着的话题（activeTopics）
 *   3. 我说过的、带情绪的话（保留原话，避免折完只剩冷冰冰的摘要）
 *   4. 我答应过 / 要接的事（从双方消息里挑「答应、明天、下次…」）
 *   5. 还没说出口的话（pendingThoughts）
 *   6. 下次怎么接（closure.nextOpening）
 *   7. 最近几句（双方都留，含她自己说过的话）
 *
 * 这不是完整摘要，只保「醒来后要接住」的那部分；长期记忆仍由记忆卡负责。
 */
export function buildBedtimeMemoryBlock({
  recent = [],
  closure = '',
  nextOpening = '',
  topics = [],
  pendingThoughts = [],
  config = DEFAULT_ROLLOVER,
  now = Date.now()
} = {}) {
  const cfg = { ...DEFAULT_ROLLOVER, ...(config || {}) };
  const list = Array.isArray(recent) ? recent.slice(-cfg.keepRecent) : [];
  const said = compactText(closure, Math.max(60, Math.floor(cfg.summaryMaxChars / 4)));
  const next = compactText(nextOpening, Math.max(60, Math.floor(cfg.summaryMaxChars / 8)));
  const topicOut = topicLines(topics, 4);
  const pendingOut = pendingLines(pendingThoughts, 4);
  const lines = [];
  const promises = [];
  const emotionalSelf = [];
  const unique = (arr) => [...new Set(arr)];
  for (const msg of list) {
    if (!msg) continue;
    const body = String(msg.plain ?? msg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const sender = String(msg.who ?? msg.name ?? msg.sender ?? '').trim();
    const who = msg.isSelf === true
      ? '我'
      : msg.isOwner === true
        ? '主人'
        : (sender === '私聊' ? '对方' : sender);
    const line = oneLine(who, body, 120);
    if (!line) continue;
    lines.push(line);
    if (looksLikePromise(body)) promises.push(line);
    if (msg.isSelf === true && looksEmotional(body)) emotionalSelf.push(line);
  }
  const promiseLines = unique(promises).slice(-12);
  const emotionalLines = unique(emotionalSelf).slice(-10);
  const recentLines = lines.slice(-20);
  // 没有任何对方/自己的话，也没有收尾/话题 → 不生成空交接。
  if (!said && !next && topicOut.length === 0 && pendingOut.length === 0 && recentLines.length === 0) return '';
  const at = new Date(Number(now) || Date.now());
  const clock = `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

  const out = [
    '【睡前记忆 · 会话交接】上一段聊太长了，已经换了一段新的接上。',
    `（收在 ${clock}；只带该记得的，不搬整段聊天。）`
  ];
  if (said) out.push('【刚才在聊】', `刚才收在：${said}`);
  if (emotionalLines.length) out.push('【我说过的、带情绪的话】', ...emotionalLines);
  if (topicOut.length) out.push('【还挂着的话题】', ...topicOut);
  if (promiseLines.length) out.push('【我答应过 / 还没做完的事】', ...promiseLines);
  if (pendingOut.length) out.push('【还没说出口的】', ...pendingOut);
  if (next) out.push('【下次接】', next);
  if (recentLines.length) out.push('【最近几句（含我自己说的）】', ...recentLines);
  out.push(HANDOFF_FOOTER);
  return out.join('\n');
}

/** 超字数时优先砍中间原话，保留标题和结尾“别提前进换过会话”。 */
function trimHandoffBlock(block, maxChars) {
  const max = Math.max(120, Math.round(Number(maxChars) || 0));
  if (block.length <= max) return block;
  const footer = `\n${HANDOFF_FOOTER}`;
  if (max <= footer.length + 8) return `${block.slice(0, max - 1)}…`;
  return `${block.slice(0, max - footer.length - 1).trimEnd()}…${footer}`;
}

/**
 * 生成"交接块"：下一段会话第一屏会看到它。
 *
 * 为什么需要它：换会话会丢掉**对话流**（不是记忆——记忆卡每轮都注入）。
 * 所以交接只需要说清"刚才在聊什么、聊到哪、答应过什么、下次怎么接"，不需要复述全部历史。
 * 这里刻意用规则拼（不额外花一次模型调用），并且明确要求"别提前进换过会话"。
 */
export function buildHandoffBlock({
  key = '',
  recent = [],
  closure = '',
  nextOpening = '',
  topics = [],
  pendingThoughts = [],
  now = Date.now(),
  config = DEFAULT_ROLLOVER
} = {}) {
  const cfg = { ...DEFAULT_ROLLOVER, ...(config || {}) };
  const block = buildBedtimeMemoryBlock({ recent, closure, nextOpening, topics, pendingThoughts, config: cfg, now });
  if (!block) return '';
  return trimHandoffBlock(block, cfg.summaryMaxChars);
}

/** 交接块是不是"有内容"（没有对话也没有收尾时就不必注入）。 */
export function handoffIsUseful(block) {
  const text = String(block ?? '').trim();
  if (!text) return false;
  return /最近几句|刚才收在|我答应过|睡前记忆|还挂着|下次接|还没说出口|带情绪/.test(text);
}
