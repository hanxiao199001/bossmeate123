/**
 * 5-29 PR #263 — 抖音文案包生成 (半自动发布助手后端).
 *
 * 背景: 抖音对第三方无服务端自动发布到"作品"的通道 (官方政策, 见 memory douyin-open-api).
 *   改半自动: BossMate 生成"文案包"(钩子标题 + 话题 + 引导语 + 可整段复制的 fullText)
 *   → 前端一键复制 → 人手贴进抖音发布页. 0 封号风险, 不卡能力审核.
 *
 * 复用 getProviders LLM (DeepSeek 主 / Qwen 备, 红线#3 锁), 失败规则兜底,
 * 结果缓存进 content.metadata.douyinCaption (force=true 可重生成).
 */
import { and, eq, or } from "drizzle-orm";
import { db } from "../../models/db.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";
import { contents, journals } from "../../models/schema.js";
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";

export interface DouyinCaption {
  hookTitle: string;       // 钩子标题 ≤25 字
  hashtags: string[];      // 纯词, 不含 # 前缀
  lead: string;            // 1 句引导语
  fullText: string;        // 标题 + 引导语 + #话题, 可直接整段复制粘贴
  generatedAt: string;
}

const TITLE_MAX = 55;
const HASHTAG_MAX = 6;
const MAX_VARIANTS = 10;
// PR #265: 同一视频发多号时, 用前缀/引导语池 + 话题轮转造差异, 避免同质化降权
const HOOK_PREFIXES = ["", "干货丨", "实测丨", "建议收藏丨", "亲历丨", "避坑丨", "重磅丨", "科普丨", "经验丨", "提醒丨"];
const LEAD_POOL = ["关注我，了解更多投稿干货", "想发这本期刊的扣1", "全程干货，建议收藏", "评论区聊聊你的投稿经历", "关注追更，少走弯路", "有问题评论区问我", "收藏起来慢慢看", "点赞过百出下期"];

/**
 * 视频平台字面量类型 —— 必须与 PLATFORM_CAPABILITIES 里 contentKind==="video" 的集合相同。
 * (类型无法从运行时 Set 推导, 所以由 __tests__/platform-capabilities.test.ts 的
 *  "视频只往视频平台发" 那条断言盯着两边一致; 加视频平台时这里也要加。)
 */
export type VideoPlatform = "douyin" | "wechat_video";
const WV_LEAD_POOL = ["点赞+在看，支持一下", "关注我们的视频号，持续更新", "想了解更多，私信或评论", "收藏起来，投稿少走弯路", "转发给需要的同门", "关注追更，干货不断"];
function captionField(p: VideoPlatform): string { return p === "wechat_video" ? "wechatVideoCaption" : "douyinCaption"; }
function variantsField(p: VideoPlatform): string { return p === "wechat_video" ? "wechatVideoCaptionVariants" : "douyinCaptionVariants"; }
function captionSys(p: VideoPlatform): string {
  if (p === "wechat_video") return `你是微信视频号运营专家。视频号偏微信生态、稳重专业、不浮夸。给定一条学术期刊推广视频的信息，写一份视频号发布文案包。
**只输出纯 JSON**（不要 markdown 包裹）：
{"hookTitle":"标题 ≤30字","hashtags":["话题1","话题2"],"lead":"1句引导语 ≤30字"}
要求：
- hookTitle 专业可信、有信息量，≤30 字，避免抖音式夸张钩子
- hashtags 1-3 个，纯词不带 # 号，贴近学科与"投稿/发表/科研"
- lead 引导点赞在看或关注，≤30 字`;
  return `你是抖音爆款文案专家。给定一条学术期刊推广视频的信息，写一份抖音发布文案包。
**只输出纯 JSON**（不要 markdown 包裹）：
{"hookTitle":"钩子标题 ≤25字","hashtags":["话题1","话题2","话题3"],"lead":"1句引导语 ≤30字"}
要求：
- hookTitle 有钩子/悬念/数字，口语化，≤25 字
- hashtags 3-6 个，纯词不带 # 号，贴近学科与"投稿/发表/科研"主题
- lead 引导关注或互动，≤30 字`;
}
function variantsSys(p: VideoPlatform, count: number): string {
  const plat = p === "wechat_video" ? "视频号" : "抖音";
  const style = p === "wechat_video" ? "专业稳重、微信生态风、话题1-3个" : "口语化有钩子、话题3-6个";
  return `你是${plat}矩阵运营专家。同一条学术期刊推广视频要发到 ${count} 个不同${plat}号，需要 ${count} 套**互不雷同**的文案，避免平台判定同质化降权。
**只输出纯 JSON 数组**（不要 markdown）：
[{"hookTitle":"标题","hashtags":["话题1","话题2"],"lead":"引导语 ≤30字"}, ...]
要求：
- 共 ${count} 套，每套的角度、话题组合、引导语都要明显不同（不要只换标点）
- 风格：${style}；hashtags 纯词不带#；lead ≤30 字`;
}

