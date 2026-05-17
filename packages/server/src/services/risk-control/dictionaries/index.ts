/**
 * 5-20 P2 — 风控字典统一入口。
 * getDictForPlatform(p) = common ∪ platform-specific (wechat_video 还 ∪ wechat 共用底线)。
 */
import { COMMON_BANNED } from "./common-banned.js";
import { WECHAT_BANNED } from "./wechat-banned.js";
import { DOUYIN_BANNED } from "./douyin-banned.js";
import { WECHAT_VIDEO_BANNED } from "./wechat-video-banned.js";

export function getDictForPlatform(platform: string): string[] {
  const dict = new Set<string>(COMMON_BANNED);
  switch (platform) {
    case "wechat":
      WECHAT_BANNED.forEach((w) => dict.add(w));
      break;
    case "douyin":
      DOUYIN_BANNED.forEach((w) => dict.add(w));
      break;
    case "wechat_video":
      // 视频号继承 wechat 的营销/导流红线 + 自身专有
      WECHAT_BANNED.forEach((w) => dict.add(w));
      WECHAT_VIDEO_BANNED.forEach((w) => dict.add(w));
      break;
    default:
      // 未知平台只走通用底线（不爆炸）
      break;
  }
  return [...dict];
}
