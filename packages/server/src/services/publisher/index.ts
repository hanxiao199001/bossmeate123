/**
 * 统一发布服务
 *
 * 架构：Publisher (统一入口) → PlatformAdapter (各平台适配器)
 * 支持：微信公众号、百家号、头条号、知乎、小红书
 */

import { db } from "../../models/db.js";
import { platformAccounts, contents, distributionRecords, journals } from "../../models/schema.js";
import { eq, and, or } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { transitionToStatus, InvalidTransitionError } from "../articles/state-machine.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { WechatAdapter } from "./adapters/wechat.js";
import { BaijiahaoAdapter } from "./adapters/baijiahao.js";
import { ToutiaoAdapter } from "./adapters/toutiao.js";
import { ZhihuAdapter } from "./adapters/zhihu.js";
import { XiaohongshuAdapter } from "./adapters/xiaohongshu.js";
import { DouyinAdapter } from "./adapters/douyin.js";
import { WechatVideoAdapter } from "./adapters/wechat-video.js";
import { hydrateAccount, decryptCredentialField } from "./credentials-loader.js";
import { AGENT_PLATFORMS, dispatchVideoToAgent } from "./agent-dispatch.js";
import { auditContent, type AuditHit } from "../risk-control/audit-content.js";
import {
  getLeadCaptureConfig,
  articleLeadCaptureText,
  articleLeadCaptureHtml,
  videoLeadCaptureText,
  xiaohongshuLeadCaptureText,
} from "./lead-capture.js";

// ===== 类型定义 =====
export interface PublishRequest {
  contentId: string;
  tenantId: string;
  accountIds: string[]; // 要发布到的账号ID列表
  options?: {
    author?: string;
    digest?: string;
    coverImageUrl?: string;
  };
  // 5-20 P2 风控: 默认 false → 触发 audit gate; true → 跳过 (用户已二次确认强制放行)
  forceOverride?: boolean;
  overrideReason?: string; // 强制放行原因 (审计留底)
  userId?: string; // 审计"谁强发"用; 缺省 unknown
  /** 7-05 ⑤: 强制只建草稿(微信 draft/add), 无视账号 capability=full — 草稿箱分发用, 保证绝不误群发 */
  capabilityOverride?: "draft_only";
}

export interface PublishResult {
  accountId: string;
  accountName: string;
  platform: string;
  success: boolean;
  /** 发布模式: full=自动群发 / draft_only=仅建草稿需人工发送 / undefined=适配器未区分 */
  mode?: "full" | "draft_only";
  /** 6-22: true=仅"派单"给本地客户端(抖音/视频号), 还没真发布 — 上层须区分展示为"已派单·待发布", 不能当成功 */
  dispatched?: boolean;
  publishId?: string;
  mediaId?: string;
  url?: string;
  /** 公众号后台草稿箱入口（仅 draft_only 模式下返回） */
  draftUrl?: string;
  /** 成功/提示文案（draft_only 下会包含"请到后台手动发送"指引） */
  message?: string;
  error?: string;
  // 5-20 P2 风控扩展（非破坏性 optional）
  status?: "blocked"; // 风控拦截标记 (仅 audit gate 拦下时填)
  reason?: string;    // 拦截原因人类可读
  riskHits?: AuditHit[]; // 该 platform 的具体禁词命中 (frontend 用于 modal 展示)
}

export interface PlatformAdapter {
  platform: string;

  /** 验证账号凭证是否有效 */
  verifyCredentials(credentials: Record<string, any>): Promise<{ valid: boolean; error?: string }>;

  /** 发布内容 */
  publish(params: {
    credentials: Record<string, any>;
    title: string;
    content: string;
    author?: string;
    digest?: string;
    coverImageUrl?: string;
    metadata?: Record<string, any>;
    /** 发布能力（仅 wechat 目前区分）。其他平台可忽略。 */
    capability?: "full" | "draft_only";
  }): Promise<{
    success: boolean;
    mode?: "full" | "draft_only";
    publishId?: string;
    mediaId?: string;
    url?: string;
    draftUrl?: string;
    message?: string;
    error?: string;
  }>;
}

// ===== 适配器注册 =====
const adapters: Record<string, PlatformAdapter> = {
  wechat: new WechatAdapter(),
  baijiahao: new BaijiahaoAdapter(),
  toutiao: new ToutiaoAdapter(),
  zhihu: new ZhihuAdapter(),
  xiaohongshu: new XiaohongshuAdapter(),
  douyin: new DouyinAdapter(),
  wechat_video: new WechatVideoAdapter(),
};

export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters[platform];
}

export function getSupportedPlatforms() {
  return Object.keys(adapters);
}

// ===== 统一发布入口 =====

/**
 * 批量发布内容到多个账号
 */
