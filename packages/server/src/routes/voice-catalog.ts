/**
 * 7-10 音色库 API — 老韩反馈"生成数字人视频没地方选音色"的库侧支撑。
 *
 * GET    /voice-catalog       列表(本租户克隆音 + 全局共享预置音色) — 账号行下拉 / 生成弹窗 / 管理页共用
 * PATCH  /voice-catalog/:id   改名(adminOnly, 只能改本租户条目)
 * DELETE /voice-catalog/:id   删除(adminOnly, 只能删本租户条目; 有账号绑定 → 409 提示先解绑)
 *
 * 录音入库走既有 POST /accounts/:id/clone-voice(克隆成功后 insert 本表), 不在此文件。
 * 预置音色为全局共享行(tenant_id IS NULL), 各租户只读。
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "../models/db.js";
import { platformAccounts, voiceCatalog } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { requirePermission } from "../middleware/permission.js";
import { adminOnlyMiddleware } from "../middleware/admin-only.js";
import { sanitizeCatalogName, voiceTail } from "../services/voice/catalog-utils.js";

export async function voiceCatalogRoutes(app: FastifyInstance) {
  app.get("/voice-catalog", { preHandler: requirePermission("accounts.read") }, async (request) => {
    const rows = await db
      .select()
      .from(voiceCatalog)
      .where(or(isNull(voiceCatalog.tenantId), eq(voiceCatalog.tenantId, request.tenantId)))
      .orderBy(desc(voiceCatalog.createdAt));
    // 克隆音在前(用户自己的声音优先展示), 预置殿后
    rows.sort((a, b) => (a.type === b.type ? 0 : a.type === "cloned" ? -1 : 1));
    return {
      code: "OK",
      data: {
        voices: rows.map((r) => ({
          id: r.id,
          name: r.name,
          voiceId: r.voiceId,
          voiceTail: voiceTail(r.voiceId),
          type: r.type,
          sampleUrl: r.sampleUrl,
          shared: !r.tenantId, // 全局预置行: 前端禁用改名/删除
          createdAt: r.createdAt,
        })),
      },
    };
  });

  app.patch("/voice-catalog/:id", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const name = sanitizeCatalogName((request.body as { name?: unknown } | null)?.name);
    if (!name) return reply.code(400).send({ code: "BAD_NAME", message: "名字必填且 ≤60 字" });

    const [updated] = await db
      .update(voiceCatalog)
      .set({ name })
      .where(and(eq(voiceCatalog.id, id), eq(voiceCatalog.tenantId, request.tenantId)))
      .returning({ id: voiceCatalog.id, name: voiceCatalog.name });
    if (!updated) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "音色不存在或是全局预置音色(不可改名)" });
    }
    logger.info({ catalogId: id, name }, "7-10 音色库改名");
    return { code: "OK", data: updated };
  });

  app.delete("/voice-catalog/:id", { preHandler: adminOnlyMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const [row] = await db
      .select()
      .from(voiceCatalog)
      .where(and(eq(voiceCatalog.id, id), eq(voiceCatalog.tenantId, request.tenantId)))
      .limit(1);
    if (!row) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "音色不存在或是全局预置音色(不可删除)" });
    }

    // 删除前查绑定: 有账号还在用这条 voice_id → 409 让用户先去账号行换音色
    const bound = await db
      .select({ accountName: platformAccounts.accountName, remark: platformAccounts.remark })
      .from(platformAccounts)
      .where(and(eq(platformAccounts.tenantId, request.tenantId), eq(platformAccounts.clonedVoiceId, row.voiceId)));
    if (bound.length > 0) {
      const names = bound.map((b) => b.remark || b.accountName).slice(0, 5).join("、");
      return reply.code(409).send({
        code: "VOICE_IN_USE",
        message: `还有 ${bound.length} 个账号绑定此音色(${names}${bound.length > 5 ? "…" : ""}), 请先在账号页换音色再删`,
      });
    }

    await db.delete(voiceCatalog).where(and(eq(voiceCatalog.id, id), eq(voiceCatalog.tenantId, request.tenantId)));
    logger.info({ catalogId: id, voiceId: row.voiceId, name: row.name }, "7-10 音色库删除");
    return { code: "OK", data: { id } };
  });
}
