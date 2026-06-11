/**
 * Agent-1 (B轨): 本地发布 Agent 服务端任务框架 — docs/short-video-channel-plan.md 第4节
 *
 * 本地 Agent 跑在客户电脑 (家用IP+有头浏览器), 轮询服务器领发布任务 →
 * 本地浏览器把视频发到视频号/抖音 → 回报结果。服务端职责: 配对、任务队列、领单、视频下载、结果回报。
 *
 * 两个 plugin:
 *   agentPublishRoutes — 公开注册, 自带 x-agent-token 鉴权 (不走用户 JWT):
 *     POST /agent/pair               配对码换 token (无需 token)
 *     GET  /agent/ping               心跳/连通检查
 *     POST /agent/tasks/claim        原子领单 (FOR UPDATE SKIP LOCKED, 多设备并发安全)
 *     GET  /agent/tasks/:id/video    视频下载 (/storage/ 流式回传; http 302 重定向)
 *     POST /agent/tasks/:id/result   结果回报 (success → content_publish_log upsert draft)
 *   agentAdminRoutes — 受保护区 (用户 JWT + tenant):
 *     POST   /agent-admin/pairing-code  生成 6 位配对码 (10 分钟有效, 一次性)
 *     GET    /agent-admin/devices       设备列表 (online = lastSeenAt < 90s)
 *     DELETE /agent-admin/devices/:id   吊销设备 (status=disabled)
 *     POST   /agent-admin/dispatch      派单: 每账号建任务, 文案复用 buildPushCaptions
 *     GET    /agent-admin/tasks         查任务状态 (前端轮询进度)
 *
 * 安全要点:
 *   - token 明文只在配对响应出现一次, 服务端只存 sha256 hex
 *   - login_expired 只更新任务 — Agent 登录态在客户本机, 与服务器 platform_accounts.login_status 无关
 *   - /storage/ 路径做 storageRoot 前缀校验, 防目录穿越
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import {
  agentDevices,
  agentPublishTasks,
  contentPublishLog,
  contents,
  platformAccounts,
} from "../models/schema.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { buildPushCaptions } from "../services/publisher/draft-push.js";

type AgentDevice = typeof agentDevices.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    /** agent token 鉴权通过后挂载的设备行 (含 tenantId) */
    agentDevice?: AgentDevice;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_STATUSES = new Set(["success", "failed", "login_expired"]);

// ===== 配对码内存表 (一次性, 10 分钟过期; 重启即失效 — 配对是低频人工操作, 可接受) =====
const PAIRING_CODES = new Map<string, { tenantId: string; expiresAt: number }>();
const PAIRING_TTL_MS = 10 * 60 * 1000;

function sweepExpiredCodes() {
  const now = Date.now();
  for (const [code, v] of PAIRING_CODES) {
    if (v.expiresAt <= now) PAIRING_CODES.delete(code);
  }
}

