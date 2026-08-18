/**
 * 运行时参数接口（8-18 Phase 4 第一批）。
 *
 * 验收标准只有一条：**老韩不碰代码改掉一个阈值。**
 * 所以这里返回的不只是 key/value，还带 `label` / `impact` / 边界 / 当前值来源 ——
 * 参数页要让人**看懂了再改**，而不是给一堆变量名让他猜。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { runtimeParamAudits } from "../models/schema.js";
import { logger } from "../config/logger.js";
import { requirePermission } from "../middleware/permission.js";
import { listParams, setParam, getParamDef } from "../services/ops/runtime-params.js";

const putSchema = z.object({ value: z.union([z.number(), z.boolean()]), note: z.string().max(500).optional() });

export async function runtimeParamRoutes(app: FastifyInstance) {
  /** GET / —— 参数页数据：定义 + 当前值 + 来源 */
  app.get("/", { preHandler: requirePermission("content.read") }, async (_req, reply) => {
    try {
      return reply.send({ success: true, data: await listParams() });
    } catch (err) {
      logger.error({ err }, "runtime_params.list_failed");
      return reply.status(500).send({ success: false, error: "读取失败" });
    }
  });

  /** PUT /:key —— 改一个参数。边界校验在服务层做（前端能绕过，DB 不能） */
  app.put("/:key", { preHandler: requirePermission("content.write") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    if (!getParamDef(key)) return reply.status(404).send({ success: false, error: `未注册的参数: ${key}` });
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, error: "参数不合法" });

    const changedBy = (request as { user?: { userId?: string } }).user?.userId ?? null;
    const r = await setParam(key, parsed.data.value, { changedBy, note: parsed.data.note ?? null });
    if (!r.ok) return reply.status(400).send({ success: false, error: r.reason });
    return reply.send({ success: true, data: { key, oldValue: r.oldValue, newValue: parsed.data.value } });
  });

  /** GET /:key/audits —— 谁在什么时候把它改成了什么 */
  app.get("/:key/audits", { preHandler: requirePermission("content.read") }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const rows = await db
      .select()
      .from(runtimeParamAudits)
      .where(eq(runtimeParamAudits.key, key))
      .orderBy(desc(runtimeParamAudits.createdAt))
      .limit(50);
    return reply.send({ success: true, data: rows });
  });
}
