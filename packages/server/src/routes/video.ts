/**
 * 视频 API 路由
 *
 * POST /video/upload-images   上传图片素材
 * POST /video/dvh-background  上传数字人视频背景图(9:16/16:9 强校验 + 内容审核, 返回公网 URL;
 *                             saveToLibrary=1 时顺手存进系统背景图库)
 * POST /video/dvh-estimate    口播稿费用预估(字数/秒数/元) + 内容安全预检, 不花钱
 * POST /video/dvh-from-text   7-30 文字稿直生数字人视频(运营手写口播稿, 不走文章链路)
 * POST /video/compose         创建视频合成任务
 * GET  /video/status/:jobId   查询合成进度
 * GET  /video/list            获取视频列表(type='video', 直生视频自动在内, 无需改)
 * GET  /video/bgm-list        获取预置 BGM 列表
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";
import { storage } from "../services/storage/index.js";
import { videoQueue } from "../services/task/queue.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import { requirePermission } from "../middleware/permission.js";
import type { VideoJobData } from "../services/task/video-worker.js";

const MIME_WHITELIST = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 7-30 口播稿字数闸。
 *
 * 上限 600: 与文章链路 extractNarration 的 `slice(0, 600)` 对齐(同一个 produceVideo,
 *   不该有两个尺度)。换算: 3.3 字/秒 → 600 字 ≈ 182 秒 ≈ 30 元 —— 这是**单条封顶**。
 * 🔴 在这之前 submitDvhTask 对 text 是**零校验**的: 粘 5000 字进去照样提交, 按秒计费,
 *   一条视频 250 元起, 而且是 submit 那一刻就扣掉、拦不回来。
 * 下限 50: 低于这个字数出片不足 15 秒, 没有成品价值, 但一样按 30 秒预估扣钱 —— 多半是误操作。
 */
export const DVH_TEXT_MIN_CHARS = 50;
export const DVH_TEXT_MAX_CHARS = 600;

const dvhFromTextSchema = z.object({
  text: z.string().trim()
    .min(DVH_TEXT_MIN_CHARS, `口播稿至少 ${DVH_TEXT_MIN_CHARS} 字(太短出片不足 15 秒, 但一样要花钱)`)
    .max(DVH_TEXT_MAX_CHARS, `口播稿最多 ${DVH_TEXT_MAX_CHARS} 字(约 3 分钟 / 30 元封顶)。更长的稿子请拆成多条视频`),
  title: z.string().trim().max(60).optional(),
  templateId: z.string().min(1, "请选择数字人形象"),
  voiceId: z.string().max(120).optional(),
  backgroundUrl: z.string().max(500).optional(),
  idempotencyKey: z.string().max(120).optional(),
});

// 预估接口的上限放宽到 5000: 运营粘超长稿时也要能看到"你现在 3200 字, 超了", 而不是接口直接报错。
const dvhEstimateSchema = z.object({
  text: z.string().max(5000).default(""),
  title: z.string().max(200).optional(),
});

const composeSchema = z.object({
  title: z.string().min(1).max(100),
  images: z.array(z.object({
    remotePath: z.string().min(1),
    durationMs: z.number().int().min(2000).max(15000).optional(),
    title: z.string().max(50).optional(),
    subtitle: z.string().max(100).optional(),
    animation: z.enum(["kenburns_in", "kenburns_out", "pan_left", "pan_right", "static"]).optional(),
  })).min(1).max(15),
  bgmId: z.enum(["gentle", "business", "upbeat"]).optional(),
  resolution: z.enum(["1080x1920", "1920x1080"]).optional(),
  transition: z.enum(["fade", "dissolve", "none"]).optional(),
});

