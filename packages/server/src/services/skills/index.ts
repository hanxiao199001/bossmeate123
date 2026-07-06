import { SkillRegistry } from "./skill-registry.js";
import { ArticleSkill } from "./article-skill.js";
import { VideoSkill } from "./video-skill.js";
import { getProvider } from "../ai/provider-factory.js";
import { createRoutedProvider } from "../ai/routed-provider.js";

/**
 * 初始化并注册所有内置技能
 * 在 server 启动时调用一次
 */
export function initializeSkills(): void {
  // 保留原 gate: 无任何模型配置时不注册 → worker 侧 fail-fast "Skill not found",
  // 而不是注册一个永远只会道歉的假 provider
  const anyProvider = getProvider("expensive") || getProvider("cheap");

  if (anyProvider) {
    // 7-06 接入网关: 构造器注入 RoutedProvider(skills 唯一实际使用的 provider — context.provider 从未被读)。
    // 主链路自此获得 熔断/主备降级/重试/长超时/成本落库; 主路径模型不变(content_generation primary=deepseek-chat)。
    // 旧写法(直连 getProvider 固定实例)是"网关建好却被最大调用方绕过"的架构裂缝, 详见 routed-provider.ts 头注。
    SkillRegistry.register(new ArticleSkill(createRoutedProvider("article")));
    SkillRegistry.register(new VideoSkill(createRoutedProvider("video")));
  }

  console.log(`${SkillRegistry.list().length} skills initialized`);
}

export { SkillRegistry } from "./skill-registry.js";
export type { ISkill, SkillContext, SkillResult } from "./base-skill.js";
