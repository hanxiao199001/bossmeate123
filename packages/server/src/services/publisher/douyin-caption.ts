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
import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
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

function assembleFullText(c: { hookTitle: string; hashtags: string[]; lead: string }): string {
  const tags = c.hashtags
    .map((t) => `#${String(t).replace(/^#/, "").trim()}`)
    .filter((t) => t.length > 1)
    .join(" ");
  return [c.hookTitle, c.lead, tags].filter(Boolean).join("\n");
}

function ruleFallback(args: { title: string; journalName?: string; discipline?: string }): DouyinCaption {
  const hookTitle = (args.title || `${args.journalName ?? "学术期刊"}投稿攻略`).slice(0, TITLE_MAX);
  const seeds = [args.discipline, args.journalName, "学术", "科研", "论文发表", "期刊投稿"].filter(Boolean) as string[];
  const hashtags = Array.from(new Set(seeds.map((s) => s.replace(/^#/, "").trim()).filter(Boolean))).slice(0, HASHTAG_MAX);
  const lead = "关注我，了解更多投稿干货";
  const caption: DouyinCaption = { hookTitle, hashtags, lead, fullText: "", generatedAt: new Date().toISOString() };
  caption.fullText = assembleFullText(caption);
  return caption;
}

async function callLlmForCaption(args: {
  title: string;
  videoScript: string;
  journalName?: string;
  discipline?: string;
}): Promise<DouyinCaption> {
  const provider = getProviders().cheap[0];
  if (!provider) throw new Error("无可用 LLM provider");

  const ctx = [
    args.journalName ? `期刊：${args.journalName}` : "",
    args.discipline ? `学科：${args.discipline}` : "",
    args.title ? `原标题：${args.title}` : "",
    args.videoScript ? `视频脚本：${args.videoScript.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");

  const sys = `你是抖音爆款文案专家。给定一条学术期刊推广视频的信息，写一份抖音发布文案包。
**只输出纯 JSON**（不要 markdown 包裹）：
{"hookTitle":"钩子标题 ≤25字","hashtags":["话题1","话题2","话题3"],"lead":"1句引导语 ≤30字"}
要求：
- hookTitle 有钩子/悬念/数字，口语化，≤25 字
- hashtags 3-6 个，纯词不带 # 号，贴近学科与"投稿/发表/科研"主题
- lead 引导关注或互动，≤30 字`;

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
}): Promise<DouyinCaption> {
  const [content] = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, opts.contentId), eq(contents.tenantId, opts.tenantId)))
    .limit(1);
  if (!content) throw new Error(`generateDouyinCaption: content 不存在 ${opts.contentId}`);

  const meta = (content.metadata as Record<string, any>) ?? {};
  const existing = meta.douyinCaption as DouyinCaption | undefined;
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
    caption = await callLlmForCaption({ title, videoScript, journalName, discipline });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, contentId: opts.contentId }, "douyin.caption.llm_failed_fallback");
  }
  if (!caption) caption = ruleFallback({ title, journalName, discipline });

  await db
    .update(contents)
    .set({ metadata: { ...meta, douyinCaption: caption }, updatedAt: new Date() })
    .where(and(eq(contents.id, opts.contentId), eq(contents.tenantId, opts.tenantId)));

  logger.info({ contentId: opts.contentId, hashtags: caption.hashtags.length }, "douyin.caption.generated");
  return caption;
}
