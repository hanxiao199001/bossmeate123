/**
 * 6-22 样片②: 「数字人讲解 + 内容混剪」质量验证。
 *   取一篇真实文章 → 阿里云数字人合成口播视频(triggerDvhFromArticle)→ 再混剪(片头卡/缩放/片尾CTA/转场)。
 *   产出两条 URL: 数字人原片 + 混剪成片。用来肉眼评估数字人形象/口型/配音 + 混剪防查重的观感。
 *
 * 用法(服务器 packages/server 下):
 *   pnpm sample:dvh --yes                      # 自动挑一篇近期文章, A_academic 形象
 *   pnpm sample:dvh --yes --article <id> --template B_marketing
 *
 * ⚠️ 成本: 真实数字人合成按 0.165 元/秒计费(~90 秒约 15 元), 一旦 submit 即扣费。
 *   故必须显式加 --yes 才会真跑; 不加只打印将用的文章/形象, 不花钱。
 *   若服务器未配 DVH(DVH_TENANT_ID/APP_ID/阿里云 key), 会返回占位 mock, 不反映真实质量。
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { contents } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID, SYSTEM_RECOMMENDATION_USER_ID } from "../config/system-recommendation.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triggerDvhFromArticle } from "../services/digital-human/article-bridge.js";
import { remixVideo } from "../services/digital-human/video-remix.js";
import { resolveRemixAssets } from "../services/digital-human/remix-assets.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const go = process.argv.includes("--yes");
  const template = arg("template") || "A_academic";
  const aid = arg("article");

  // 优先挑"带 videoScript 的文章"(数字人脚本质量最好); 否则挑最近一篇文章
  const [art] = aid
    ? await db.select().from(contents).where(eq(contents.id, aid)).limit(1)
    : (await db.select().from(contents)
        .where(and(eq(contents.type, "article"), sql`${contents.metadata}->>'videoScript' IS NOT NULL`))
        .orderBy(desc(contents.createdAt)).limit(1))
      ?? await db.select().from(contents)
        .where(eq(contents.type, "article"))
        .orderBy(desc(contents.createdAt)).limit(1);

  if (!art) { console.error("❌ 库里没有 article 类型内容可用; 先生成一篇文章再来。"); process.exitCode = 1; return; }
  const hasScript = !!((art.metadata as any)?.videoScript);
  console.log(`\n🎬 数字人样片  文章=《${art.title ?? art.id}》  形象=${template}  ${hasScript ? "(有专用视频脚本✓)" : "(无videoScript, 用标题+正文兜底)"}`);

  if (!go) {
    console.log("\n⏸  这是预览(没花钱)。确认后加 --yes 真跑:");
    console.log(`   pnpm sample:dvh --yes --article ${art.id} --template ${template}`);
    console.log("   ⚠️ 真跑会调用阿里云数字人合成, 按 0.165 元/秒计费(~90秒约15元)。\n");
    return;
  }

  console.log("\n⏳ 正在合成数字人(提交阿里云→轮询→后处理字幕)... 可能要几分钟,别中断\n");
  await triggerDvhFromArticle({
    db, tenantId: SYSTEM_RECOMMENDATION_TENANT_ID, userId: SYSTEM_RECOMMENDATION_USER_ID,
    articleContentId: art.id, templateId: template,
  });

  // 取刚生成的数字人视频
  const [vid] = await db.select().from(contents).where(and(
    eq(contents.type, "video"),
    sql`${contents.metadata}->>'sourceArticleId' = ${art.id}`,
    sql`${contents.metadata}->>'source' = 'dvh'`,
  )).orderBy(desc(contents.createdAt)).limit(1);

  if (!vid) { console.error("❌ 没找到生成的数字人视频(可能合成失败/预算闸拦截, 看服务器日志 dvh.bridge.*)"); process.exitCode = 1; return; }
  const meta = vid.metadata as any;
  const baseUrl = meta?.videoUrl || vid.body;
  console.log(`\n✅ 数字人原片: ${baseUrl}`);
  console.log(`   形象=${meta?.avatarLabel ?? template}  配音=${meta?.voiceLabel ?? "—"}  时长≈${Math.round((meta?.durationMs ?? 0)/1000)}s  ${meta?.realMode ? "" : "(⚠️ mock占位, 未配真实DVH)"}`);

  // 混剪(防查重: 片头卡+缩放+片尾CTA+转场; 7-02 提质: 期刊封面片头背景 + 图表 B-roll + BGM ducking)
  console.log("\n⏳ 正在混剪(片头标题卡/缩放/片尾CTA/转场/B-roll)...\n");
  // 素材解析失败返回空对象, 混剪照常跑(样片脚本同样不因素材阻塞)
  const assetsDir = await mkdtemp(join(tmpdir(), "dvh-remix-assets-"));
  let remix: { videoUrl: string; remixed: boolean; coverUrl?: string };
  try {
    const { journalId, ...assets } = await resolveRemixAssets(vid.id, assetsDir);
    console.log(`   素材: 期刊=${journalId ?? "未关联"}  片头背景=${assets.introBgUrl ? "✓封面" : "✗纯色"}  B-roll=${assets.brollPaths?.length ?? 0}张  数据=${assets.journalStats?.ifText ?? assets.journalStats?.partitionText ?? "无"}`);
    // 7-10: --style academic|popsci|marketing|data 可指定剪辑风格(片头模板加权+卡点BPM); 不传走中性权重
    const clipStyle = arg("style");
    remix = await remixVideo({ videoUrl: baseUrl, title: art.title ?? "BossMate", seed: Math.floor(Math.random() * 1e6), ...(clipStyle ? { clipStyle } : {}), ...assets });
  } finally {
    await rm(assetsDir, { recursive: true, force: true }).catch(() => undefined);
  }
  console.log(`✅ 混剪成片: ${remix.videoUrl}  ${remix.remixed ? "(已混剪)" : "(混剪未生效, 回退原片)"}`);
  if (remix.coverUrl) console.log(`   自动封面: ${remix.coverUrl}`);

  console.log("\n   👉 两条都打开对比看: 数字人形象/口型/配音自不自然; 混剪后片头/转场/CTA 观感; 像不像能直接发的号。\n");
}

main()
  .then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (err) => { console.error("样片生成异常:", err); await closePool(); process.exit(1); });
