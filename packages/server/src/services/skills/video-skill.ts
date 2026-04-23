/**
 * 视频脚本 Skill - 期刊科普短视频 + 通用主题短视频
 *
 * 两条路径：
 *  - 识别到期刊：基于 journals 表数据生成确定性 5 场景脚本（封面卡片 + 信息字幕）
 *  - 未识别期刊：走 AI 生成通用主题脚本（兼容老行为）
 */

import { and, eq, ilike, or } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { db } from "../../models/db.js";
import { journals } from "../../models/schema.js";
import type { AIProvider, ChatMessage } from "../ai/providers/base.js";
import type { ISkill, SkillContext, SkillResult } from "./base-skill.js";

interface SceneOutline {
  sceneNumber: number;
  duration: number;
  description: string;
  voiceoverText: string;
  visualElements: string[];
  sceneType?: string;
}

interface VideoScriptOutline {
  title: string;
  duration: number;
  scenes: SceneOutline[];
  voiceover: string;
}

interface GeneratedVideoScript {
  title: string;
  duration: number;
  scenes: SceneOutline[];
  fullScript: string;
  summary: string;
  tags: string[];
}

interface JournalRow {
  id: string;
  name: string;
  nameEn: string | null;
  impactFactor: number | null;
  partition: string | null;
  casPartition: string | null;
  casPartitionNew: string | null;
  reviewCycle: string | null;
  acceptanceRate: number | null;
  selfCitationRate: number | null;
  citeScore: number | null;
  jcrSubjects: string | null;
  scopeDescription: string | null;
  discipline: string | null;
  publisher: string | null;
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
      // 优先识别期刊：明确指定 > 用户输入中匹配
      const journal = await this.resolveJournal(userInput, context);

      if (journal) {
        logger.info({ journalId: journal.id, name: journal.name }, "VideoSkill: 走期刊科普模板");
        return this.buildJournalVideoResult(journal);
      }

      // 未识别期刊：走 AI 生成通用主题脚本
      const requirement = await this.parseRequirement(userInput, history, context);
      const outline = await this.generateOutline(requirement, context);
      const script = await this.generateScript(outline, requirement);
      const summary = await this.generateSummary(script);

      const reply = `✅ 视频脚本创作完成！

**标题**: ${script.title}
**时长**: 约 ${script.duration} 秒
**场景数**: ${script.scenes.length} 场

**脚本概述**:
${summary}

脚本已保存为草稿，您可以继续编辑或直接发布到视频平台。`;

