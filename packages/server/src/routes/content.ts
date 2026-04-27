import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, sql, count, or, isNull, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../models/db.js";
import { contents, productionRecords, bossEdits } from "../models/schema.js";
import { logger } from "../config/logger.js";

const createContentSchema = z.object({
  type: z.enum(["article", "video_script", "reply"]),
  title: z.string().optional(),
  body: z.string().optional(),
  conversationId: z.string().uuid().optional(),
});

const updateContentSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  status: z.enum(["draft", "reviewing", "approved", "published"]).optional(),
});

export async function contentRoutes(app: FastifyInstance) {
  /**
   * GET /content - 获取内容列表（支持筛选和分页）
   */
  app.get("/", async (request, reply) => {
    try {
      const query = request.query as {
        type?: string;
        status?: string;
        userId?: string;
        page?: string;
        pageSize?: string;
      };

      const page = Math.max(1, parseInt(query.page || "1", 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || "20", 10)));
      const offset = (page - 1) * pageSize;

      const conditions = [eq(contents.tenantId, request.tenantId)];

      // 如果指定了 userId 筛选，验证权限（owner/admin 可查看全部，其他用户只能查看自己的）
      if (query.userId) {
        const userRole = request.user.role as string;
        if (userRole !== "owner" && userRole !== "admin") {
          // 非管理员只能查看自己的内容
          if (query.userId !== request.user.userId) {
            return reply.code(403).send({
              code: "FORBIDDEN",
              message: "无权限查看其他用户的内容",
            });
          }
        }
        conditions.push(eq(contents.userId, query.userId));
      }

      if (query.type && ["article", "video_script", "reply"].includes(query.type)) {
        conditions.push(eq(contents.type, query.type));
      }

      if (query.status && ["draft", "reviewing", "approved", "published"].includes(query.status)) {
        conditions.push(eq(contents.status, query.status));
      }

      const whereClause = and(...conditions);

      const [list, totalResult] = await Promise.all([
        db
          .select()
          .from(contents)
          .where(whereClause)
          .orderBy(desc(contents.updatedAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ total: count() })
          .from(contents)
          .where(whereClause),
      ]);

      const total = totalResult[0]?.total || 0;

      // Note: userId in response indicates who created the content (createdBy)
      return {
        code: "OK",
        data: {
          items: list,
          total,
          page,
          pageSize,
        },
      };
    } catch (err) {
      logger.error({ err }, "获取内容列表失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /content/stats - 获取内容统计（各状态数量）
   */
  app.get("/stats", async (request, reply) => {
    try {
      const result = await db
        .select({
          status: contents.status,
          type: contents.type,
          count: count(),
        })
        .from(contents)
        .where(eq(contents.tenantId, request.tenantId))
        .groupBy(contents.status, contents.type);

      // 聚合为更友好的格式
      const stats = {
        total: 0,
        byStatus: {} as Record<string, number>,
        byType: {} as Record<string, number>,
      };

      for (const row of result) {
        const c = Number(row.count);
        stats.total += c;
        stats.byStatus[row.status] = (stats.byStatus[row.status] || 0) + c;
        stats.byType[row.type] = (stats.byType[row.type] || 0) + c;
      }

      return { code: "OK", data: stats };
    } catch (err) {
      logger.error({ err }, "获取内容统计失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /content - 创建内容
   */
  app.post("/", async (request, reply) => {
    try {
      const body = createContentSchema.parse(request.body);

      const [content] = await db
        .insert(contents)
        .values({
          tenantId: request.tenantId,
          userId: request.user.userId,
          type: body.type,
          title: body.title,
          body: body.body,
          conversationId: body.conversationId,
        })
        .returning();

      logger.info({ contentId: content.id, type: body.type }, "内容创建成功");

      return reply.code(201).send({ code: "OK", data: content });
    } catch (err) {
      logger.error({ err }, "创建内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * GET /content/:id - 获取单个内容（含 T4-1c 多版本 siblings）
   *
   * 同组定义（productionRecords.parentId 链）：
   * - 主版本：productionRecord.parentId = null，contentId = groupRoot
   * - 副版本：productionRecord.parentId = groupRoot
   * 单版本内容（无 productionRecord 或链上无其他版本）→ siblings: []
   */
  app.get("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const [content] = await db
        .select()
        .from(contents)
        .where(
          and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
        )
        .limit(1);

      if (!content) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "内容不存在",
        });
      }

      // T4-1c-1: 查同组 siblings（通过 productionRecords.parentId 链）
      // T4-3-4: 增补 templateId 字段（前端 ContentDetailPage 用它渲染模板 badge）
      let siblings: Array<{
        id: string;
        title: string | null;
        status: string;
        variantIndex: number | undefined;
        userSelected: boolean | undefined;
        userRejected: boolean | undefined;
        templateId: string | undefined;
        createdAt: Date;
      }> = [];

      const [pr] = await db
        .select()
        .from(productionRecords)
        .where(eq(productionRecords.contentId, content.id))
        .limit(1);

      if (pr) {
        // 主版本 parentId=null，groupRoot 就是自己 contentId；副版本则 groupRoot = parentId
        const groupRoot = pr.parentId ?? pr.contentId;
        if (groupRoot) {
          const groupPRs = await db
            .select()
            .from(productionRecords)
            .where(
              or(
                eq(productionRecords.parentId, groupRoot),
                and(
                  isNull(productionRecords.parentId),
                  eq(productionRecords.contentId, groupRoot)
                )
              )
            );
          const siblingContentIds = groupPRs
            .map((p) => p.contentId)
            .filter((cid): cid is string => !!cid && cid !== content.id);

          if (siblingContentIds.length > 0) {
            const siblingRows = await db
              .select({
                id: contents.id,
                title: contents.title,
                status: contents.status,
                metadata: contents.metadata,
                createdAt: contents.createdAt,
              })
              .from(contents)
              .where(
                and(
                  inArray(contents.id, siblingContentIds),
                  eq(contents.tenantId, request.tenantId)
                )
              );

          siblings = siblingRows
            .map((s) => {
              const meta = (s.metadata as Record<string, unknown> | null) || {};
              return {
                id: s.id,
                title: s.title,
                status: s.status,
                variantIndex: meta.variantIndex as number | undefined,
                userSelected: meta.userSelected as boolean | undefined,
                userRejected: meta.userRejected as boolean | undefined,
                templateId: meta.templateId as string | undefined,
                createdAt: s.createdAt,
              };
            })
            .sort(
              (a, b) =>
                ((a.variantIndex ?? 99) as number) -
                ((b.variantIndex ?? 99) as number)
            );
          }
        }
      }

      return { code: "OK", data: { ...content, siblings } };
    } catch (err) {
      logger.error({ err }, "获取内容详情失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * POST /content/:id/select-variant - 标记某版本为用户选中
   *
   * 行为：
   * - 选中（:id）：status=reviewing, metadata.userSelected=true, selectedAt
   * - 同组其他：metadata.userRejected=true, rejectedAt（status 不强改）
   * - 写一条 bossEdits (action=select_variant) 用于 AI 偏好学习
   * - 返回 { selected, siblings }
   *
   * 单版本 / 无 productionRecord 的内容返回 400 NO_VARIANT_GROUP。
   */
  app.post("/:id/select-variant", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      // 1. 找当前 content（带租户校验）
      const [content] = await db
        .select()
        .from(contents)
        .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
        .limit(1);
      if (!content) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      }

      // 2. 找当前 content 的 productionRecord
      const [pr] = await db
        .select()
        .from(productionRecords)
        .where(eq(productionRecords.contentId, id))
        .limit(1);
      if (!pr) {
        return reply.code(400).send({
          code: "NO_VARIANT_GROUP",
          message: "内容无版本组，无需选择",
        });
      }

      const groupRoot = pr.parentId ?? pr.contentId;
      if (!groupRoot) {
        return reply.code(400).send({
          code: "NO_VARIANT_GROUP",
          message: "版本组根节点缺失",
        });
      }

      // 3. 找同组所有 PR
      const groupPRs = await db
        .select()
        .from(productionRecords)
        .where(
          or(
            eq(productionRecords.parentId, groupRoot),
            and(
              isNull(productionRecords.parentId),
              eq(productionRecords.contentId, groupRoot)
            )
          )
        );
      const allContentIds = groupPRs
        .map((p) => p.contentId)
        .filter((cid): cid is string => !!cid);

      if (allContentIds.length <= 1) {
        return reply.code(400).send({
          code: "NO_VARIANT_GROUP",
          message: "内容无副版本，无需选择",
        });
      }

      // 4. 加载组内全部 contents
      const allContents = await db
        .select()
        .from(contents)
        .where(
          and(
            inArray(contents.id, allContentIds),
            eq(contents.tenantId, request.tenantId)
          )
        );

      const selected = allContents.find((c) => c.id === id);
      const others = allContents.filter((c) => c.id !== id);
      if (!selected) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      }

      const now = new Date();

      // 5. 选中版：status=reviewing + metadata.userSelected=true
      const selectedMeta = {
        ...((selected.metadata as Record<string, unknown>) || {}),
        userSelected: true,
        selectedAt: now.toISOString(),
      };
      await db
        .update(contents)
        .set({ status: "reviewing", metadata: selectedMeta, updatedAt: now })
        .where(eq(contents.id, id));

      // 6. 未选版：metadata.userRejected=true（status 不强改）
      const updatedOthers = [];
      for (const other of others) {
        const otherMeta = {
          ...((other.metadata as Record<string, unknown>) || {}),
          userRejected: true,
          rejectedAt: now.toISOString(),
        };
        await db
          .update(contents)
          .set({ metadata: otherMeta, updatedAt: now })
          .where(eq(contents.id, other.id));
        updatedOthers.push({ ...other, metadata: otherMeta });
      }

      // 7. 写 bossEdits（用于 AI 偏好学习；失败非阻塞）
      const firstReject = others[0];
      if (firstReject) {
        try {
          // T4-3-4: 提取选中 / 被拒的 templateId（老数据无 templateId 时字段为 undefined）
          const selectedMetaForEdit = (selected.metadata as Record<string, unknown>) || {};
          const selectedTemplateId =
            typeof selectedMetaForEdit.templateId === "string"
              ? (selectedMetaForEdit.templateId as string)
              : undefined;
          const rejectedTemplateIds = others
            .map((o) => {
              const m = (o.metadata as Record<string, unknown>) || {};
              return typeof m.templateId === "string" ? (m.templateId as string) : null;
            })
            .filter((tid): tid is string => !!tid);

          const patterns: Record<string, unknown> = {
            variantGroup: groupRoot,
            totalVariants: allContents.length,
            rejectedVariantIds: others.map((o) => o.id),
          };
          if (selectedTemplateId) patterns.selectedTemplateId = selectedTemplateId;
          if (rejectedTemplateIds.length > 0) patterns.rejectedTemplateIds = rejectedTemplateIds;

          await db.insert(bossEdits).values({
            id: nanoid(),
            tenantId: request.tenantId,
            contentId: id,
            action: "select_variant",
            originalTitle: others.map((o) => o.title || "").join("; "),
            editedTitle: selected.title || "",
            originalBody: (firstReject.body || "").slice(0, 2000),
            editedBody: (selected.body || "").slice(0, 2000),
            patternsExtracted: patterns,
          });
        } catch (err) {
          logger.warn({ err, contentId: id }, "T4-1c-1: bossEdits 写入失败（非阻塞）");
        }
      }

      logger.info(
        {
          tenantId: request.tenantId,
          selectedId: id,
          groupRoot,
          totalVariants: allContents.length,
        },
        "T4-1c-1: 用户选定变体"
      );

      // 8. 返回最新状态
      return {
        code: "OK",
        data: {
          selected: { ...selected, status: "reviewing", metadata: selectedMeta },
          siblings: updatedOthers.map((o) => {
            const meta = (o.metadata as Record<string, unknown>) || {};
            return {
              id: o.id,
              title: o.title,
              status: o.status,
              variantIndex: meta.variantIndex as number | undefined,
              userSelected: false,
              userRejected: true,
              templateId: meta.templateId as string | undefined,
              createdAt: o.createdAt,
            };
          }),
        },
      };
    } catch (err) {
      logger.error({ err }, "选定变体失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * PATCH /content/:id - 更新内容（人工二次编辑）
   * 权限：内容创建者或 owner/admin 可编辑
   */
  app.patch("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateContentSchema.parse(request.body);

      // 先获取内容，验证权限
      const [content] = await db
        .select()
        .from(contents)
        .where(
          and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
        )
        .limit(1);

      if (!content) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "内容不存在",
        });
      }

      // 权限检查：内容创建者或 owner/admin
      const userRole = request.user.role as string;
      const isCreator = content.userId === request.user.userId;
      const isAdmin = userRole === "owner" || userRole === "admin";

      if (!isCreator && !isAdmin) {
        return reply.code(403).send({
          code: "FORBIDDEN",
          message: "无权限编辑此内容",
        });
      }

      const [updated] = await db
        .update(contents)
        .set({
          ...body,
          updatedAt: new Date(),
        })
        .where(eq(contents.id, id))
        .returning();

      logger.info({ contentId: id, userId: request.user.userId }, "内容更新成功");

      return { code: "OK", data: updated };
    } catch (err) {
      logger.error({ err }, "更新内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * DELETE /content/:id - 删除内容
   */
  app.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const [deleted] = await db
        .delete(contents)
        .where(
          and(eq(contents.id, id), eq(contents.tenantId, request.tenantId))
        )
        .returning();

      if (!deleted) {
        return reply.code(404).send({
          code: "NOT_FOUND",
          message: "内容不存在",
        });
      }

      logger.info({ contentId: id }, "内容删除成功");

      return { code: "OK", data: { id } };
    } catch (err) {
      logger.error({ err }, "删除内容失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "操作失败，请稍后重试" });
    }
  });

  /**
   * T4-2-1: POST /content/:id/rewrite-section —— 章节重写预览
   *
   * 不写库；调用 AI 在前后章节上下文里重写指定章节，返回 diff 用预览。
   * 老板预览满意后，前端再调 /apply-rewrite 落库。
   */
  app.post("/:id/rewrite-section", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const schema = z.object({
        sectionHeading: z.string().min(1),
        instruction: z.string().min(1).max(500),
      });
      const body = schema.parse(request.body);

      const { rewriteSection } = await import(
        "../services/content-engine/section-rewrite.js"
      );
      const result = await rewriteSection({
        tenantId: request.tenantId,
        contentId: id,
        sectionHeading: body.sectionHeading,
        instruction: body.instruction,
      });

      return { code: "OK", data: result };
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg === "content_not_found") {
        return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      }
      if (msg === "no_h2_sections") {
        return reply.code(400).send({
          code: "NO_H2_SECTIONS",
          message: "内容没有 ## 章节，无法做章节重写",
        });
      }
      if (msg === "section_not_found") {
        return reply.code(400).send({
          code: "SECTION_NOT_FOUND",
          message: "未找到匹配的章节",
        });
      }
      if (msg === "no_ai_provider") {
        return reply.code(503).send({
          code: "NO_AI_PROVIDER",
          message: "AI 模型未配置",
        });
      }
      logger.error({ err }, "T4-2-1: 章节重写预览失败");
      return reply.code(500).send({
        code: "INTERNAL_ERROR",
        message: "重写失败，请稍后重试",
      });
    }
  });

  /**
   * T4-2-1: POST /content/:id/apply-rewrite —— 老板确认后落库 + bossEdits 学习信号
   *
   * - 用 splitByH2 找到目标章节，按 startLine..endLine 替换
   * - 写 bossEdits action="rewrite_section"，patternsExtracted 含 instruction + templateId
   *   后续与 select_variant 共同喂给 AI 偏好学习
   */
  app.post("/:id/apply-rewrite", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const schema = z.object({
        sectionHeading: z.string().min(1),
        newSectionBody: z.string().min(1),
        instruction: z.string().min(1).max(500),
      });
      const body = schema.parse(request.body);

      // 1. 读 content（带租户隔离）
      const [content] = await db
        .select()
        .from(contents)
        .where(and(eq(contents.id, id), eq(contents.tenantId, request.tenantId)))
        .limit(1);
      if (!content) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      }

      // 2. 切章节并匹配（与 service 层用同一函数，模糊匹配规则一致）
      const { splitByH2 } = await import(
        "../services/content-engine/section-rewrite.js"
      );
      const sections = splitByH2(content.body || "");
      if (sections.length === 0) {
        return reply.code(400).send({
          code: "NO_H2_SECTIONS",
          message: "内容没有 ## 章节，无法应用重写",
        });
      }
      const targetHeadingNorm = body.sectionHeading.replace(/^#+\s*/, "").trim().toLowerCase();
      const targetIdx = sections.findIndex((s) => {
        if (s.heading === body.sectionHeading) return true;
        if (s.headingText === body.sectionHeading) return true;
        const h = s.headingText.trim().toLowerCase();
        return h === targetHeadingNorm;
      });
      if (targetIdx === -1) {
        return reply.code(400).send({
          code: "SECTION_NOT_FOUND",
          message: "未找到匹配的章节",
        });
      }
      const target = sections[targetIdx];

      // 3. 替换 startLine..endLine 这一段，组装新 body
      const lines = (content.body || "").split("\n");
      const before = lines.slice(0, target.startLine);
      const after = lines.slice(target.endLine + 1);
      const newBody = [...before, body.newSectionBody, ...after].join("\n");

      // 4. 落库
      const now = new Date();
      await db
        .update(contents)
        .set({ body: newBody, updatedAt: now })
        .where(eq(contents.id, id));

      // 5. 写 bossEdits 学习信号（失败非阻塞）
      let bossEditId: string | null = null;
      try {
        const meta = (content.metadata as Record<string, unknown>) || {};
        const templateId = typeof meta.templateId === "string" ? meta.templateId : undefined;

        const [edit] = await db
          .insert(bossEdits)
          .values({
            id: nanoid(16),
            tenantId: request.tenantId,
            contentId: id,
            action: "rewrite_section",
            originalTitle: target.heading,
            editedTitle: target.heading,
            originalBody: target.content.slice(0, 2000),
            editedBody: body.newSectionBody.slice(0, 2000),
            patternsExtracted: {
              kind: "rewrite_section",
              instruction: body.instruction,
              sectionHeading: target.heading,
              ...(templateId ? { templateId } : {}),
            },
          })
          .returning({ id: bossEdits.id });
        bossEditId = edit?.id ?? null;
      } catch (err) {
        logger.warn(
          { err, contentId: id },
          "T4-2-1: bossEdits 写入失败（非阻塞）"
        );
      }

      logger.info(
        {
          tenantId: request.tenantId,
          contentId: id,
          sectionHeading: target.heading,
          bossEditId,
        },
        "T4-2-1: 章节重写已应用"
      );

      return {
        code: "OK",
        data: {
          contentId: id,
          updatedBody: newBody,
          bossEditId,
        },
      };
    } catch (err: any) {
      logger.error({ err }, "T4-2-1: apply-rewrite 失败");
      return reply.code(500).send({
        code: "INTERNAL_ERROR",
        message: "应用重写失败，请稍后重试",
      });
    }
  });
}