// ===== last_seen_at 写库节流 (>60s 才写一次, claim 轮询不打爆 DB) =====
const lastSeenWrites = new Map<string, number>();

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** x-agent-token 鉴权: sha256(token) 查 agent_devices, active 才放行; 顺手节流更新 last_seen_at */
async function agentAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = request.headers["x-agent-token"];
  if (typeof token !== "string" || token.length < 16) {
    return reply.code(401).send({ code: "UNAUTHORIZED", message: "缺少 x-agent-token" });
  }
  const [device] = await db
    .select()
    .from(agentDevices)
    .where(eq(agentDevices.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!device || device.status !== "active") {
    return reply.code(401).send({ code: "UNAUTHORIZED", message: "token 无效或设备已吊销" });
  }
  request.agentDevice = device;

  const last = lastSeenWrites.get(device.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastSeenWrites.set(device.id, Date.now());
    try {
      await db
        .update(agentDevices)
        .set({ lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(agentDevices.id, device.id));
    } catch (err) {
      logger.warn({ err, deviceId: device.id }, "agent last_seen_at 更新失败(忽略)");
    }
  }
}

/** 取任务并校验归属于该设备的租户 */
async function loadTenantTask(taskId: string, tenantId: string) {
  if (!UUID_RE.test(taskId)) return null;
  const [task] = await db
    .select()
    .from(agentPublishTasks)
    .where(and(eq(agentPublishTasks.id, taskId), eq(agentPublishTasks.tenantId, tenantId)))
    .limit(1);
  return task ?? null;
}

// ============ 公开 plugin: /agent/* (token 鉴权) ============
export async function agentPublishRoutes(app: FastifyInstance) {
  /**
   * POST /agent/pair {code, name, version?} — 配对码换 token (无需 token)
   * 配对码由 /agent-admin/pairing-code 生成, 一次性, 用后即删。
   */
  app.post("/agent/pair", async (request, reply) => {
    const body = (request.body ?? {}) as { code?: string; name?: string; version?: string };
    const code = String(body.code ?? "").trim();
    const name = String(body.name ?? "").trim().slice(0, 100);
    if (!code || !name) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "code 与 name 必填" });
    }
    sweepExpiredCodes();
    const entry = PAIRING_CODES.get(code);
    if (!entry) {
      return reply.code(400).send({ code: "INVALID_CODE", message: "配对码无效或已过期, 请在 BossMate 设置页重新生成" });
    }
    PAIRING_CODES.delete(code); // 一次性

    const token = randomBytes(24).toString("hex"); // 48 hex
    const [device] = await db
      .insert(agentDevices)
      .values({
        tenantId: entry.tenantId,
        name,
        tokenHash: sha256Hex(token),
        version: body.version ? String(body.version).slice(0, 20) : null,
        lastSeenAt: new Date(),
      })
      .returning();
    logger.info({ deviceId: device.id, tenantId: entry.tenantId, name }, "agent 设备配对成功");
    return { code: "OK", data: { token, deviceId: device.id, tenantId: entry.tenantId } };
  });

  // 以下路由统一走 token 鉴权
  await app.register(async (authed) => {
    authed.addHook("onRequest", agentAuth);

    /** GET /agent/ping — 心跳/连通检查 */
    authed.get("/agent/ping", async (request) => {
      return { ok: true, serverTime: new Date().toISOString(), deviceId: request.agentDevice!.id };
    });

    /**
     * POST /agent/tasks/claim {platforms?, limit?=1} — 原子领单。
     * 并发安全: 子查询 FOR UPDATE SKIP LOCKED — 多设备同时 claim 时, 已被其他事务
     * 锁住的行直接跳过(不阻塞不重复), UPDATE 整句单事务原子完成, 一行任务只会被领走一次。
     */
    authed.post("/agent/tasks/claim", async (request) => {
      const device = request.agentDevice!;
      const body = (request.body ?? {}) as { platforms?: string[]; limit?: number };
      const limit = Math.min(Math.max(Math.floor(Number(body.limit) || 1), 1), 10);
      const platforms = Array.isArray(body.platforms)
        ? body.platforms.filter((p) => typeof p === "string" && p.length <= 20).slice(0, 10)
        : [];
      const platformFilter = platforms.length > 0
        ? sql` AND platform = ANY(${platforms}::text[])`
        : sql``;

      const result = await db.execute(sql`
        UPDATE agent_publish_tasks
        SET status = 'claimed',
            agent_device_id = ${device.id},
            claimed_at = NOW(),
            attempts = attempts + 1,
            updated_at = NOW()
        WHERE id IN (
          SELECT id FROM agent_publish_tasks
          WHERE tenant_id = ${device.tenantId} AND status = 'pending'${platformFilter}
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, content_id, account_id, platform, account_name, video_source, caption, title, attempts
      `);
      const rows = ((result as any).rows ?? []) as Array<Record<string, any>>;
      if (rows.length > 0) {
        logger.info({ deviceId: device.id, count: rows.length }, "agent 领单");
      }
      return {
        code: "OK",
        data: {
          tasks: rows.map((r) => ({
            id: r.id,
            contentId: r.content_id,
            accountId: r.account_id,
            platform: r.platform,
            accountName: r.account_name,
            videoSource: r.video_source,
            caption: r.caption,
            title: r.title,
            attempts: r.attempts,
          })),
        },
      };
    });

    /**
     * GET /agent/tasks/:id/video — 任务视频下载。
     * /storage/ 开头 → 流式回传磁盘文件; http(s) → 302 重定向原 URL。
     */
    authed.get("/agent/tasks/:id/video", async (request, reply) => {
      const device = request.agentDevice!;
      const { id } = request.params as { id: string };
      const task = await loadTenantTask(id, device.tenantId);
      if (!task) return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
      if (task.status !== "claimed") {
        return reply.code(409).send({ code: "BAD_STATUS", message: `任务状态为 ${task.status}, 仅 claimed 可下载视频` });
      }

      const src = task.videoSource;
      if (/^https?:\/\//i.test(src)) {
        return reply.redirect(src, 302);
      }
      if (src.startsWith("/storage/")) {
        const storageRoot = resolve(env.UPLOAD_DIR, "storage");
        const diskPath = resolve(storageRoot, src.slice("/storage/".length));
        if (diskPath !== storageRoot && !diskPath.startsWith(storageRoot + sep)) {
          return reply.code(400).send({ code: "BAD_REQUEST", message: "非法视频路径" });
        }
        let fileStat;
        try {
          fileStat = await stat(diskPath);
        } catch {
          return reply.code(404).send({ code: "NOT_FOUND", message: "视频文件不存在" });
        }
        reply.header("content-length", String(fileStat.size));
        reply.type("video/mp4");
        return reply.send(createReadStream(diskPath));
      }
      return reply.code(400).send({ code: "BAD_REQUEST", message: `无法识别的视频源: ${src.slice(0, 80)}` });
    });

    /**
     * POST /agent/tasks/:id/result {status, error?} — 结果回报。
     * success → content_publish_log upsert status="draft" initiatedBy="agent"
     *   (与 draft-push 一致: 人工在平台后台确认发布后, 前端勾"已发"再覆盖成 success)。
     * login_expired 只标任务 — Agent 登录态在客户本机, 不动服务器侧 login_status。
     */
    authed.post("/agent/tasks/:id/result", async (request, reply) => {
      const device = request.agentDevice!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { status?: string; error?: string };
      if (!body.status || !RESULT_STATUSES.has(body.status)) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: "status 须为 success | failed | login_expired" });
      }
      const task = await loadTenantTask(id, device.tenantId);
      if (!task) return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
      if (task.status !== "claimed") {
        return reply.code(409).send({ code: "BAD_STATUS", message: `任务状态为 ${task.status}, 不可回报` });
      }

      await db
        .update(agentPublishTasks)
        .set({
          status: body.status,
          error: body.status === "success" ? null : String(body.error ?? "").slice(0, 2000) || null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentPublishTasks.id, task.id));

      if (body.status === "success") {
        await db
          .insert(contentPublishLog)
          .values({
            tenantId: task.tenantId,
            contentId: task.contentId,
            accountId: task.accountId,
            status: "draft",
            initiatedBy: "agent",
          })
          .onConflictDoUpdate({
            target: [contentPublishLog.contentId, contentPublishLog.accountId],
            set: { status: "draft", initiatedBy: "agent", updatedAt: new Date() },
          });
      }
      logger.info({ taskId: task.id, deviceId: device.id, status: body.status }, "agent 任务回报");
      return { code: "OK", data: { id: task.id, status: body.status } };
    });
  });
}