export async function videoRoutes(app: FastifyInstance) {

  /**
   * GET /video/bgm-list — 预置 BGM 列表
   */
  app.get("/bgm-list", async () => {
    return {
      code: "OK",
      data: [
        { id: "gentle", name: "轻音乐", description: "舒缓轻音乐，适合产品展示" },
        { id: "business", name: "商务", description: "专业商务风，适合企业宣传" },
        { id: "upbeat", name: "节奏感", description: "轻快节奏，适合促销活动" },
      ],
    };
  });

  /**
   * POST /video/upload-images — 上传图片素材
   */
  app.post("/upload-images", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const parts = request.parts();
      const uploaded: Array<{ remotePath: string; url: string; width: number; height: number; sizeBytes: number }> = [];

      for await (const part of parts) {
        if (part.type !== "file") continue;

        // MIME 白名单校验
        if (!MIME_WHITELIST.has(part.mimetype)) {
          return reply.code(400).send({ code: "INVALID_TYPE", message: `不支持的图片格式: ${part.mimetype}` });
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of part.file) {
          totalSize += chunk.length;
          if (totalSize > MAX_FILE_SIZE) {
            return reply.code(400).send({ code: "FILE_TOO_LARGE", message: `图片超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制` });
          }
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);

        // sharp 校验 + 读取尺寸
        let meta: sharp.Metadata;
        try {
          meta = await sharp(buf).metadata();
        } catch {
          return reply.code(400).send({ code: "INVALID_IMAGE", message: "无法识别的图片文件" });
        }

        // 上传到 storage
        const ext = part.mimetype === "image/png" ? "png" : part.mimetype === "image/webp" ? "webp" : "jpg";
        const remotePath = `${tenantId}/video-images/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const url = await storage.upload(buf, remotePath, part.mimetype);

        uploaded.push({
          remotePath,
          // 7-29: storage.upload 的返回值(OSS 公共读裸 URL / 本地相对路径)原来被丢掉了。
          //   纯增量字段, 老调用方(VideoCreationPage → /video/compose 用 remotePath)不受影响。
          url,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          sizeBytes: buf.length,
        });
      }

      if (uploaded.length === 0) {
        return reply.code(400).send({ code: "NO_IMAGES", message: "请至少上传一张图片" });
      }

      return { code: "OK", data: { images: uploaded } };
    } catch (err) {
      logger.error({ err }, "图片上传失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "图片上传失败" });
    }
  });

  /**
   * POST /video/dvh-background — 7-29 运营为「本次数字人生成」上传本地背景图。
   *
   * 与 /upload-images 的区别(所以单开一个而不是加参数):
   *   - 强制 9:16 / 16:9 宽高比 + 短边 ≥720 (DVH submit 即扣费, 比例错了钱就白花)
   *   - 强制图片内容审核(背景图会进公开视频)
   *   - 返回**公网 URL** 而不是 remotePath —— 阿里云要自己去拉这张图
   * 默认**不进系统图库**(那是管理员的 /admin/dvh-backgrounds), 只供本次生成使用。
   *
   * 7-29 saveToLibrary: 勾了「存入背景图库,下次直接选」就顺手入库(不限管理员 —— 见下)。
   *   - 参数从 query(?saveToLibrary=1) **和** multipart 字段两边都读: multipart 是流式的,
   *     字段排在文件后面时读到文件时还不知道要不要入库, 所以先把文件收进内存、把所有 part 走完再决定。
   *   - 权限: 运营也能存。图库本来就是共享资产, 运营才是天天用背景的人; 挡在 adminOnly 后面
   *     等于"想存得先找老板", 这个功能就白做了。防乱塞靠 addBackgroundToLibrary 里的
   *     判重 + 60 张上限 + uploadedBy 留痕, 而不是靠把人挡在门外。
   *   - 入库的图直接落 SYSTEM 目录(scope=system): 决定入库是在**上传之前**就知道的,
   *     所以是一次上传写对位置, 不需要 OSS 拷贝+删除; 也不会出现"图库条目指向某个租户目录"
   *     这种日后清租户对象就失效的埋雷。
   *   - ⚠️ 入库路径与临时路径共用同一个 processBackgroundUpload(尺寸校验 + 内容审核),
   *     没有第二条写入口 —— 勾选存入图库绕不过任何一道闸。
   */
  app.post("/dvh-background", async (request, reply) => {
    const {
      processBackgroundUpload, BackgroundUploadError,
      hashBackgroundBuffer, findLibraryBackgroundByHash, addBackgroundToLibrary,
    } = await import("../services/digital-human/background-library.js");
    const truthy = (v: unknown) => v === true || v === "1" || v === "true" || v === "on" || v === "yes";
    try {
      const tenantId = request.tenantId;
      const q = (request.query ?? {}) as Record<string, unknown>;
      let saveToLibrary = truthy(q.saveToLibrary);
      let buf: Buffer | null = null;
      let mimetype = "";
      let filename = "";

      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "saveToLibrary" && truthy(part.value)) saveToLibrary = true;
          continue;
        }
        // 只收第一张 — 一次生成只有一个背景; 多余的文件流要 resume 掉, 否则迭代器卡住
        if (buf) { part.file.resume(); continue; }
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.file) {
          total += (chunk as Buffer).length;
          if (total > 10 * 1024 * 1024) {
            return reply.code(400).send({ code: "FILE_TOO_LARGE", message: "背景图超过 10MB 限制" });
          }
          chunks.push(chunk as Buffer);
        }
        buf = Buffer.concat(chunks);
        mimetype = part.mimetype;
        filename = part.filename || "";
      }

      if (!buf) return reply.code(400).send({ code: "NO_IMAGES", message: "请选择一张背景图" });

      // 勾了入库: 先按内容指纹查一下图库里有没有同一张 —— 有就直接复用那条,
      //   既不重复占一格, 也省掉一次 OSS 写入。(复用的是已过审的条目, 不是新内容进库)
      if (saveToLibrary) {
        const hit = await findLibraryBackgroundByHash(hashBackgroundBuffer(buf));
        if (hit) {
          return {
            code: "OK",
            data: {
              url: hit.url, width: hit.width, height: hit.height, orientation: hit.orientation,
              ...(hit.remotePath ? { remotePath: hit.remotePath } : {}),
              savedToLibrary: true, libraryStatus: "duplicate",
              libraryMessage: `图库里已经有同一张图了(「${hit.name}」), 直接选它就行`,
            },
          };
        }
      }

      const r = await processBackgroundUpload({
        buffer: buf, mimetype, tenantId, scope: saveToLibrary ? "system" : "tenant",
      });

      let library: { savedToLibrary: boolean; libraryStatus?: string; libraryMessage?: string } = { savedToLibrary: false };
      if (saveToLibrary) {
        const add = await addBackgroundToLibrary({
          processed: r,
          name: filename.replace(/\.[^.]+$/, "").slice(0, 40) || "背景",
          uploadedBy: request.user?.userId,
          source: "generate",
        });
        library = {
          savedToLibrary: add.status === "added" || add.status === "duplicate",
          libraryStatus: add.status,
          ...(add.message ? { libraryMessage: add.message } : {}),
        };
      }

      return {
        code: "OK",
        data: {
          url: r.url, width: r.width, height: r.height, orientation: r.orientation, remotePath: r.remotePath,
          ...library,
        },
      };
    } catch (err) {
      if (err instanceof BackgroundUploadError) {
        return reply.code(400).send({ code: err.code, message: err.message });
      }
      logger.error({ err }, "DVH 背景图上传失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "背景图上传失败" });
    }
  });

  /**
   * POST /video/dvh-estimate — 7-30 口播稿费用预估 + 内容安全预检。**不花一分钱, 不写库**。
   *
   * 为什么需要它: estimateDvhCents 这个能力此前只在服务端当预算闸用, 前端 0 处显示费用。
   *   文章链路无所谓(字数是 AI 按规格写的, 运营控制不了也不用管); 文字稿直生把字数控制权
   *   交给了运营 —— 没有这个数字, 运营对"我多写 200 字要多花 10 块钱"完全无感。
   * 顺带回内容安全预检(纯内存那两道), 让红线词在打字时就红, 而不是点了生成才被拒。
   */
  app.post("/dvh-estimate", async (request, reply) => {
    try {
      const body = dvhEstimateSchema.parse(request.body ?? {});
      const { estimateDvhFromText } = await import("../services/billing/cost-ledger.js");
      const { checkNarrationSafetyPure } = await import("../services/digital-human/narration-guard.js");
      const text = body.text.trim();
      const est = estimateDvhFromText(text);
      // 空文本不跑安全检查(没内容可查, 也免得刚打开弹窗就报红)
      const safety = text ? checkNarrationSafetyPure(text, body.title) : null;
      return {
        code: "OK",
        data: {
          chars: est.chars,
          seconds: est.seconds,
          cents: est.cents,
          yuan: Math.round(est.cents) / 100,
          minChars: DVH_TEXT_MIN_CHARS,
          maxChars: DVH_TEXT_MAX_CHARS,
          tooShort: est.chars > 0 && est.chars < DVH_TEXT_MIN_CHARS,
          tooLong: est.chars > DVH_TEXT_MAX_CHARS,
          blocked: safety ? !safety.ok : false,
          ...(safety?.message ? { blockMessage: safety.message } : {}),
          // 预估口径: 3.3 字/秒(5月实测), 不足 30 秒按 30 秒算(高报方向)。真实账单按出片实际秒数。
          note: "按 3.3 字/秒估算, 最低按 30 秒计; 实际以出片秒数结算 (0.165 元/秒)",
        },
      };
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return reply.code(400).send({ code: "VALIDATION_ERROR", message: err.errors?.[0]?.message || "参数校验失败" });
      }
      logger.error({ err }, "DVH 费用预估失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "费用预估失败" });
    }
  });

  /**
   * POST /video/dvh-from-text — 7-30 文字稿直生数字人视频。
   *
   * 运营自己写好口播稿 → 直接出片, 不生成文章、不查期刊、不调 LLM。
   * 落库就是 contents 里一条 type='video'(与文章链路同一张表同一形态), 所以
   * GET /video/list、内容管理、分发链路全部零改动就能看到这条视频。
   *
   * 校验顺序是**按"越便宜越靠前 / 越不可逆越靠后"排的**, submit 一旦发出钱就扣了:
   *   1. 字数(纯内存, 最便宜)      → 400
   *   2. 形象目录 / DVH 凭证        → 400 / 503
   *   3. 背景图白名单               → 400
   *   4. 🔴 内容安全三道闸           → 400   ← 必须在花钱之前, 生成完才发现就晚了
   *   5. 套餐闸(到期/月配额)         → 403
   *   6. 预算闸(日/月上限)           → 403
   *   7. 🔴 在途锁(防双击)           → 409   ← 最后一道, 抢到就必然进 produceVideo
   * 与 /articles/:id/generate-dvh-video 的校验整体一致(那边是抄的源), 差别只在
   * 多了 1、4 两道 —— 那两道是"文本由人手写"独有的风险。
   */
  app.post("/dvh-from-text", { preHandler: requirePermission("content.write") }, async (request, reply) => {
    let body: z.infer<typeof dvhFromTextSchema>;
    try {
      body = dvhFromTextSchema.parse(request.body ?? {});
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return reply.code(400).send({ code: "VALIDATION_ERROR", message: err.errors?.[0]?.message || "参数校验失败" });
      }
      throw err;
    }

    const tenantId = request.tenantId;
    const { text, title, idempotencyKey } = body;

    try {
      // ---- 2. 形象目录 + DVH 凭证 (整段与 articles.ts 同口径) ----
      const { resolveAvatarVoice } = await import("../services/digital-human/template-mapping.js");
      if (!(await resolveAvatarVoice(body.templateId))) {
        return reply.code(400).send({
          code: "NO_TEMPLATE_ID",
          message: `templateId 缺失或不在形象目录中 (${body.templateId})`,
        });
      }
      const { isRealMode } = await import("../services/digital-human/client.js");
      if (isRealMode() && (!process.env.DVH_TENANT_ID || !process.env.DVH_APP_ID)) {
        return reply.code(503).send({
          code: "NO_DVH",
          message: "DVH_REAL_MODE=true 但 DVH_TENANT_ID / DVH_APP_ID 缺失",
        });
      }

      // 7-10 音色库: 单次生成临时换音色(库内 voice_id 白名单化)
      const { sanitizeVoiceOverride } = await import("../services/voice/catalog-utils.js");
      const voiceId = sanitizeVoiceOverride(body.voiceId);

      // ---- 3. 背景图: 只收系统图库 / 我们自己桶里的图 / "none" ----
      let backgroundUrl: string | undefined;
      if (body.backgroundUrl && body.backgroundUrl.trim()) {
        const { validateGenerationBackgroundUrl } = await import("../services/digital-human/background-library.js");
        const v = await validateGenerationBackgroundUrl(body.backgroundUrl);
        if (!v.ok) return reply.code(400).send({ code: "BAD_BACKGROUND_URL", message: v.message });
        backgroundUrl = v.value;
      }

      // ---- 4. 🔴 口播稿内容安全 (敏感词库 + 高危违禁 + 行业红线) ----
      const { checkNarrationSafety } = await import("../services/digital-human/narration-guard.js");
      const safety = await checkNarrationSafety(text, title);
      if (!safety.ok) {
        logger.warn({ tenantId, code: safety.code, chars: text.length }, "dvh.text.blocked_by_content_gate");
        return reply.code(400).send({ code: safety.code, message: safety.message });
      }

      // ---- 5. PR-Z4 套餐闸: 到期 / 月视频配额 ----
      {
        const { checkBilling, logBillingDenied } = await import("../services/billing/plan.js");
        const bill = await checkBilling(tenantId, "generate_video");
        if (!bill.allowed) {
          logBillingDenied(tenantId, "generate_video", bill.reason);
          return reply.code(403).send({ code: "BILLING_LIMIT", message: bill.reason });
        }
      }

      // ---- 6. PR-W1 预算闸: fire-and-forget 之前先查, 超限给看得见的 403 ----
      //   用 estimateDvhFromText(无 120 秒钳位)而不是 estimateDvhCents —— 600 字被钳到
      //   120 秒会把 30 元报成 19.8 元, 预算闸就漏放了。
      const { estimateDvhFromText } = await import("../services/billing/cost-ledger.js");
      const estimate = estimateDvhFromText(text);
      {
        const { checkBudget } = await import("../services/billing/cost-ledger.js");
        const gate = await checkBudget(tenantId, estimate.cents);
        if (!gate.allowed) {
          return reply.code(403).send({ code: "BUDGET_EXCEEDED", message: gate.reason });
        }
      }

      // ---- 7. 🔴 在途锁: 抢到才发车。抢不到 = 同一份稿子同一套参数已经在生成中 ----
      //   注意这里是 fire-and-forget: 不先同步抢锁的话, 双击的第二次也会拿到 200 "已触发",
      //   运营以为成了、实际什么都没发生(或者更糟: 真发了两条 = 两份钱)。
      const { buildDvhTextSlotKeys, acquireDvhTextSlots, releaseDvhTextSlots, triggerDvhFromText } =
        await import("../services/digital-human/text-bridge.js");
      const slotKeys = buildDvhTextSlotKeys({
        tenantId, text, templateId: body.templateId,
        ...(voiceId ? { voiceId } : {}),
        ...(backgroundUrl ? { backgroundUrl } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if (!acquireDvhTextSlots(slotKeys)) {
        logger.info({ tenantId, templateId: body.templateId }, "dvh.text.duplicate_request_rejected");
        return reply.code(409).send({
          code: "DUPLICATE_REQUEST",
          message: "同一份口播稿正在生成中, 请勿重复提交(生成约需 1-5 分钟, 完成后在「内容管理 → 视频」查看)",
        });
      }
      // ⚠️ acquire 与 void trigger 之间不许再插任何 await/校验 —— 中间插东西就可能抢了锁却没发车, 把这份稿子锁死 20 分钟。
      try {
        void triggerDvhFromText({
          db, tenantId, userId: request.user.userId,
          text, templateId: body.templateId, slotKeys,
          ...(title ? { title } : {}),
          ...(voiceId ? { voiceId } : {}),
          ...(backgroundUrl ? { backgroundUrl } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(safety.softHits.length ? { complianceSoftHits: safety.softHits } : {}),
        });
      } catch (e) {
        releaseDvhTextSlots(slotKeys);
        throw e;
      }

      logger.info(
        { tenantId, templateId: body.templateId, chars: text.length, estimateCents: estimate.cents, backgroundUrl },
        "7-30 user-triggered text→DVH",
      );
      return {
        code: "OK",
        data: {
          status: "triggered",
          templateId: body.templateId,
          chars: estimate.chars,
          estimateSeconds: estimate.seconds,
          estimateYuan: estimate.cents / 100,
          ...(safety.softHits.length ? { softHits: safety.softHits } : {}),
        },
      };
    } catch (err) {
      logger.error({ err, tenantId }, "文字稿直生数字人视频失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "触发生成失败" });
    }
  });

  /**
   * POST /video/compose — 创建视频合成任务
   */
  app.post("/compose", async (request, reply) => {
    try {
      const tenantId = request.tenantId;
      const userId = request.user.userId;
      const body = composeSchema.parse(request.body);

      // 租户隔离：remotePath 必须以 tenantId/ 开头
      for (const img of body.images) {
        if (!img.remotePath.startsWith(`${tenantId}/`)) {
          return reply.code(403).send({ code: "FORBIDDEN", message: "不允许访问其他租户的资源" });
        }
      }

      // 总时长校验
      const totalSec = body.images.reduce((s, img) => s + (img.durationMs ?? 4000) / 1000, 0);
      if (totalSec > env.VIDEO_MAX_DURATION_SEC) {
        return reply.code(400).send({ code: "TOO_LONG", message: `视频总时长不能超过 ${env.VIDEO_MAX_DURATION_SEC} 秒` });
      }

      // 每 tenant 并发限制
      const activeJobs = await videoQueue.getJobs(["active", "waiting"]);
      const tenantJobCount = activeJobs.filter((j: any) => j.data?.tenantId === tenantId).length;
      if (tenantJobCount >= env.VIDEO_TENANT_MAX_CONCURRENT) {
        return reply.code(429).send({
          code: "TOO_MANY_JOBS",
          message: `同时最多 ${env.VIDEO_TENANT_MAX_CONCURRENT} 个视频在合成中，请等待完成后再试`,
        });
      }

      // P1 图片内容审核: 视频合成前审图片(阿里云内容安全 baselineCheck)。remotePath→签名URL(公网可达)传审核。
      //   block→拒绝合成(记原因返回前端); review→放行(仅记 warn); 审核挂掉走兜底(strict on=拦/off=放行)。
      const { moderateImages, IMAGE_MODERATION_ENABLED } = await import("../services/compliance/image-moderation.js");
      if (IMAGE_MODERATION_ENABLED) {
        try {
          const urls = await Promise.all(body.images.map((i) => storage.getSignedUrl(i.remotePath, 900)));
          const mod = await moderateImages(urls.filter((u) => /^https?:\/\//i.test(u)));
          if (mod.blocked) {
            const bad = mod.results.filter((r) => r.suggestion === "block").map((r) => r.label);
            logger.warn({ tenantId, bad, fallback: mod.fallback }, "图片内容审核: 拦截视频合成");
            return reply.code(400).send({
              code: "IMAGE_MODERATION_BLOCKED",
              message: `图片内容审核未通过, 已拦截合成${bad.length ? `: ${[...new Set(bad)].join("、")}` : ""}`,
            });
          }
          const reviews = mod.results.filter((r) => r.suggestion === "review");
          if (reviews.length > 0) logger.warn({ tenantId, reviews }, "图片内容审核: 可疑放行(review)");
        } catch (err) {
          // moderateImages 自身已兜底, 这里只兜签名URL等前置异常, 不阻塞合成
          logger.warn({ err, tenantId }, "图片内容审核前置异常, 跳过审核放行");
        }
      }

      const jobData: VideoJobData = {
        tenantId,
        userId,
        title: body.title,
        input: {
          tenantId,
          title: body.title,
          images: body.images,
          bgmId: body.bgmId,
          resolution: body.resolution,
          transition: body.transition,
        },
      };

      const job = await videoQueue.add("image-to-video", jobData, {
        jobId: `video-${tenantId}-${Date.now()}`,
      });

      logger.info({ jobId: job.id, tenantId, images: body.images.length }, "视频合成任务已入队");

      return reply.code(201).send({
        code: "OK",
        data: {
          jobId: job.id,
          estimatedDurationSec: Math.round(totalSec),
        },
      });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return reply.code(400).send({ code: "VALIDATION_ERROR", message: err.errors?.[0]?.message || "参数校验失败" });
      }
      logger.error({ err }, "创建视频合成任务失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "创建任务失败" });
    }
  });

  /**
   * GET /video/status/:jobId — 查询合成进度
   */
  app.get("/status/:jobId", async (request, reply) => {
    const tenantId = request.tenantId;
    const { jobId } = request.params as { jobId: string };

    const job = await videoQueue.getJob(jobId);
    if (!job) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    }

    // 租户隔离
    if (job.data.tenantId !== tenantId) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "任务不存在" });
    }

    const state = await job.getState();
    const progress = typeof job.progress === "number" ? job.progress : 0;

    return {
      code: "OK",
      data: {
        jobId: job.id,
        status: state,
        progress,
        result: state === "completed" ? job.returnvalue : undefined,
        error: state === "failed" ? job.failedReason : undefined,
      },
    };
  });

  /**
   * GET /video/list — 获取视频列表
   */
  app.get("/list", async (request) => {
    const tenantId = request.tenantId;
    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, parseInt(query.page || "1"));
    const pageSize = Math.min(50, parseInt(query.pageSize || "20"));

    const rows = await db
      .select()
      .from(contents)
      .where(and(eq(contents.tenantId, tenantId), eq(contents.type, "video")))
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      code: "OK",
      data: {
        items: rows.map(r => ({
          id: r.id,
          title: r.title,
          videoUrl: r.body,
          metadata: r.metadata,
          status: r.status,
          createdAt: r.createdAt,
        })),
        page,
        pageSize,
      },
    };
  });
}
