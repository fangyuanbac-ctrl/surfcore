// tools/lib/prompt-policy.mjs —— 提示词策略单一事实源（2026-11-12，报告 §104）
//
// 背景：提示词里散落写死的数字（收藏 3 条 / 鱼赞 6 个 / 总结 4 条…）会和配置漂移：
//   配置改了、提示词没改，她就照着旧数字做；两套提示词各写一份更容易对不上。
// 原则：**数字只在这里取一次**，来源优先级 = 配置文件 → 本模块默认值。
//   scheduler.js / bridge.js 的提示词用 `${P.xxx}` 插值，不再出现字面量。
// 注意：这里只放"可配置的策略数字"；语气、规则编号、行为措辞不在这里。

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
