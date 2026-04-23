/**
 * 视频脚本 Skill - 针对短视频内容创作的专门技能
 *
 * 流程：
 * 需求理解 → 数据检索 → 脚本大纲 → 脚本生成 → 质检 → 发布
 */

import { logger } from "../../config/logger.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";

interface VideoScriptOutline {
  title: string;
  duration: number; // 秒
  scenes: SceneOutline[];
  voiceover: string;
}

interface SceneOutline {
  sceneNumber: number;
  duration: number;
  description: string;
  voiceoverText: string;
  visualElements: string[];
}

interface GeneratedVideoScript {
  title: string;
  duration: number;
  scenes: SceneOutline[];
  fullScript: string;
  summary: string;
  tags: string[];
}

export class VideoSkill implements ISkill {
  readonly name = "video";
  readonly displayName = "视频脚本创作";
  readonly description = "为短视频平台（抖音、B站等）创作脚本和分镜";
  readonly preferredTier = "expensive" as const;

  constructor(private provider: AIProvider) {}

  async handle(
    userInput: string,
    history: ChatMessage[],
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info(
      { conversationId: context.conversationId, input: userInput.substring(0, 100) },
      "VideoSkill: 开始处理"
    );

    try {
      // Step 1: 解析用户需求
      const requirement = await this.parseRequirement(userInput, history, context);
      logger.info({ requirement }, "VideoSkill: 需求解析完成");

      // Step 2: 生成脚本大纲
      const outline = await this.generateOutline(requirement, context);
      logger.info({ outline }, "VideoSkill: 脚本大纲生成完成");

      // Step 3: 生成完整脚本
      const script = await this.generateScript(outline, requirement, context);
      logger.info({ scriptLength: script.fullScript.length }, "VideoSkill: 脚本生成完成");

      // Step 4: 质量检查
      const summary = await this.generateSummary(script, context);

      const reply = `
✅ 视频脚本创作完成！

**标题**: ${script.title}
**时长**: 约 ${script.duration} 秒
**场景数**: ${script.scenes.length} 场

**脚本概述**:
${summary}

脚本已保存为草稿，您可以继续编辑或直接发布到视频平台。
`;

      return {
        reply,
        artifact: {
          type: "video_script",
          title: script.title,
          body: script.fullScript,
          summary: summary,
          tags: script.tags,
          metadata: {
            duration: script.duration,
            sceneCount: script.scenes.length,
            generatedAt: new Date().toISOString(),
          },
        },
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          model: this.provider.name,
        },
      };
    } catch (err) {
      logger.error({ err, conversationId: context.conversationId }, "VideoSkill: 处理失败");
      throw err;
    }
  }

  private async parseRequirement(
    userInput: string,
    history: ChatMessage[],
    context: SkillContext
  ): Promise<{ topic: string; platforms: string[]; style: string; duration: number }> {
    const response = await this.provider.chat({
      messages: [
        {
          role: "system",
          content: `你是短视频脚本专家。分析用户需求，输出纯JSON（不要markdown），格式：
{"topic":"主题","platforms":["douyin"],"style":"educational","duration":25}
- duration 必须在 15-30 秒之间
- 不要输出任何除JSON之外的文字`,
        },
        ...history,
        { role: "user", content: userInput },
      ],
      maxTokens: 1024,
    });

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // 如果解析失败，返回默认值
    }

    return {
      topic: userInput.substring(0, 100),
      platforms: ["bilibili"],
      style: "educational",
      duration: 30,
    };
  }

  private async generateOutline(
    requirement: { topic: string; platforms: string[]; style: string; duration: number },
    context: SkillContext
  ): Promise<VideoScriptOutline> {
    // 强制 15-30 秒
    const targetDuration = Math.min(30, Math.max(15, requirement.duration));
    const response = await this.provider.chat({
      messages: [
        {
          role: "system",
          content: `你是短视频编导。生成一个纯JSON视频分镜大纲，不要任何markdown标记，不要代码块。

输出格式（纯JSON，直接以{开头）：
{
  "title": "中文标题",
  "duration": ${targetDuration},
  "scenes": [
    {
      "sceneNumber": 1,
      "duration": 5,
      "description": "画面描述（中文）",
      "voiceoverText": "口播文案（中文）",
      "visualElements": ["english keyword1", "english keyword2"]
    }
  ]
}

严格要求：
- 总时长=${targetDuration}秒，4-6个场景，每个场景3-6秒
- visualElements 必须是英文单词（用于 Pexels 素材搜索）
- 不要输出任何除JSON之外的文字`,
        },
        {
          role: "user",
          content: `主题: ${requirement.topic}\n风格: ${requirement.style}\n时长: ${targetDuration}秒`,
        },
      ],
      maxTokens: 2048,
    });

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // 返回默认大纲
    }

    return {
      title: requirement.topic,
      duration: requirement.duration,
      voiceover: "default",
      scenes: [
        {
          sceneNumber: 1,
          duration: requirement.duration,
          description: "开场",
          voiceoverText: "大家好，我是创作者",
          visualElements: ["标题卡", "背景"],
        },
      ],
    };
  }

  private async generateScript(
    outline: VideoScriptOutline,
    requirement: { topic: string },
    _context: SkillContext
  ): Promise<GeneratedVideoScript> {
    // 直接用 outline 的结构化数据，不再调一次 LLM 生成 prose
    // body 输出为纯 JSON，让 chat.ts 可以解析并触发视频合成
    const scriptJson = {
      title: outline.title,
      duration: outline.duration,
      scenes: outline.scenes.map((s) => ({
        sceneNumber: s.sceneNumber,
        duration: s.duration,
        description: s.description,
        voiceoverText: s.voiceoverText,
        keywords: s.visualElements || [],
      })),
    };

    return {
      title: outline.title,
      duration: outline.duration,
      scenes: outline.scenes,
      fullScript: JSON.stringify(scriptJson), // 纯 JSON，不含 markdown
      summary: `一部${outline.duration}秒的${requirement.topic}主题视频脚本，包含${outline.scenes.length}个场景。`,
      tags: ["视频脚本", "短视频", requirement.topic.substring(0, 20)],
    };
  }

  private async generateSummary(script: GeneratedVideoScript, context: SkillContext): Promise<string> {
    const response = await this.provider.chat({
      messages: [
        {
          role: "system",
          content: "用1-2句话总结以下视频脚本的核心内容和亮点。",
        },
        {
          role: "user",
          content: script.fullScript.substring(0, 500),
        },
      ],
      maxTokens: 256,
    });

    return response.content;
  }
}
