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
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { resolve, sep, join } from "node:path";
import { createZip, type ZipEntry } from "../utils/zip.js";
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
const RESULT_STATUSES = new Set(["success", "failed", "login_expired", "manual_pending"]);

// ===== 配对码内存表 (一次性, 10 分钟过期; 重启即失效 — 配对是低频人工操作, 可接受) =====
const PAIRING_CODES = new Map<string, { tenantId: string; expiresAt: number }>();
const execFileP = promisify(execFile);
// 免装Node便携包懒构建锁(防并发重复构建), key = platform
const portableBuildLocks = new Map<string, Promise<void>>();
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
     * POST /agent/accounts/:id/profile {nickname?, uid?} — 登录成功后回填平台真实账号信息。
     * 解决"账号管理标签(如'叫老肖就行')与实际登录的抖音号对不上"。
     * 写 accountId(平台账号ID) + metadata.realNickname; 账号须属于该设备租户。
     */
    authed.post("/agent/accounts/:id/profile", async (request, reply) => {
      const device = request.agentDevice!;
      const { id } = request.params as { id: string };
      const b = (request.body ?? {}) as { nickname?: string; uid?: string };
      const nickname = b.nickname ? String(b.nickname).slice(0, 100) : undefined;
      const uid = b.uid ? String(b.uid).slice(0, 100) : undefined;
      if (!nickname && !uid) return reply.code(400).send({ code: "BAD_REQUEST", message: "nickname/uid 至少一个" });
      const [acc] = await db
        .select({ id: platformAccounts.id, metadata: platformAccounts.metadata })
        .from(platformAccounts)
        .where(and(eq(platformAccounts.id, id), eq(platformAccounts.tenantId, device.tenantId)))
        .limit(1);
      if (!acc) return reply.code(404).send({ code: "NOT_FOUND", message: "账号不存在" });
      const meta = {
        ...((acc.metadata as Record<string, unknown>) ?? {}),
        ...(nickname ? { realNickname: nickname } : {}),
        profileSyncedAt: new Date().toISOString(),
      };
      const set: Record<string, unknown> = { metadata: meta, updatedAt: new Date() };
      if (uid) set.accountId = uid;
      await db.update(platformAccounts).set(set).where(eq(platformAccounts.id, id));
      logger.info({ accountId: id, nickname, uid }, "agent 回填账号真实信息");
      return { code: "OK" };
    });

    /**
     * POST /agent/metrics — PR-FW Agent 读数据回报。
     * Agent 用登录浏览器读各平台创作者后台的阅读/播放数据, 批量回报 → content_metrics。
     * body: { items: [{ contentId, platform, views?, likes?, shares?, followers?, inquiries? }] }
     */
    authed.post("/agent/metrics", async (request, reply) => {
      const device = request.agentDevice!;
      const body = (request.body ?? {}) as { items?: Array<Record<string, unknown>> };
      const items = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      if (items.length === 0) return reply.code(400).send({ code: "BAD_REQUEST", message: "items 必填" });
      const { recordMetric } = await import("../services/metrics/roi.js");
      let ok = 0;
      for (const it of items) {
        const contentId = String(it.contentId ?? "");
        const platform = String(it.platform ?? "");
        if (!UUID_RE.test(contentId) || !platform) continue;
        await recordMetric({
          tenantId: device.tenantId, contentId, accountId: "", platform,
          views: Number(it.views) || 0, likes: Number(it.likes) || 0, shares: Number(it.shares) || 0,
          followers: Number(it.followers) || 0, inquiries: Number(it.inquiries) || 0, source: "api",
        });
        ok++;
      }
      logger.info({ deviceId: device.id, reported: ok }, "PR-FW Agent 指标回报");
      return { code: "OK", data: { reported: ok } };
    });

    /** GET /agent/accounts — 本租户可本地发布的账号列表 (douyin/wechat_video, Agent login 命令列账号用) */
    authed.get("/agent/accounts", async (request) => {
      const device = request.agentDevice!;
      const rows = await db
        .select({
          id: platformAccounts.id,
          platform: platformAccounts.platform,
          accountName: platformAccounts.accountName,
          status: platformAccounts.status,
        })
        .from(platformAccounts)
        .where(and(
          eq(platformAccounts.tenantId, device.tenantId),
          inArray(platformAccounts.platform, ["douyin", "wechat_video"]),
        ))
        .orderBy(desc(platformAccounts.createdAt));
      return { code: "OK", data: { accounts: rows } };
    });

    /**
     * POST /agent/tasks/claim {platforms?, limit?=1} — 原子领单。
     * 并发安全: 子查询 FOR UPDATE SKIP LOCKED — 多设备同时 claim 时, 已被其他事务
     * 锁住的行直接跳过(不阻塞不重复), UPDATE 整句单事务原子完成, 一行任务只会被领走一次。
     */
    authed.post("/agent/tasks/claim", async (request, reply) => {
      const device = request.agentDevice!;
      try {
      const body = (request.body ?? {}) as { platforms?: string[]; limit?: number };
      const limit = Math.min(Math.max(Math.floor(Number(body.limit) || 1), 1), 10);
      const platforms = Array.isArray(body.platforms)
        ? body.platforms.filter((p) => typeof p === "string" && p.length <= 20).slice(0, 10)
        : [];
      // 6-11 真机首跑修复: drizzle 对 sql 模板里的 JS 数组参数会展开成多值而非 pg 数组,
      // ANY(${arr}::text[]) 生成非法 SQL → 500。改为逐参数 IN 列表(各值独立占位符, 同样防注入)。
      const platformFilter = platforms.length > 0
        ? sql` AND apt.platform IN (${sql.join(platforms.map((p) => sql`${p}`), sql`, `)})`
        : sql``;

      const result = await db.execute(sql`
        UPDATE agent_publish_tasks
        SET status = 'claimed',
            agent_device_id = ${device.id},
            claimed_at = NOW(),
            attempts = attempts + 1,
            updated_at = NOW()
        WHERE id IN (
          SELECT apt.id FROM agent_publish_tasks apt
          JOIN platform_accounts pa ON pa.id = apt.account_id
          WHERE apt.tenant_id = ${device.tenantId} AND apt.status = 'pending'${platformFilter}
            AND (pa.agent_device_id IS NULL OR pa.agent_device_id = ${device.id})
          ORDER BY apt.created_at
          LIMIT ${limit}
          FOR UPDATE OF apt SKIP LOCKED
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
      } catch (err) {
        logger.error({ err, deviceId: device.id }, "agent claim 失败");
        return reply.code(500).send({ code: "CLAIM_FAILED", message: err instanceof Error ? err.message : "领单失败" });
      }
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
        return reply.code(400).send({ code: "BAD_REQUEST", message: "status 须为 success | failed | login_expired | manual_pending" });
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
          error: (body.status === "success") ? null : String(body.error ?? "").slice(0, 2000) || null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentPublishTasks.id, task.id));

      // PR-A16: 设备成功推完该账号的任务 = 该设备持有此账号登录态 → 自动绑定 (后续任务只派它)
      if (body.status === "success" || body.status === "manual_pending") {
        await db
          .update(platformAccounts)
          .set({ agentDeviceId: device.id, updatedAt: new Date() })
          .where(and(eq(platformAccounts.id, task.accountId), eq(platformAccounts.tenantId, device.tenantId)));
      }

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

  /**
   * POST /agent-admin/launcher-config — 生成含「服务器地址 + 一次性配对码」的客户配置 (bossmate.cfg 内容)。
   * 前端拿 cfg 文本触发下载, 客户把它放进 agent 文件夹双击启动器即免输码自动配对。
   * 配对码同样 10 分钟有效、一次性 (复用 PAIRING_CODES)。
   */
  app.post("/agent-admin/launcher-config", async (request) => {
    const body = (request.body ?? {}) as { origin?: string; deviceName?: string };
    // 服务器地址: 优先用前端传的 origin (与网页同源, 确保客户可达), 否则从请求头推导
    const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol || "http";
    const host = String(request.headers["host"] ?? "");
    const serverUrl = (typeof body.origin === "string" && /^https?:\/\//.test(body.origin))
      ? body.origin.replace(/\/+$/, "")
      : `${proto}://${host}`;
    const deviceName = (body.deviceName ? String(body.deviceName).slice(0, 60) : "") || "客户电脑";
    sweepExpiredCodes();
    let code = "";
    do {
      code = String(Math.floor(100000 + Math.random() * 900000));
    } while (PAIRING_CODES.has(code));
    PAIRING_CODES.set(code, { tenantId: request.tenantId, expiresAt: Date.now() + PAIRING_TTL_MS });
    const cfg =
      "# BossMate Agent 配对配置 — 放进 agent 文件夹, 双击启动器即自动配对 (配对码 10 分钟有效, 过期重新下载)\n" +
      `SERVER_URL=${serverUrl}\n` +
      `PAIR_CODE=${code}\n` +
      `DEVICE_NAME=${deviceName}\n`;
    return { code: "OK", data: { cfg, pairCode: code, serverUrl, expiresInSec: PAIRING_TTL_MS / 1000 } };
  });

  /**
   * POST /agent-admin/client-package — 一键打包完整客户端启动包 (zip, 流式下载)。
   * 内含: 预构建 dist/ + 双击启动器(Mac/Win) + 运行时 package.json + 使用说明 + 内置一次性配对码的 bossmate.cfg。
   * 客户解压后双击启动器即免输码自动配对。零依赖打 zip (utils/zip), 不依赖系统 zip / npm 包。
   * 前提: 服务端须已构建 agent (部署含 pnpm --filter @bossmate/agent build)。
   */
  app.post("/agent-admin/client-package", async (request, reply) => {
    // 定位 agent 目录 (兼容 cwd=packages/server 或 仓库根)
    const candidates = [
      resolve(process.cwd(), "../agent"),
      resolve(process.cwd(), "packages/agent"),
      resolve(process.cwd(), "../../packages/agent"),
    ];
    const agentDir = candidates.find((d) => existsSync(join(d, "launcher", "start-agent.command")) && existsSync(join(d, "dist", "cli.js")));
    if (!agentDir) {
      return reply.code(503).send({ code: "AGENT_NOT_BUILT", message: "服务端暂未构建 agent 产物, 请确认部署已执行 pnpm --filter @bossmate/agent build" });
    }

    const body = (request.body ?? {}) as { origin?: string; deviceName?: string; platform?: string; portable?: boolean };
    const proto = (request.headers["x-forwarded-proto"] as string) || request.protocol || "http";
    const host = String(request.headers["host"] ?? "");
    const serverUrl = (typeof body.origin === "string" && /^https?:\/\//.test(body.origin))
      ? body.origin.replace(/\/+$/, "")
      : `${proto}://${host}`;
    const deviceName = (body.deviceName ? String(body.deviceName).slice(0, 60) : "") || "客户电脑";
    // 按系统拆包: 只放对应启动器, 防客户点错 (windows=只 .bat, mac=只 .command, 其它=两个都放向后兼容)
    const platform = body.platform === "windows" || body.platform === "mac" ? body.platform : "both";

    // 免装Node便携包: 懒构建(首次约1-2分钟下载Node+vendor+打包) → 缓存 → 流式下发。SERVER_URL 注入到包内 cfg。
    if (body.portable === true && (platform === "windows" || platform === "mac")) {
      const zipName = platform === "windows" ? "bossmate-agent-Windows-便携.zip" : "bossmate-agent-Mac-便携.zip";
      const zipPath = join(agentDir, zipName);
      const scriptName = platform === "windows" ? "build-portable-win.mjs" : "build-portable-mac.mjs";
      if (!existsSync(zipPath)) {
        let inflight = portableBuildLocks.get(platform);
        if (!inflight) {
          inflight = (async () => {
            logger.info({ platform }, "开始构建免装Node便携包(首次, 服务器下载Node+vendor+打包, 约1-2分钟)");
            await execFileP("node", [join(agentDir, "scripts", scriptName)], {
              cwd: agentDir,
              env: { ...process.env, SERVER_URL: serverUrl },
              timeout: 6 * 60 * 1000,
              maxBuffer: 20 * 1024 * 1024,
            });
          })().finally(() => portableBuildLocks.delete(platform));
          portableBuildLocks.set(platform, inflight);
        }
        try {
          await inflight;
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : err, platform }, "便携包构建失败");
          return reply.code(500).send({ code: "BUILD_FAILED", message: "便携包生成失败(服务器下载Node/打包出错), 详见服务器日志" });
        }
      }
      if (!existsSync(zipPath)) {
        return reply.code(500).send({ code: "BUILD_FAILED", message: "便携包未生成" });
      }
      logger.info({ platform, zipPath }, "流式下发免装Node便携包");
      // 响应头文件名必须 ASCII(中文会报 Invalid character in header); 真实下载名由前端 a.download 决定
      const asciiName = platform === "windows" ? "bossmate-agent-windows-portable.zip" : "bossmate-agent-mac-portable.zip";
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${asciiName}"`)
        .send(createReadStream(zipPath));
    }

    sweepExpiredCodes();
    let code = "";
    do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (PAIRING_CODES.has(code));
    PAIRING_CODES.set(code, { tenantId: request.tenantId, expiresAt: Date.now() + PAIRING_TTL_MS });

    const entries: ZipEntry[] = [];
    // dist/ 递归
    const distDir = join(agentDir, "dist");
    for (const rel of readdirSync(distDir, { recursive: true }) as string[]) {
      const abs = join(distDir, rel);
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      entries.push({ name: `dist/${rel.split(sep).join("/")}`, data: readFileSync(abs) });
    }
    // 启动器(按系统) + 说明
    const launchers = platform === "windows" ? ["start-agent.bat"]
      : platform === "mac" ? ["start-agent.command"]
      : ["start-agent.command", "start-agent.bat"];
    for (const f of [...launchers, "使用说明.txt"]) {
      const abs = join(agentDir, "launcher", f);
      if (existsSync(abs)) entries.push({ name: f, data: readFileSync(abs), mode: f.endsWith(".command") ? 0o100755 : 0o100644 });
    }
    // 运行时 package.json (只留运行依赖)
    try {
      const pkg = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as { version?: string; dependencies?: Record<string, string> };
      const runtimePkg = { name: "bossmate-agent-client", private: true, version: pkg.version ?? "0.1.0", type: "module", dependencies: pkg.dependencies ?? {} };
      entries.push({ name: "package.json", data: Buffer.from(JSON.stringify(runtimePkg, null, 2) + "\n", "utf8") });
    } catch { /* 缺 package.json 不致命 */ }
    // 内置码 cfg
    const cfg = "# BossMate Agent 配对配置 (随包内置, 配对码 10 分钟有效)\n" +
      `SERVER_URL=${serverUrl}\nPAIR_CODE=${code}\nDEVICE_NAME=${deviceName}\n`;
    entries.push({ name: "bossmate.cfg", data: Buffer.from(cfg, "utf8") });

    const zip = createZip(entries);
    const fname = platform === "windows" ? "bossmate-agent-Windows.zip"
      : platform === "mac" ? "bossmate-agent-Mac.zip"
      : "bossmate-agent-client.zip";
    logger.info({ tenantId: request.tenantId, platform, files: entries.length, bytes: zip.length }, "agent 客户端启动包已打包");
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${fname}"`)
      .send(zip);
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
    // PR-A16: 各设备绑定的账号 (登录态持有关系), 一次查全租户再按设备归组
    const boundAccounts = await db
      .select({
        deviceId: platformAccounts.agentDeviceId,
        accountName: platformAccounts.accountName,
        platform: platformAccounts.platform,
      })
      .from(platformAccounts)
      .where(eq(platformAccounts.tenantId, request.tenantId));
    const accountsByDevice = new Map<string, Array<{ accountName: string; platform: string }>>();
    for (const a of boundAccounts) {
      if (!a.deviceId) continue;
      const list = accountsByDevice.get(a.deviceId) ?? [];
      list.push({ accountName: a.accountName, platform: a.platform });
      accountsByDevice.set(a.deviceId, list);
    }
    const now = Date.now();
    return {
      code: "OK",
      data: {
        devices: rows.map((d) => ({
          ...d,
          online: d.status === "active" && !!d.lastSeenAt && now - d.lastSeenAt.getTime() < 90_000,
          accounts: accountsByDevice.get(d.id) ?? [],
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

  /**
   * POST /agent-admin/tasks/:id/finish {action} — PR-W4 人工收口:
   *   published: manual_pending → success (用户已在浏览器点完发布) + 写 publish log
   *   cancel:    pending/manual_pending/failed/login_expired → canceled (清掉不想要的)
   * 没有这个闭环, manual_pending 会永远挂在今日页"等你动手"里。
   */
  app.post("/agent-admin/tasks/:id/finish", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ code: "BAD_REQUEST", message: "id 非法" });
    const body = (request.body ?? {}) as { action?: string };
    const action = body.action === "published" ? "published" : body.action === "cancel" ? "cancel" : null;
    if (!action) return reply.code(400).send({ code: "BAD_REQUEST", message: "action 须为 published | cancel" });

    const [task] = await db
      .select()
      .from(agentPublishTasks)
      .where(and(eq(agentPublishTasks.id, id), eq(agentPublishTasks.tenantId, request.tenantId)))
      .limit(1);
    if (!task) return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });

    if (action === "published") {
      if (task.status !== "manual_pending") {
        return reply.code(409).send({ code: "BAD_STATUS", message: `仅"待人工点发布"的任务可确认已发, 当前为 ${task.status}` });
      }
      await db.update(agentPublishTasks)
        .set({ status: "success", error: null, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentPublishTasks.id, task.id));
      await db.insert(contentPublishLog)
        .values({ tenantId: task.tenantId, contentId: task.contentId, accountId: task.accountId, status: "success", initiatedBy: "agent" })
        .onConflictDoUpdate({
          target: [contentPublishLog.contentId, contentPublishLog.accountId],
          set: { status: "success", initiatedBy: "agent", updatedAt: new Date() },
        });
      return { code: "OK", data: { id: task.id, status: "success" } };
    }

    // cancel
    const cancelable = new Set(["pending", "manual_pending", "failed", "login_expired"]);
    if (!cancelable.has(task.status)) {
      return reply.code(409).send({ code: "BAD_STATUS", message: `状态 ${task.status} 不可取消` });
    }
    await db.update(agentPublishTasks)
      .set({ status: "canceled", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentPublishTasks.id, task.id));
    return { code: "OK", data: { id: task.id, status: "canceled" } };
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
