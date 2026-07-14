/**
 * P1 图片内容审核 — 商业化前唯一实质合规缺口收尾。
 *
 * 调阿里云内容安全「图片审核 2.0」ImageModeration(green20220302), Service=baselineCheck
 *   (基线检测: 涉黄 / 暴恐 / 违禁 / 不良场景等)。走 @alicloud/openapi-client 通用 callApi(RPC),
 *   不引专用 green SDK(复用已装的 openapi-client + credentials + tea-util, 免新增依赖/锁文件)。
 *
 * 结果映射(同 content-check 文本合规 blocked/hits 风格):
 *   suggestion=block(违规) → 拦截发布; review(可疑) → 警告放行 + 记 metadata; pass → 放行。
 *
 * 失败兜底: 审核 API 挂/超时 → 不阻塞发布(记 warn + 标 skipped_error), 避免审核服务抖动就发不出内容。
 *   env IMAGE_MODERATION_STRICT=true 时反转为「失败即拦截」(合规要求高时开)。
 * 总开关 env IMAGE_MODERATION_ENABLED(默认 true)。
 */
import * as $OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";
import Credential, * as $Credential from "@alicloud/credentials";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export type ImageSuggestion = "block" | "review" | "pass";

export interface ImageModerationItem {
  url: string;
  label: string;
  suggestion: ImageSuggestion;
  score: number;
}

export interface ImageModerationOutcome {
  blocked: boolean;
  results: ImageModerationItem[];
  /** 审核服务不可用时的兜底态(strict=false 放行 / true 拦截); 正常审核为 undefined */
  fallback?: "skipped_error";
}

export const IMAGE_MODERATION_ENABLED = env.IMAGE_MODERATION_ENABLED;

/**
 * CJS interop: @alicloud/* 包 default 在 .default 上(见 digital-human/client.ts PR #237 教训)。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapCtor<T>(mod: T): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mod as any;
  return typeof m === "function" ? m : m?.default ?? m;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createGreenClient(): any {
  if (_client) return _client;
  const akId = process.env.ALIYUN_ACCESS_KEY_ID ?? process.env.ALIYUN_AK_ID;
  const akSecret = process.env.ALIYUN_ACCESS_KEY_SECRET ?? process.env.ALIYUN_AK_SECRET;
  if (!akId || !akSecret) throw new Error("图片审核: ALIYUN_ACCESS_KEY_ID / SECRET 缺失");
  const CredentialCtor = unwrapCtor(Credential);
  const ClientCtor = unwrapCtor($OpenApi.default);
  const credential = new CredentialCtor(
    new $Credential.Config({ type: "access_key", accessKeyId: akId, accessKeySecret: akSecret }),
  );
  const config = new $OpenApi.Config({ credential });
  config.endpoint = env.IMAGE_MODERATION_ENDPOINT;
  _client = new ClientCtor(config);
  return _client;
}

/** 从 HTML 正文 + 可选封面 URL 收集需审核的公网图片 URL(去重, 仅 http(s), 忽略 data: 内联 SVG 图表) */
export function extractImageUrls(html: string | null | undefined, coverUrl?: string | null): string[] {
  const urls = new Set<string>();
  if (coverUrl && /^https?:\/\//i.test(coverUrl)) urls.add(coverUrl);
  if (html) {
    const re = /<img[^>]+src\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) urls.add(m[1]);
  }
  return [...urls].slice(0, env.IMAGE_MODERATION_MAX_IMAGES);
}

/** 阿里云 ImageModeration 单图返回的 Label → 是否风险标签(nonLabel/normal = 正常) */
function isRiskLabel(label: string): boolean {
  const l = (label || "").toLowerCase();
  return l !== "" && l !== "nonlabel" && l !== "normal" && l !== "none";
}

