/**
 * 5-20 P2 — 风控字典统一入口。
 * getDictForPlatform(p) = common ∪ 该平台在 PLATFORM_CAPABILITIES.riskDictionaries 里声明的词库。
 *
 * 7-28 阶段1-B: 原本是一个手写 switch —— "视频号也吃公众号词库" 这条业务规则只活在 case 分支里,
 * 谁也不知道还有哪里也依赖同一条规则。现在归属关系是 capabilities 表的一个字段(riskDictionaries),
 * 加平台/改归属都不用动本文件。
 */
import { COMMON_BANNED } from "./common-banned.js";
import { WECHAT_BANNED } from "./wechat-banned.js";
import { DOUYIN_BANNED } from "./douyin-banned.js";
import { WECHAT_VIDEO_BANNED } from "./wechat-video-banned.js";
import { getPlatformCapability } from "../../platforms/capabilities.js";

/** 词库 key → 词表。key 与 capabilities.riskDictionaries 的取值一一对应。 */
const DICTIONARIES: Record<string, readonly string[]> = {
  wechat: WECHAT_BANNED,
  douyin: DOUYIN_BANNED,
  wechat_video: WECHAT_VIDEO_BANNED,
};

export function getDictForPlatform(platform: string): string[] {
  const dict = new Set<string>(COMMON_BANNED);
  // 未知平台 / 未声明专有词库的平台 → 只走通用底线（不爆炸）
  for (const key of getPlatformCapability(platform)?.riskDictionaries ?? []) {
    for (const w of DICTIONARIES[key] ?? []) dict.add(w);
  }
  return [...dict];
}