// ============ 受保护 plugin: /agent-admin/* (用户 JWT + tenant) ============
export async function agentAdminRoutes(app: FastifyInstance) {
  /** POST /agent-admin/pairing-code — 生成 6 位数字配对码 (10 分钟, 一次性) */
  app.post("/agent-admin/pairing-code", async (request) => {
    sweepExpiredCodes();
    let code = "";
    do {
      code = String(Math.floor(100000 + Math.random() * 900000));
    } while (PAIRING_CODES.has(code));
    PAIRING_CODES.set(code, { tenantId: request.tenantId, expiresAt: Date.now() + PAIRING_TTL_MS });
    return { code: "OK", data: { code, expiresInSec: PAIRING_TTL_MS / 1000 } };
  });

  /** GET /agent-admin/devices — 本租户设备列表 (online = lastSeenAt < 90s) */
  app.get("/agent-admin/devices", async (request) => {
    const rows = await db
      .select({
        id: agentDevices.id,
        name: agentDevices.name,
        status: agentDevices.status,
        lastSeenAt: agentDevices.lastSeenAt,
        version: agentDevices.version,
        createdAt: agentDevices.createdAt,
      })
      .from(agentDevices)
      .where(eq(agentDevices.tenantId, request.tenantId))
      .orderBy(desc(agentDevices.createdAt));
    const now = Date.now();
    return {
      code: "OK",
      data: {
        devices: rows.map((d) => ({
          ...d,
          online: d.status === "active" && !!d.lastSeenAt && now - d.lastSeenAt.getTime() < 90_000,
        })),
      },
    };
  });

  /** DELETE /agent-admin/devices/:id — 吊销设备 (status=disabled, token 即刻失效) */
  app.delete("/agent-admin/devices/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ code: "BAD_REQUEST", message: "id 非法" });
    const updated = await db
      .update(agentDevices)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(and(eq(agentDevices.id, id), eq(agentDevices.tenantId, request.tenantId)))
      .returning({ id: agentDevices.id });
    if (updated.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "设备不存在" });
    return { code: "OK", data: { id, status: "disabled" } };
  });

  /**
   * POST /agent-admin/dispatch {contentId, accountIds} — 给每个账号建发布任务。
   * 文案/标题: 复用 buildPushCaptions (draft-push 同源, 差异化 variants 按账号序号对应);
   * videoSource: 与 draft-push 同口径 — content.type==="video" 时取 content.body。
   */
  app.post("/agent-admin/dispatch", async (request, reply) => {
    const reqBody = (request.body ?? {}) as { contentId?: string; accountIds?: string[] };
    const contentId = String(reqBody.contentId ?? "");
    const accountIds = Array.isArray(reqBody.accountIds)
      ? reqBody.accountIds.filter((a) => typeof a === "string" && UUID_RE.test(a))
      : [];
    if (!UUID_RE.test(contentId) || accountIds.length === 0) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "contentId 与 accountIds 必填" });
    }
    try {
      const [content] = await db
        .select({ id: contents.id, type: contents.type, title: contents.title, body: contents.body })
        .from(contents)
        .where(and(
          eq(contents.id, contentId),
          or(eq(contents.tenantId, request.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
        ))
        .limit(1);
      if (!content) return reply.code(404).send({ code: "NOT_FOUND", message: "内容不存在" });
      const videoSource = content.type === "video" ? content.body : null;
      if (!videoSource) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: "内容不是视频或缺少视频地址" });
      }

      const accts = await db
        .select({
          id: platformAccounts.id,
          accountName: platformAccounts.accountName,
          platform: platformAccounts.platform,
        })
        .from(platformAccounts)
        .where(and(inArray(platformAccounts.id, accountIds), eq(platformAccounts.tenantId, request.tenantId)));
      if (accts.length === 0) return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });

      const { captions, titles } = await buildPushCaptions(content.id, request.tenantId, accts);
      const tasks = await db
        .insert(agentPublishTasks)
        .values(accts.map((a, i) => ({
          tenantId: request.tenantId,
          contentId: content.id,
          accountId: a.id,
          platform: a.platform,
          accountName: a.accountName,
          videoSource,
          caption: captions[i] ?? captions[0] ?? content.title ?? "",
          title: (titles[i] ?? titles[0] ?? content.title ?? "").slice(0, 200),
        })))
        .returning();
      logger.info({ contentId: content.id, count: tasks.length, tenantId: request.tenantId }, "agent 派单");
      return { code: "OK", data: { tasks } };
    } catch (err) {
      logger.error({ err, contentId }, "agent 派单失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "派单失败，请稍后重试" });
    }
  });

  /** GET /agent-admin/tasks?contentId= — 查任务状态 (前端轮询进度) */
  app.get("/agent-admin/tasks", async (request, reply) => {
    const q = (request.query ?? {}) as { contentId?: string };
    const conds = [eq(agentPublishTasks.tenantId, request.tenantId)];
    if (q.contentId) {
      if (!UUID_RE.test(q.contentId)) {
        return reply.code(400).send({ code: "BAD_REQUEST", message: "contentId 非法" });
      }
      conds.push(eq(agentPublishTasks.contentId, q.contentId));
    }
    const rows = await db
      .select()
      .from(agentPublishTasks)
      .where(and(...conds))
      .orderBy(desc(agentPublishTasks.createdAt))
      .limit(100);
    return { code: "OK", data: { tasks: rows } };
  });
}
