/**
 * PR #123 V2 P6 preferences routes（5-15）。
 *
 * GET /api/v1/preferences          → 当前 tenant 全部偏好（少量 key，全量返）
 * GET /api/v1/preferences/:key     → 单 key 取值
 * PUT /api/v1/preferences/:key     → 设置（body: { value: string }）
 *
 * 任何登录 user 都能读写自己 tenant 的偏好（非 admin only）。
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../models/db.js";
import { tenantPreferences } from "../models/schema.js";
import { getPreference, setPreference } from "../services/preferences.js";

const ALLOWED_KEYS = new Set(["default_template"]);
const KEY_REGEX = /^[a-z][a-z0-9_]{2,40}$/;

const putBodySchema = z.object({ value: z.string().min(1).max(200) });

export async function preferencesRoutes(app: FastifyInstance) {
  app.get("/preferences", async (request) => {
    const rows = await db
      .select({ k: tenantPreferences.preferenceKey, v: tenantPreferences.preferenceValue })
      .from(tenantPreferences)
      .where(eq(tenantPreferences.tenantId, request.tenantId));
    const data: Record<string, string> = {};
    for (const r of rows) data[r.k] = r.v;
    return { code: "OK", data };
  });

  app.get("/preferences/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEY_REGEX.test(key)) return reply.code(400).send({ code: "BAD_KEY", message: "key 格式不合法" });
    const value = await getPreference(request.tenantId, key, null);
    return { code: "OK", data: { key, value } };
  });

  app.put("/preferences/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEY_REGEX.test(key)) return reply.code(400).send({ code: "BAD_KEY", message: "key 格式不合法" });
    if (!ALLOWED_KEYS.has(key)) return reply.code(400).send({ code: "KEY_NOT_ALLOWED", message: `key ${key} 不在白名单（防滥用）` });
    let parsed: z.infer<typeof putBodySchema>;
    try { parsed = putBodySchema.parse(request.body); }
    catch (err) { return reply.code(400).send({ code: "BAD_REQUEST", message: (err as Error).message }); }
    await setPreference(request.tenantId, key, parsed.value);
    return { code: "OK", data: { key, value: parsed.value } };
  });
}
