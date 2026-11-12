// tools/lib/prompt-policy.mjs —— 提示词策略单一事实源（2026-11-12，报告 §104）
//
// 背景：提示词里散落写死的数字（收藏 3 条 / 鱼赞 6 个 / 总结 4 条…）会和配置漂移：
//   配置改了、提示词没改，她就照着旧数字做；两套提示词各写一份更容易对不上。
// 原则：**数字只在这里取一次**，来源优先级 = 配置文件 → 本模块默认值。
//   scheduler.js / bridge.js 的提示词用 `${P.xxx}` 插值，不再出现字面量。
// 注意：这里只放"可配置的策略数字"；语气、规则编号、行为措辞不在这里。

/**
 * 展示性/文案常量（2026-11-12 报告 §105）：
 * 这些数字既出现在提示词里、也出现在脚本闸门里（评论长度、陌生人私信上限），
 * 以前两边各写一份 → 提示词说「一天共 12 条」、dm.mjs 实际是 30 条，她照着旧数字说。
 * 现在统一从这里取：提示词用 ${P.xxx}，comment.mjs / dm.mjs 直接 import displayPolicy。
 */
export const displayPolicy = {
  // 说话长度（气质建议，脚本不拦）
  replyCharsMin: 8,
  replyCharsMax: 30,
  // 公开评论硬上限（comment.mjs）
  publicCommentMaxChars: 40,
  shareCommentMaxChars: 120,
  // 看片总结私信（主人）：气质建议
  dmShareCharsMin: 20,
  dmShareCharsMax: 80,
  // 回复陌生人私信（dm.mjs --to 的硬闸）
  dmReplyMaxChars: 200,
  dmReplyPerPersonDaily: 3,
  dmReplyDaily: 30,
  // 收藏判据（fav.mjs 硬闸）
  favReasonMinChars: 6,
  favRepeatDays: 30,
  // 分享（--share）同一视频判重窗口
  shareRepeatDays: 7,
}

/** 从 B站 配置（bili.config.json）算出提示词要用的策略数字。 */
export function biliPolicy(cfg = {}) {
  const limits = cfg.limits ?? {}
  const engage = cfg.engage ?? {}
  const quota = cfg.quota ?? {}
  const fish = cfg.fishGuard ?? {}
  const dyn = cfg.dynamics ?? {}
  const kinds = dyn.kinds ?? {}

  // 四类动态（发私信的时段）：只统计 enabled 且有合法 slot 的类
  const slotLabel = { best: '早', game: '午', anime: '晚', gaming: '游戏' }
  const dmKinds = Object.entries(kinds)
    .filter(([, v]) => v && v.enabled !== false && Number.isFinite(Number(v.slot)))
    .sort((a, b) => Number(a[1].slot) - Number(b[1].slot))
  const dmSummaryDaily = dmKinds.length
  const dmSummaryLabels = dmKinds.map(([k, v]) => slotLabel[k] ?? `${v.slot}:00`).join('/')

  return {
    // 分享
    shareDaily: Number(quota.shareDaily ?? 3),
    /** 主人好几天没回应时，她自己决定「少说」的分享上限（不是被代码拦） */
    quietShareDaily: 1,
    // 收藏 / 互动
    favDaily: Number(engage.favDaily ?? 2),
    likeDaily: Number(engage.likeDaily ?? 8),
    coinDaily: Number(engage.coinDaily ?? 3),
    engageMinGapMin: Number(engage.minGapMin ?? 5),
    // 鱼群点赞（fish-guard）
    fishLikeDaily: Number(fish.maxLikesPerDay ?? 6),
    fishLikePerRun: Number(fish.maxLikesPerRun ?? 4),
    // 看片总结私信（四类动态）
    dmSummaryDaily,
    dmSummaryLabels,
    dmSlots: dmKinds.map(([, v]) => Number(v.slot)),
    // 额度（已由 limitsNow() 动态插值，这里只做兜底展示用）
    dailyComment: Number(limits.daily ?? 1),
    taDaily: Number(limits.taDaily ?? 2),
    replyDaily: Number(limits.replyDaily ?? 3),
    // 展示性常量（见 displayPolicy；脚本闸门与提示词共用同一份）
    ...displayPolicy,
  }
}

/** QQ 侧（桥接 config.json）策略数字。 */
export function qqPolicy(cfg = {}) {
  const tg = cfg?.socialV2?.tokenGuard ?? {}
  return {
    privateMaxOutboundPerTurn: Math.max(1, Number(tg.privateMaxOutboundPerTurn ?? 5)),
    groupMaxOutboundPerTurn: Math.max(1, Number(tg.maxOutboundPerTurn ?? 8)),
    maxCharsPerMessage: Math.max(50, Number(tg.maxCharsPerMessage ?? 500)),
  }
}
