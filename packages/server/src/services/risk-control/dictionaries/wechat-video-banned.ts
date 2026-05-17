/**
 * 5-20 P2 — 视频号特有禁词。
 *
 * 视频号属微信生态, 多数继承 wechat 规则; 这里只加视频号专有红线。
 */
export const WECHAT_VIDEO_BANNED: readonly string[] = [
  // 视频号专有（导流到外部视频平台）
  "抖音",
  "B 站",
  "B站",
  "快手",
  "小红书",
  // 直播带货专属红线
  "点击直播间",
  "私域成交",
  // 大部分跟 wechat 共用，由 dict index 合并
];
