/**
 * DVH (Aliyun digital human video) module entry.
 * Public API:
 *   - triggerDvhFromArticle — fire-and-forget bridge, 文章 → 视频
 *   - triggerDvhFromText    — 7-30 fire-and-forget bridge, 运营手写口播稿 → 视频(不经文章)
 *   两条链路共用 produce-video.ts 里的合成重活。
 */
export { triggerDvhFromArticle, type DvhBridgeOptions } from "./article-bridge.js";
export {
  triggerDvhFromText,
  buildDvhTextSlotKeys,
  acquireDvhTextSlots,
  releaseDvhTextSlots,
  narrationFingerprint,
  type DvhTextBridgeOptions,
} from "./text-bridge.js";
export { checkNarrationSafety, checkNarrationSafetyPure, type NarrationSafetyResult } from "./narration-guard.js";
export { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId, type AvatarVoiceMapping } from "./template-mapping.js";
export { isRealMode } from "./client.js";