function assembleFullText(c: { hookTitle: string; hashtags: string[]; lead: string }): string {
  const tags = c.hashtags
    .map((t) => `#${String(t).replace(/^#/, "").trim()}`)
    .filter((t) => t.length > 1)
    .join(" ");
  return [c.hookTitle, c.lead, tags].filter(Boolean).join("\n");
}

function ruleFallback(args: { title: string; journalName?: string; discipline?: string; platform: VideoPlatform }): DouyinCaption {
  const hookTitle = (args.title || `${args.journalName ?? "学术期刊"}投稿攻略`).slice(0, TITLE_MAX);
  const seeds = [args.discipline, args.journalName, "学术", "科研", "论文发表", "期刊投稿"].filter(Boolean) as string[];
  const hashtags = Array.from(new Set(seeds.map((s) => s.replace(/^#/, "").trim()).filter(Boolean))).slice(0, HASHTAG_MAX);
  const lead = args.platform === "wechat_video" ? WV_LEAD_POOL[0] : "关注我，了解更多投稿干货";
  const caption: DouyinCaption = { hookTitle, hashtags, lead, fullText: "", generatedAt: new Date().toISOString() };
  caption.fullText = assembleFullText(caption);
  return caption;
}

async function callLlmForCaption(args: {
  title: string;
  videoScript: string;
  journalName?: string;
  discipline?: string;
  platform: VideoPlatform;
}): Promise<DouyinCaption> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");

  const ctx = [
    args.journalName ? `期刊：${args.journalName}` : "",
    args.discipline ? `学科：${args.discipline}` : "",
    args.title ? `原标题：${args.title}` : "",
    args.videoScript ? `视频脚本：${args.videoScript.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");

  const sys = captionSys(args.platform);

  const resp = await provider.chat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: ctx || args.title || "学术期刊推广视频" },
    ],
    temperature: 0.7,
    maxTokens: 400,
  });

  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(text) as { hookTitle?: string; hashtags?: unknown; lead?: string };
  const hookTitle = String(parsed.hookTitle ?? args.title ?? "").slice(0, TITLE_MAX);
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, HASHTAG_MAX)
    : [];
  const lead = String(parsed.lead ?? "").slice(0, 60);
  if (!hookTitle) throw new Error("LLM 返回空 hookTitle");

  const caption: DouyinCaption = { hookTitle, hashtags, lead, fullText: "", generatedAt: new Date().toISOString() };
  caption.fullText = assembleFullText(caption);
  return caption;
}

/**
 * 给视频内容生成抖音文案包. 命中 metadata.douyinCaption 缓存直接返回 (force 跳过缓存).
 */
export async function generateDouyinCaption(opts: {
  contentId: string;
  tenantId: string;
  force?: boolean;
  platform?: VideoPlatform;
}): Promise<DouyinCaption> {
  const platform: VideoPlatform = opts.platform ?? "douyin";
  const field = captionField(platform);
  const [content] = await db
    .select()
    .from(contents)
    // PR #269: 与详情页 READABLE 过滤一致 — 允许系统推荐租户内容 (全用户可读), 否则推荐池视频生成文案报"不存在"
    .where(and(eq(contents.id, opts.contentId), or(eq(contents.tenantId, opts.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID))))
    .limit(1);
  if (!content) throw new Error(`generateDouyinCaption: content 不存在 ${opts.contentId}`);

  const meta = (content.metadata as Record<string, any>) ?? {};
  const existing = meta[field] as DouyinCaption | undefined;
  if (!opts.force && existing?.fullText) return existing;

  const title = content.title ?? "";
  const videoScript = (typeof meta.videoScript === "string" && meta.videoScript) || content.body || "";
  let journalName: string | undefined;
  let discipline: string | undefined;
  const journalId = meta.journalId as string | undefined;
  if (journalId) {
    const [j] = await db
      .select({ name: journals.name, discipline: journals.discipline })
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);
    journalName = j?.name ?? undefined;
    discipline = j?.discipline ?? undefined;
  }

  let caption: DouyinCaption | null = null;
  try {
    caption = await callLlmForCaption({ title, videoScript, journalName, discipline, platform });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId: opts.contentId }, "douyin.caption.llm_failed_fallback");
  }
  if (!caption) caption = ruleFallback({ title, journalName, discipline, platform });

  await db
    .update(contents)
    .set({ metadata: { ...meta, [field]: caption }, updatedAt: new Date() })
    .where(and(eq(contents.id, opts.contentId), eq(contents.tenantId, opts.tenantId)));

  logger.info({ contentId: opts.contentId, hashtags: caption.hashtags.length }, "douyin.caption.generated");
  return caption;
}


/** PR #265: 规则版变体 — 前缀 + 话题轮转 + 引导语池, 保证 N 套互不雷同 */
function ruleVariant(base: { title: string; journalName?: string; discipline?: string; platform: VideoPlatform }, i: number): DouyinCaption {
  const prefix = HOOK_PREFIXES[i % HOOK_PREFIXES.length];
  const baseTitle = base.title || `${base.journalName ?? "学术期刊"}投稿攻略`;
  const hookTitle = `${prefix}${baseTitle}`.slice(0, TITLE_MAX);
  const seeds = [base.discipline, base.journalName, "学术", "科研", "论文发表", "期刊投稿", "SCI", "读研"].filter(Boolean) as string[];
  const rotated = seeds.map((_, k) => seeds[(k + i) % seeds.length]);
  const hashtags = Array.from(new Set(rotated.map((t) => t.replace(/^#/, "").trim()).filter(Boolean))).slice(0, HASHTAG_MAX);
  const lead = (base.platform === "wechat_video" ? WV_LEAD_POOL : LEAD_POOL)[i % (base.platform === "wechat_video" ? WV_LEAD_POOL.length : LEAD_POOL.length)];
  const caption: DouyinCaption = { hookTitle, hashtags, lead, fullText: "", generatedAt: new Date().toISOString() };
  caption.fullText = assembleFullText(caption);
  return caption;
}

async function callLlmForVariants(args: {
  title: string; videoScript: string; journalName?: string; discipline?: string; count: number; platform: VideoPlatform;
}): Promise<DouyinCaption[]> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");
  const ctx = [
    args.journalName ? `期刊：${args.journalName}` : "",
    args.discipline ? `学科：${args.discipline}` : "",
    args.title ? `原标题：${args.title}` : "",
    args.videoScript ? `视频脚本：${args.videoScript.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  const sys = variantsSys(args.platform, args.count);

  const resp = await provider.chat({
    messages: [{ role: "system", content: sys }, { role: "user", content: ctx || args.title || "学术期刊推广视频" }],
    temperature: 0.9,
    maxTokens: Math.min(250 * args.count, 2400),
  });
  const text = resp.content.trim().replace(/^```json\s*|\s*```$/g, "");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("LLM 变体返回非数组");
  return parsed.map((v: { hookTitle?: string; hashtags?: unknown; lead?: string }) => {
    const hookTitle = String(v.hookTitle ?? args.title ?? "").slice(0, TITLE_MAX);
    const hashtags = Array.isArray(v.hashtags)
      ? v.hashtags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, HASHTAG_MAX)
      : [];
    const lead = String(v.lead ?? "").slice(0, 60);
    const caption: DouyinCaption = { hookTitle, hashtags, lead, fullText: "", generatedAt: new Date().toISOString() };
    caption.fullText = assembleFullText(caption);
    return caption;
  }).filter((c) => c.hookTitle);
}

/**
 * PR #265: 给视频生成 N 套差异化抖音文案 (发到 N 个矩阵号, 避免同质化降权).
 * LLM 不足 count 时用规则变体补齐; 结果缓存进 metadata.douyinCaptionVariants.
 */
export async function generateDouyinCaptionVariants(opts: {
  contentId: string; tenantId: string; count: number; force?: boolean; platform?: VideoPlatform;
}): Promise<DouyinCaption[]> {
  const platform: VideoPlatform = opts.platform ?? "douyin";
  const vfield = variantsField(platform);
  const count = Math.min(Math.max(Math.floor(opts.count) || 1, 1), MAX_VARIANTS);
  const [content] = await db
    .select()
    .from(contents)
    // PR #269: 与详情页 READABLE 过滤一致 — 允许系统推荐租户内容 (全用户可读), 否则推荐池视频生成文案报"不存在"
    .where(and(eq(contents.id, opts.contentId), or(eq(contents.tenantId, opts.tenantId), eq(contents.tenantId, SYSTEM_RECOMMENDATION_TENANT_ID))))
    .limit(1);
  if (!content) throw new Error(`generateDouyinCaptionVariants: content 不存在 ${opts.contentId}`);

  const meta = (content.metadata as Record<string, any>) ?? {};
  const cached = meta[vfield] as DouyinCaption[] | undefined;
  if (!opts.force && Array.isArray(cached) && cached.length >= count) return cached.slice(0, count);

  const title = content.title ?? "";
  const videoScript = (typeof meta.videoScript === "string" && meta.videoScript) || content.body || "";
  let journalName: string | undefined;
  let discipline: string | undefined;
  const journalId = meta.journalId as string | undefined;
  if (journalId) {
    const [j] = await db
      .select({ name: journals.name, discipline: journals.discipline })
      .from(journals)
      .where(eq(journals.id, journalId))
      .limit(1);
    journalName = j?.name ?? undefined;
    discipline = j?.discipline ?? undefined;
  }

  let variants: DouyinCaption[] = [];
  try {
    variants = await callLlmForVariants({ title, videoScript, journalName, discipline, count, platform });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId: opts.contentId }, "douyin.caption.variants_llm_failed_fallback");
  }
  // 不足 count 用规则变体补齐 (从 LLM 已产数量续号, 保证差异)
  for (let i = variants.length; i < count; i++) {
    variants.push(ruleVariant({ title, journalName, discipline, platform }, i));
  }
  variants = variants.slice(0, count);

  await db
    .update(contents)
    .set({ metadata: { ...meta, [vfield]: variants }, updatedAt: new Date() })
    .where(and(eq(contents.id, opts.contentId), eq(contents.tenantId, opts.tenantId)));

  logger.info({ contentId: opts.contentId, count: variants.length }, "douyin.caption.variants_generated");
  return variants;
}