      return {
        reply,
        artifact: {
          type: "video_script",
          title: script.title,
          body: script.fullScript,
          summary,
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

  /** 期刊解析：metadata.journalId > 文本模糊匹配 */
  private async resolveJournal(
    userInput: string,
    context: SkillContext
  ): Promise<JournalRow | null> {
    const meta = context.metadata || {};
    const journalIdFromMeta = typeof meta.journalId === "string" ? meta.journalId : undefined;

    if (journalIdFromMeta) {
      const [row] = await db
        .select(JOURNAL_SELECT)
        .from(journals)
        .where(and(eq(journals.id, journalIdFromMeta), eq(journals.tenantId, context.tenantId)))
        .limit(1);
      if (row) return row;
    }

    // 文本匹配：name 或 nameEn 或 abbreviation 含关键词
    const trimmed = userInput.trim();
    if (trimmed.length < 2) return null;

    try {
      const rows = await db
        .select(JOURNAL_SELECT)
        .from(journals)
        .where(
          and(
            eq(journals.tenantId, context.tenantId),
            or(
              ilike(journals.name, `%${trimmed}%`),
              ilike(journals.nameEn, `%${trimmed}%`),
            )!
          )
        )
        .limit(5);
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) {
        // 多命中：挑 IF 最高（大概率是用户想说的）
        return rows.sort((a, b) => (b.impactFactor ?? 0) - (a.impactFactor ?? 0))[0];
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "期刊模糊匹配失败");
    }
    return null;
  }

  /** 基于期刊数据构建确定性 6 场景脚本（V2：卡片式科普） */
  private buildJournalVideoResult(journal: JournalRow): SkillResult {
    const displayName = journal.name;
    const ifStr = journal.impactFactor != null ? journal.impactFactor.toFixed(3) : null;
    const partitionStr = journal.casPartition || journal.partition || null;
    const reviewCycle = journal.reviewCycle || null;
    const acceptance = formatAcceptancePct(journal.acceptanceRate);
    const discipline = journal.discipline || "学术";

    // 6 个场景：封面介绍 → 核心数据 → 审稿效率 → 研究方向 → 投稿技巧 → 关注引导
    const scenes: SceneOutline[] = [];
    let seq = 1;

    // Scene 1: opening
    scenes.push({
      sceneNumber: seq++,
      duration: 4,
      sceneType: "opening",
      description: `${displayName} · ${discipline}领域期刊速览`,
      voiceoverText: `今天给大家介绍一本${discipline}领域的期刊：${displayName}。`,
      visualElements: [discipline, "journal"],
    });

    // Scene 2: data
    const dataBits: string[] = [];
    if (ifStr) dataBits.push(`影响因子 ${ifStr}`);
    if (partitionStr) dataBits.push(partitionStr);
    if (journal.publisher) dataBits.push(`${journal.publisher} 出版`);
    scenes.push({
      sceneNumber: seq++,
      duration: 5,
      sceneType: "data",
      description: dataBits.join(" · ") || "核心数据",
      voiceoverText: dataBits.length
        ? `核心数据：${dataBits.join("，")}。`
        : `该期刊在本领域有一定影响力。`,
      visualElements: ["research", "data"],
    });

    // Scene 3: review
    const reviewBits: string[] = [];
    if (reviewCycle) reviewBits.push(`审稿周期约 ${reviewCycle}`);
    if (acceptance) reviewBits.push(`录用率 ${acceptance}`);
    scenes.push({
      sceneNumber: seq++,
      duration: 5,
      sceneType: "review",
      description: reviewBits.join(" · ") || "审稿效率",
      voiceoverText: reviewBits.length
        ? `投稿效率：${reviewBits.join("，")}。`
        : `投稿效率请参考官网最新数据。`,
      visualElements: ["review", "academic"],
    });

    // Scene 4: topic
    const scopeVo = journal.scopeDescription
      ? `收稿范围：${journal.scopeDescription.slice(0, 60)}……`
      : `${displayName} 专注于${discipline}领域的原创研究，欢迎相关方向投稿。`;
    scenes.push({
      sceneNumber: seq++,
      duration: 5,
      sceneType: "topic",
      description: "研究方向 · 收稿范围",
      voiceoverText: scopeVo,
      visualElements: [discipline, "research scope"],
    });

    // Scene 5: tips
    scenes.push({
      sceneNumber: seq++,
      duration: 5,
      sceneType: "tips",
      description: "投稿技巧 · 四大要点",
      voiceoverText: `投稿${displayName}，建议：选题贴合收稿范围，图表规范清晰，参考文献格式严谨，投前做好语言润色。`,
      visualElements: ["writing", "tips"],
    });

    // Scene 6: cta
    scenes.push({
      sceneNumber: seq++,
      duration: 3,
      sceneType: "cta",
      description: "关注引导 · 私信咨询",
      voiceoverText: `想了解更多期刊分析，关注主页，私信可咨询具体投稿方案。`,
      visualElements: ["follow", "subscribe"],
    });

    const totalDuration = scenes.reduce((s, x) => s + x.duration, 0);
    const title = `${displayName} 期刊速览${ifStr ? ` · IF ${ifStr}` : ""}`;

    const scriptJson = {
      title,
      duration: totalDuration,
      journalId: journal.id,
      scenes: scenes.map((s) => ({
        sceneNumber: s.sceneNumber,
        duration: s.duration,
        sceneType: s.sceneType,
        description: s.description,
        voiceoverText: s.voiceoverText,
        keywords: s.visualElements,
      })),
    };

    const summary = [
      `《${displayName}》科普短视频`,
      ifStr ? `IF ${ifStr}` : null,
      partitionStr,
      reviewCycle ? `审稿 ${reviewCycle}` : null,
      acceptance ? `录用率 ${acceptance}` : null,
    ].filter(Boolean).join(" · ");

    const reply = `✅ 已为《${displayName}》生成期刊科普短视频脚本

**时长**: ${totalDuration} 秒 · ${scenes.length} 个场景
**素材**: 使用期刊封面 + 信息卡字幕（IF / 分区 / 审稿周期 / 录用率）

脚本已入队合成，完成后会出现在草稿列表。`;

    return {
      reply,
      artifact: {
        type: "video_script",
        title,
        body: JSON.stringify(scriptJson),
        summary,
        tags: ["期刊科普", "短视频", discipline, displayName.slice(0, 20)],
        metadata: {
          duration: totalDuration,
          sceneCount: scenes.length,
          journalId: journal.id,
          generatedAt: new Date().toISOString(),
        },
      },
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        model: "deterministic-template",
      },
    };
  }

  // ============ 通用主题脚本（非期刊路径） ============

  private async parseRequirement(
    userInput: string,
    history: ChatMessage[],
    _context: SkillContext
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
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}
    return {
      topic: userInput.substring(0, 100),
      platforms: ["bilibili"],
      style: "educational",
      duration: 25,
    };
  }

  private async generateOutline(
    requirement: { topic: string; platforms: string[]; style: string; duration: number },
    _context: SkillContext
  ): Promise<VideoScriptOutline> {
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
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}

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
  ): Promise<GeneratedVideoScript> {
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
      fullScript: JSON.stringify(scriptJson),
      summary: `一部${outline.duration}秒的${requirement.topic}主题视频脚本，包含${outline.scenes.length}个场景。`,
      tags: ["视频脚本", "短视频", requirement.topic.substring(0, 20)],
    };
  }

  private async generateSummary(script: GeneratedVideoScript): Promise<string> {
    const response = await this.provider.chat({
      messages: [
        { role: "system", content: "用1-2句话总结以下视频脚本的核心内容和亮点。" },
        { role: "user", content: script.fullScript.substring(0, 500) },
      ],
      maxTokens: 256,
    });
    return response.content;
  }
}

// ============ 辅助 ============

const JOURNAL_SELECT = {
  id: journals.id,
  name: journals.name,
  nameEn: journals.nameEn,
  impactFactor: journals.impactFactor,
  partition: journals.partition,
  casPartition: journals.casPartition,
  casPartitionNew: journals.casPartitionNew,
  reviewCycle: journals.reviewCycle,
  acceptanceRate: journals.acceptanceRate,
  selfCitationRate: journals.selfCitationRate,
  citeScore: journals.citeScore,
  jcrSubjects: journals.jcrSubjects,
  scopeDescription: journals.scopeDescription,
  discipline: journals.discipline,
  publisher: journals.publisher,
} as const;

function formatAcceptancePct(rate: number | null | undefined): string | null {
  if (rate == null || Number.isNaN(rate)) return null;
  const pct = rate > 1 ? rate : rate * 100;
  return `${pct.toFixed(1)}%`;
}