/** 单图审核: 返回 { label, suggestion, score }。抛错交由上层兜底处理。 */
async function moderateOne(url: string): Promise<{ label: string; suggestion: ImageSuggestion; score: number }> {
  const client = createGreenClient();
  const params = new $OpenApi.Params({
    action: "ImageModeration",
    version: "2022-03-02",
    protocol: "HTTPS",
    pathname: "/",
    method: "POST",
    authType: "AK",
    style: "RPC",
    reqBodyType: "formData",
    bodyType: "json",
  });
  const request = new $OpenApi.OpenApiRequest({
    body: {
      Service: "baselineCheck",
      ServiceParameters: JSON.stringify({ imageUrl: url }),
    },
  });
  const runtime = new $Util.RuntimeOptions({
    readTimeout: env.IMAGE_MODERATION_TIMEOUT_MS,
    connectTimeout: env.IMAGE_MODERATION_TIMEOUT_MS,
  });
  const resp = await client.callApi(params, request, runtime);
  const body = (resp?.body ?? {}) as Record<string, any>;
  const code = Number(body.Code ?? body.code);
  if (code !== 200) {
    throw new Error(`ImageModeration Code=${body.Code ?? body.code} Msg=${body.Msg ?? body.msg ?? ""}`);
  }
  const data = (body.Data ?? body.data ?? {}) as Record<string, any>;
  const list: Array<Record<string, any>> = Array.isArray(data.Result ?? data.result) ? (data.Result ?? data.result) : [];
  // 取风险最高的一条(风险标签 + 最高 Confidence)
  let topLabel = "nonLabel";
  let topScore = 0;
  for (const r of list) {
    const label = String(r.Label ?? r.label ?? "");
    const score = Number(r.Confidence ?? r.confidence ?? 0);
    if (isRiskLabel(label) && score >= topScore) {
      topLabel = label;
      topScore = score;
    }
  }
  let suggestion: ImageSuggestion = "pass";
  if (isRiskLabel(topLabel)) {
    if (topScore >= env.IMAGE_MODERATION_BLOCK_SCORE) suggestion = "block";
    else if (topScore >= env.IMAGE_MODERATION_REVIEW_SCORE) suggestion = "review";
  }
  return { label: topLabel, suggestion, score: topScore };
}

/** 简单并发限流器: 分批跑, 每批 ≤ concurrency */
async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

/**
 * 批量审核图片 URL。
 * @param urls 公网可达的图片 URL 列表(OSS 公共读 / 签名 URL)
 * @returns blocked=有任一 block; results 每图映射; fallback=审核挂掉时的兜底态
 */
export async function moderateImages(urls: string[]): Promise<ImageModerationOutcome> {
  const list = [...new Set((urls || []).filter((u) => /^https?:\/\//i.test(u)))];
  if (list.length === 0) return { blocked: false, results: [] };

  try {
    const raw = await mapLimit(list, env.IMAGE_MODERATION_CONCURRENCY, async (url) => {
      try {
        const r = await moderateOne(url);
        return { url, ...r };
      } catch (err) {
        // 单图失败: 冒泡给整体兜底(不在此吞, 保证 strict 语义一致)
        throw err;
      }
    });
    const results: ImageModerationItem[] = raw;
    const blocked = results.some((r) => r.suggestion === "block");
    return { blocked, results };
  } catch (err) {
    // 审核服务挂/超时 → 兜底: strict=false 放行(记 warn), strict=true 拦截
    logger.warn({ err: err instanceof Error ? err.message : err, count: list.length, strict: env.IMAGE_MODERATION_STRICT }, "图片内容审核失败, 走兜底策略");
    if (env.IMAGE_MODERATION_STRICT) {
      return {
        blocked: true,
        fallback: "skipped_error",
        results: list.map((url) => ({ url, label: "moderation_error", suggestion: "block" as const, score: 0 })),
      };
    }
    return {
      blocked: false,
      fallback: "skipped_error",
      results: list.map((url) => ({ url, label: "moderation_error", suggestion: "pass" as const, score: 0 })),
    };
  }
}
