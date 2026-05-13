/**
 * DVH (Aliyun digital human video) module entry.
 * Public API: triggerDvhFromArticle — fire-and-forget bridge for article pipeline.
 */
export { triggerDvhFromArticle, type DvhBridgeOptions } from "./article-bridge.js";
export { TEMPLATE_AVATAR_VOICE_MAP, type TemplateId, type AvatarVoiceMapping } from "./template-mapping.js";
export { isRealMode } from "./client.js";
