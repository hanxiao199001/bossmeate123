import { SkillRegistry } from "./skill-registry.js";
import { ArticleSkill } from "./article-skill.js";
import { VideoSkill } from "./video-skill.js";
import { getProvider } from "../ai/provider-factory.js";

/**
 * 初始化并注册所有内置技能
 * 在 server 启动时调用一次
 */
export function initializeSkills(): void {
  const defaultProvider = getProvider("expensive") || getProvider("cheap");

  if (defaultProvider) {
    SkillRegistry.register(new ArticleSkill(defaultProvider));
    SkillRegistry.register(new VideoSkill(defaultProvider));
  }

  console.log(`${SkillRegistry.list().length} skills initialized`);
}

export { SkillRegistry } from "./skill-registry.js";
export type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
