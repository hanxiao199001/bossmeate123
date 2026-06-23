/**
 * 6-22 样片①: 期刊科普「图文卡片视频」质量验证。
 *   拉一本真实期刊 → 自动配一段 5-6 幕脚本(信息卡 + 配音 + 字幕)→ produceVideo 合成 MP4。
 *   用来肉眼评估"图文卡片视频"成片质量(模板/转场/配音/节奏/画面)。
 *
 * 用法(服务器 packages/server 下):
 *   pnpm sample:card                 # 自动挑一本有 IF/分区的期刊
 *   pnpm sample:card --journal <id>  # 指定期刊
 *
 * 成本: 低(TTS 配音 + Pexels 配图 + 本机 ffmpeg)。不碰阿里云数字人付费。
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals, platformAccounts } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { produceVideo } from "../services/video/index.js";
import { pickClipStyle, isClipStyleKey, CLIP_STYLES } from "../services/video/clip-styles.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const jid = arg("journal");
  const acctId = arg("account");
  const styleArg = arg("style");

  // --account: 加载账号 → 自动匹配剪辑风格 + 按其领域选刊(模拟"给这个号出片")
  let clipKey: string | undefined = isClipStyleKey(styleArg) ? styleArg : undefined;
  let acctDiscipline: string | undefined;
  if (acctId) {
    // 灵活匹配: 内部id(uuid) / 平台号(accountId) / 账号名(accountName 模糊)
    const [acct] = await db.select().from(platformAccounts)
      .where(sql`(${platformAccounts.id}::text = ${acctId} OR ${platformAccounts.accountId} = ${acctId} OR ${platformAccounts.accountName} ILIKE ${"%" + acctId + "%"})`)
      .limit(1);
    if (!acct) { console.error(`❌ 没找到账号 ${acctId}(可传 内部id / 平台号 / 账号名)`); process.exitCode = 1; return; }
    const ds = Array.isArray(acct.disciplines) ? (acct.disciplines as string[]) : [];
    acctDiscipline = ds[0] ?? (acct.discipline ?? undefined);
    if (!clipKey) {
      const preset = pickClipStyle(acct as any);
      clipKey = preset.key;
      console.log(`\n📐 账号《${acct.accountName}》自动匹配剪辑风格 → 「${preset.label}」(${preset.key})`);
      console.log(`   语速 ${preset.ttsSpeed}x · 每幕 ${preset.sceneDurationMs / 1000}s · BGM ${preset.bgmTag} · ${preset.desc}`);
    }
  }
  if (clipKey) {
    const p = CLIP_STYLES[clipKey as keyof typeof CLIP_STYLES];
    if (p && !acctId) console.log(`\n📐 指定剪辑风格 → 「${p.label}」(语速 ${p.ttsSpeed}x · 每幕 ${p.sceneDurationMs / 1000}s · BGM ${p.bgmTag})`);
  }

  // 选刊: 指定 → 账号领域 → 随机有IF
  const discCond = acctDiscipline ? sql`AND ${journals.discipline} ILIKE ${"%" + acctDiscipline + "%"}` : sql``;
  const [j] = jid
    ? await db.select().from(journals).where(eq(journals.id, jid)).limit(1)
    : await db.select().from(journals)
        .where(and(eq(journals.status, "active"), isNotNull(journals.impactFactor), discCond as any))
        .orderBy(sql`random()`).limit(1);
  if (!j) { console.error("❌ 没找到可用期刊(库里没有 IF 非空的 active 刊?)"); process.exitCode = 1; return; }

  const name = j.name ?? j.nameEn ?? "该期刊";
  const ifv = j.impactFactor != null ? `${j.impactFactor}` : "—";
  const part = (j as any).casPartitionNew ?? (j as any).casPartition ?? (j as any).partition ?? "—";
  const cycle = (j as any).reviewCycle ?? "—";
  const acc = (j as any).acceptanceRate != null ? `${(j as any).acceptanceRate}%` : "—";

  console.log(`\n🎬 用期刊《${name}》生成图文卡片样片  (IF=${ifv} 分区=${part})\n`);

  const scenes = [
    { sceneType: "opening" as const, voiceoverText: `想投稿又怕踩坑?今天带你三十秒看懂《${name}》到底值不值得冲。`, visualKeywords: ["research", "science"], durationMs: 5000 },
    { sceneType: "data" as const, voiceoverText: `先看硬指标:最新影响因子 ${ifv},中科院分区 ${part}。`, visualKeywords: ["data", "chart"], durationMs: 5000 },
    { sceneType: "review" as const, voiceoverText: `审稿速度 ${cycle},参考录用率 ${acc},投之前心里先有个底。`, visualKeywords: ["timeline", "review"], durationMs: 5000 },
    { sceneType: "topic" as const, voiceoverText: `它偏好的方向、适合的选题,选对了命中率能高一大截。`, visualKeywords: ["topic", "idea"], durationMs: 5000 },
    { sceneType: "tips" as const, voiceoverText: `一个小建议:投稿信里把创新点和这本刊的定位对上,编辑一眼就懂。`, visualKeywords: ["writing", "tips"], durationMs: 5000 },
    { sceneType: "cta" as const, voiceoverText: `关注我,每天一本期刊避坑指南,投稿少走弯路。`, visualKeywords: ["follow", "subscribe"], durationMs: 4000 },
  ].map((s) => ({ ...s, subtitle: s.voiceoverText }));

  console.log("⏳ 正在合成(配图+TTS配音+ffmpeg)... 约 1-3 分钟\n");
  const r = await produceVideo({ tenantId: SYSTEM_RECOMMENDATION_TENANT_ID, title: `《${name}》投稿避坑`, journalId: j.id, scenes, clipStyleKey: clipKey as any });

  console.log("\n✅ 图文卡片样片已生成");
  console.log(`   地址: ${r.url}`);
  console.log(`   场景数: ${r.scenesCount}  缺素材场景: ${r.missingAssetsCount}`);
  console.log("\n   👉 用浏览器/播放器打开上面地址,重点看: 模板好不好看 / 配音自不自然 / 转场节奏 / 画面和文案搭不搭。\n");
}

main()
  .then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (err) => { console.error("样片生成异常:", err); await closePool(); process.exit(1); });
