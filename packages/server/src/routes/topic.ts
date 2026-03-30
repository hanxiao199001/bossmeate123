/**
 * 选题工坊 API
 *
 * 对齐詹金晶工作流：选刊 → 找噱头 → 出标题 → 写文章
 */

import type { FastifyInstance } from "fastify";
import { db } from "../models/db.js";
import { journals, contents } from "../models/schema.js";
import { eq, and } from "drizzle-orm";
import { findHooks, generateTitles, generateArticle } from "../services/skills/topic-skill.js";
import { logger } from "../config/logger.js";

export async function topicRoutes(app: FastifyInstance) {
  // ============ Step 2: 为选定期刊找噱头 ============
  app.post("/topic/hooks", async (request, reply) => {
    const { journalId } = request.body as { journalId: string };
    const tenantId = (request as any).tenantId;

    if (!journalId) {
      return reply.status(400).send({ code: "BAD_REQUEST", message: "请选择一本期刊" });
    }

    // 查找期刊
    const result = await db
      .select()
      .from(journals)
      .where(and(eq(journals.id, journalId), eq(journals.tenantId, tenantId)))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "期刊不存在" });
    }

    const journal = result[0];

    logger.info({ journalName: journal.name }, "🎯 选题工坊：为期刊找噱头");

    const hooks = await findHooks({
      name: journal.name,
      nameEn: journal.nameEn || undefined,
      discipline: journal.discipline || undefined,
      partition: journal.partition || undefined,
      impactFactor: journal.impactFactor || undefined,
      acceptanceRate: journal.acceptanceRate || undefined,
      reviewCycle: journal.reviewCycle || undefined,
      isWarningList: journal.isWarningList,
      warningYear: journal.warningYear || undefined,
    });

    return reply.send({
      code: "ok",
      data: {
        journal: {
          id: journal.id,
          name: journal.name,
          nameEn: journal.nameEn,
          partition: journal.partition,
          impactFactor: journal.impactFactor,
          isWarningList: journal.isWarningList,
        },
        ...hooks,
      },
    });
  });

  // ============ Step 3: 基于期刊+噱头生成标题 ============
  app.post("/topic/titles", async (request, reply) => {
    const { journalId, hookAngle } = request.body as {
      journalId: string;
      hookAngle: string;
    };
    const tenantId = (request as any).tenantId;

    if (!journalId || !hookAngle) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "请选择期刊和噱头角度",
      });
    }

    const result = await db
      .select()
      .from(journals)
      .where(and(eq(journals.id, journalId), eq(journals.tenantId, tenantId)))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "期刊不存在" });
    }

    const journal = result[0];

    logger.info({ journalName: journal.name, hookAngle }, "🎯 选题工坊：生成标题");

    const titles = await generateTitles(
      {
        name: journal.name,
        nameEn: journal.nameEn || undefined,
        discipline: journal.discipline || undefined,
        partition: journal.partition || undefined,
        impactFactor: journal.impactFactor || undefined,
      },
      hookAngle
    );

    return reply.send({
      code: "ok",
      data: {
        journal: { id: journal.id, name: journal.name },
        hookAngle,
        ...titles,
      },
    });
  });

  // ============ Step 4: 基于选定标题写完整文章 ============
  app.post("/topic/article", async (request, reply) => {
    const { journalId, title, hookAngle } = request.body as {
      journalId: string;
      title: string;
      hookAngle: string;
    };
    const tenantId = (request as any).tenantId;
    const userId = (request as any).userId;

    if (!journalId || !title) {
      return reply.status(400).send({
        code: "BAD_REQUEST",
        message: "请选择期刊和标题",
      });
    }

    const result = await db
      .select()
      .from(journals)
      .where(and(eq(journals.id, journalId), eq(journals.tenantId, tenantId)))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "期刊不存在" });
    }

    const journal = result[0];

    logger.info({ journalName: journal.name, title }, "🎯 选题工坊：生成文章");

    const article = await generateArticle(
      {
        name: journal.name,
        nameEn: journal.nameEn || undefined,
        discipline: journal.discipline || undefined,
        partition: journal.partition || undefined,
        impactFactor: journal.impactFactor || undefined,
        acceptanceRate: journal.acceptanceRate || undefined,
        reviewCycle: journal.reviewCycle || undefined,
        isWarningList: journal.isWarningList,
        warningYear: journal.warningYear || undefined,
      },
      title,
      hookAngle || ""
    );

    // 保存到内容库
    const [saved] = await db
      .insert(contents)
      .values({
        tenantId,
        userId,
        type: "article",
        title: article.title,
        body: article.content,
        status: "draft",
        metadata: {
          journalId: journal.id,
          journalName: journal.name,
          hookAngle,
          seoKeywords: article.seoKeywords,
          wordCount: article.wordCount,
          generatedAt: new Date().toISOString(),
        },
      })
      .returning();

    return reply.send({
      code: "ok",
      data: {
        contentId: saved.id,
        ...article,
      },
    });
  });
}