export async function publishToAccounts(req: PublishRequest): Promise<PublishResult[]> {
  const { contentId, tenantId, accountIds, options } = req;

  // 1. 获取内容（跟 GET /content READABLE_TENANT_FILTER 一致：放开 system 推荐文章，
  //    让用户能发布每日推荐 feed 里的共享文章；非 owner 不会改其全局 status，见 step 4 guard）
  const [content] = await db
    .select()
    .from(contents)
    .where(and(
      eq(contents.id, contentId),
      or(eq(contents.tenantId, tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID)),
    ))
    .limit(1);

  if (!content) {
    throw new Error("内容不存在");
  }

  if (!content.title || !content.body) {
    throw new Error("内容标题和正文不能为空");
  }

  // PR-Z3 合规层: 硬词拦截(封号级风险), 软词(广告法/医疗红线)警告放行; 发布体追加 AI 生成标识
  const { checkCompliance, appendAiLabel } = await import("../compliance/content-check.js");
  const compliance = await checkCompliance(`${content.title}\n${content.body}`);
  if (compliance.blocked) {
    throw new Error(`内容未通过合规检查, 已拦截发布。命中高危词: ${compliance.hardHits.join("、")}`);
  }
  if (compliance.softHits.length > 0) {
    logger.warn({ contentId, softHits: compliance.softHits }, "PR-Z3 软词警告(广告法/医疗红线), 放行但建议人工复核");
  }

  // 发布期数据编造硬闸: 生成期已标 needs_review / hasWarnings 的内容, 发布前重跑 checkTitleDataConsistency(复用),
  //   标题审稿周期/录用率数字无 DB 支撑 = 编造 → 拒发(列无源数字); 除非 forceOverride 强发, 强发落审计。
  //   同客服线 findUnsourcedNumbers 哲学: LLM 嘴里的数字必须有源, 校验拦住它编。违禁词硬拦(上方)不变; 正常内容(非 flagged)零触发。
  const _cMeta = (content.metadata || {}) as Record<string, any>;
  if (content.status === "needs_review" || _cMeta.hasWarnings === true) {
    const { fabricationPublishGate } = await import("../compliance/content-check.js");
    // 取该刊 DB 字段做硬校验(字段空=标题该数字必编造); 无 journalId 则不传, 退化为标题-正文复现校验
    let dbFields: { reviewCycle?: string | null; acceptanceRate?: number | null } | undefined;
    if (_cMeta.journalId) {
      const [jr] = await db.select({ reviewCycle: journals.reviewCycle, acceptanceRate: journals.acceptanceRate })
        .from(journals).where(eq(journals.id, _cMeta.journalId)).limit(1);
      if (jr) dbFields = { reviewCycle: jr.reviewCycle, acceptanceRate: jr.acceptanceRate };
    }
    const gate = fabricationPublishGate({
      status: content.status, hasWarnings: _cMeta.hasWarnings === true,
      title: content.title, body: content.body, dbFields, forceOverride: req.forceOverride,
    });
    if (gate.action === "block") {
      logger.warn({ contentId, status: content.status, mismatches: gate.mismatches }, "发布期数据编造硬闸: 拒发(标题数字无 DB 支撑)");
      throw new Error(`内容含无 DB 支撑的编造数字, 已拦截发布: ${gate.mismatches.join("、")}。如确认无误, 请带 forceOverride 强制发布。`);
    }
    if (gate.action === "override") {
      logger.warn({
        audit: "PUBLISH_FABRICATION_OVERRIDE", who: req.userId ?? "unknown", tenantId, contentId,
        status: content.status, mismatches: gate.mismatches, overrideReason: req.overrideReason ?? null, at: new Date().toISOString(),
      }, "发布期数据编造硬闸: forceOverride 强发, 审计留底");
    }
  }

  // 6-19: 只给图文追加 AI 声明; 视频内容 body 是视频URL, 追加 HTML 会污染成无效路径(Agent 下载 404)。
  if (content.type !== "video") content.body = await appendAiLabel(content.body);

  // 自动提取正文第一张 http 图片作为封面（用于微信 thumb_media_id）
  let autoCoverUrl = options?.coverImageUrl;
  if (!autoCoverUrl && content.body) {
    const imgMatch = content.body.match(/<img[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    if (imgMatch) autoCoverUrl = imgMatch[1];
  }

  // 视频类型内容：从 body（存 video URL）或 metadata 提取 videoUrl
  const contentMeta = (content.metadata || {}) as Record<string, any>;
  const videoUrl = content.type === "video"
    ? (contentMeta.videoUrl || content.body || "")
    : undefined;

  // 7-10 自动封面: 视频内容 body 是纯 mp4 URL, 上面的 <img> 提取必然落空 → 取混剪时抽的片头帧
  //   (video-remix.extractCoverFrame → metadata.coverUrl)。公众号 thumb / 抖音 open-api 封面都吃它;
  //   没有则维持原状(平台自动取首帧)。要求 http(s) 绝对 URL — 适配器要从公网下载。
  if (!autoCoverUrl && content.type === "video" && typeof contentMeta.coverUrl === "string" && /^https?:\/\//i.test(contentMeta.coverUrl)) {
    autoCoverUrl = contentMeta.coverUrl;
  }

  // 2. 获取目标账号
  const accounts = await db
    .select()
    .from(platformAccounts)
    .where(and(
      eq(platformAccounts.tenantId, tenantId),
    ));

  let targetAccounts = accounts.filter(a => accountIds.includes(a.id));

  // 内容类型智能路由：图文→文字平台，视频→视频平台
  const VIDEO_PLATFORMS = new Set(["douyin", "wechat_video"]);
  const ARTICLE_PLATFORMS = new Set(["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu"]);
  if (content.type === "video") {
    const filtered = targetAccounts.filter(a => VIDEO_PLATFORMS.has(a.platform));
    if (filtered.length > 0) targetAccounts = filtered;
    // 如果用户明确选了文字平台发视频，不拦（可能是有意的）
  } else {
    const filtered = targetAccounts.filter(a => ARTICLE_PLATFORMS.has(a.platform));
    if (filtered.length > 0) targetAccounts = filtered;
  }

  if (targetAccounts.length === 0) {
    throw new Error("未找到有效的发布账号");
  }

  // 3. 5-20 P2 风控 audit gate: forceOverride=false (默认) → 扫禁词，命中即拦截整批
  if (!req.forceOverride) {
    const platforms = [...new Set(targetAccounts.map((a) => a.platform))];
    const auditResult = await auditContent({
      content: { title: content.title, body: content.body },
      platforms,
    });
    if (auditResult.summary.totalHits > 0) {
      logger.warn({ contentId, platforms, totalHits: auditResult.summary.totalHits }, "P2 audit gate 拦截发布");
      return targetAccounts.map((acc): PublishResult => ({
        accountId: acc.id,
        accountName: acc.accountName,
        platform: acc.platform,
        success: false,
        status: "blocked",
        reason: `风控拦截: ${auditResult.summary.byPlatform[acc.platform] ?? 0} 个禁词命中`,
        riskHits: auditResult.hits.filter((h) => h.platform === acc.platform),
      }));
    }
  } else {
    logger.info({ contentId, overrideReason: req.overrideReason, accountIds }, "P2 强制放行发布 (跳过 audit gate)");
  }

  // 6-16: 抖音/视频号登录态在客户本机、服务器无凭证 → 派给本地 Agent(建任务), 不走凭证发布。
  // 拆分下沉到此, 所有调 /publish 的入口(工坊直发/今日/详情/workflow)默认都正确。
  const agentTargets = targetAccounts.filter((a) => AGENT_PLATFORMS.has(a.platform));
  const serverTargets = targetAccounts.filter((a) => !AGENT_PLATFORMS.has(a.platform));

  let agentResults: PublishResult[] = [];
  if (agentTargets.length > 0) {
    try {
      const tasks = await dispatchVideoToAgent({
        content: { id: contentId, type: content.type, title: content.title, body: content.body },
        tenantId,
        accounts: agentTargets.map((a) => ({ id: a.id, accountName: a.accountName, platform: a.platform })),
      });
      const has = new Set(tasks.map((t) => t.accountId));
      agentResults = agentTargets.map((a) => ({
        accountId: a.id,
        accountName: a.accountName,
        platform: a.platform,
        success: has.has(a.id),
        dispatched: has.has(a.id), // 6-22: 仅派单成功, 非真发布
        mode: "draft_only" as const,
        message: "已派单·待发布：需该账号已在客户电脑登录、且客户端在线领取后才会真正发布",
      }));
    } catch (err) {
      const error = err instanceof Error ? err.message : "派单失败";
      agentResults = agentTargets.map((a) => ({
        accountId: a.id, accountName: a.accountName, platform: a.platform, success: false, error,
      }));
    }
  }

  // 4. 并发发布到各账号(仅服务器凭证平台; 抖音/视频号已在上面派单)
  const serverResults: PublishResult[] = await Promise.all(
    serverTargets.map(async (account) => {
      const adapter = getAdapter(account.platform);
      if (!adapter) {
        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          success: false,
          error: `不支持的平台: ${account.platform}`,
        };
      }

      try {
        logger.info({
          platform: account.platform,
          accountName: account.accountName,
          contentId,
        }, "开始发布内容");

        const accountCapability = (account as any).capability as ("full" | "draft_only" | undefined);
        // 统一通过 credentials-loader 解密；凭证字段名/加密方案变更只改一处
        let plainCreds: Record<string, any>;
        try {
          plainCreds = decryptCredentialField(account.credentials);
        } catch (err) {
          const error = err instanceof Error ? err.message : "凭证解密失败";
          logger.error({ err, accountId: account.id, platform: account.platform }, "凭证解密失败，跳过该账号发布");
          return {
            accountId: account.id,
            accountName: account.accountName,
            platform: account.platform,
            success: false,
            error: `凭证解密失败：${error}`,
          };
        }
        // 获客组件注入：根据平台类型在内容末尾追加引导文案
        const lcConfig = getLeadCaptureConfig(contentMeta);
        let publishContent = content.body!;
        let publishDigest = options?.digest;

        if (content.type !== "video" && account.platform !== "wechat") {
          // 图文类平台（公众号已有服务卡片，不重复注入）
          if (account.platform === "xiaohongshu") {
            publishContent += xiaohongshuLeadCaptureText(lcConfig);
          } else if (publishContent.includes("<")) {
            // HTML 内容追加 HTML 获客尾部
            publishContent += articleLeadCaptureHtml(lcConfig);
          } else {
            // 纯文本/Markdown 追加文本获客尾部
            publishContent += articleLeadCaptureText(lcConfig);
          }
        }

        if (content.type === "video") {
          // 视频平台：获客文案注入到 digest（视频简介/描述）
          publishDigest = videoLeadCaptureText(lcConfig);
        }

        const result = await adapter.publish({
          credentials: plainCreds,
          title: content.title!,
          content: publishContent,
          author: options?.author,
          digest: publishDigest,
          coverImageUrl: autoCoverUrl,
          metadata: {
            ...(account.metadata as Record<string, any>),
            ...(content.metadata as Record<string, any>),
            ...(videoUrl ? { videoUrl } : {}),
            // douyin OAuth token 刷新落库需要的上下文（其他适配器忽略）
            accountId: account.id,
            tenantId,
          },
          capability: req.capabilityOverride ?? accountCapability,
        });

        // 记录发布结果
        // status: draft_created (仅建草稿) / published (完整群发) / failed
        const recordStatus = result.success
          ? (result.mode === "draft_only" ? "draft_created" : "published")
          : "failed";
        await db.insert(distributionRecords).values({
          tenantId,
          contentId,
          platform: account.platform,
          accountName: account.accountName,
          publishedTitle: content.title,
          status: recordStatus,
          publishedAt: result.success && result.mode !== "draft_only" ? new Date() : undefined,
          publishedUrl: result.url,
          metadata: {
            accountId: account.id,
            publishId: result.publishId,
            mediaId: result.mediaId,
            mode: result.mode,
            draftUrl: result.draftUrl,
            message: result.message,
            error: result.error,
          },
        });

        // 更新账号最后发布时间（draft_only 也算一次"成功投递"）
        if (result.success) {
          await db
            .update(platformAccounts)
            .set({ lastPublishedAt: new Date(), updatedAt: new Date() })
            .where(eq(platformAccounts.id, account.id));
        }

        logger.info({
          platform: account.platform,
          success: result.success,
          error: result.error,
        }, "发布完成");

        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          ...result,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : "发布异常";
        logger.error({ err, platform: account.platform }, "发布异常");

        return {
          accountId: account.id,
          accountName: account.accountName,
          platform: account.platform,
          success: false,
          error,
        };
      }
    })
  );

  const results: PublishResult[] = [...agentResults, ...serverResults];

  // 4. 仅当至少一个账号真的"群发成功"(mode==='full') 才把 content 标 published。
  // draft_only 模式下内容只在微信草稿箱，真正发没发还没定，保留原状态。
  const hasFullPublish = results.some((r) => r.success && r.mode === "full");
  // guard：发布共享 system 推荐文章不改其全局 status（多用户发布同一篇不互相污染）。
  // distributionRecords 已按 caller tenant 独立审计，谁发了什么有独立记录。
  if (hasFullPublish && content.tenantId === tenantId) {
    // P0-A2：publishToWechat（实际群发成功路径）→ transitionToStatus(generated → published)
    try {
      await transitionToStatus(contentId, "published");
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        logger.warn({ contentId, err: err.message }, "P0 publish 状态转移失败（非阻塞，群发已成功）");
      } else {
        throw err;
      }
    }
  }

  return results;
}

/**
 * 验证平台账号凭证
 */
export async function verifyAccountCredentials(
  platform: string,
  credentials: Record<string, any>
): Promise<{ valid: boolean; error?: string }> {
  const adapter = getAdapter(platform);
  if (!adapter) {
    return { valid: false, error: `不支持的平台: ${platform}` };
  }
  return adapter.verifyCredentials(credentials);
}
