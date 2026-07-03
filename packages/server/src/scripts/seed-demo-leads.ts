/**
 * 5-21 P3: 给韩宵 tenant seed 8 demo leads + sales_messages (覆盖 5 stage)。
 *
 * 用法 (prod):
 *   ssh ubuntu@119.91.52.13 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     HANXIAO_TENANT_ID=4c03a3d0-cad4-4286-b14d-d6b12b6422bd \
 *     node dist/scripts/seed-demo-leads.js'
 *
 * 现有真 12 leads (contacted 8 + need_human 4) 不动；seed 8 智能填空覆盖 new/qualified/
 * negotiating/won/lost 5 个 stage。metadata.seedSource='demo' 标记便于区分。
 * 幂等：查 metadata.seedSource='demo' 已存在的 lead，按 channel+externalId 跳过。
 */
import { db } from "../models/db.js";
import { leads, salesMessages } from "../models/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../config/logger.js";

interface SeedLead {
  channel: string;
  externalId: string; // seed-* 前缀, 幂等 key
  name: string;
  stage: "new" | "qualified" | "negotiating" | "won" | "lost";
  intentScore: number;
  // 对话 (按 inbound/outbound 顺序; 简化: 所有 outbound 是 AI 生成)
  dialogue: Array<{ direction: "inbound" | "outbound"; content: string }>;
}

const SEED_LEADS: SeedLead[] = [
  // new × 3 (刚进来, 还没 AI 回复 → 体现"流量进来")
  { channel: "comment_wechat", externalId: "seed-new-001", name: "张小蕊", stage: "new", intentScore: 25,
    dialogue: [{ direction: "inbound", content: "请问这本 SCI 4 区好投吗？" }] },
  { channel: "comment_zhihu", externalId: "seed-new-002", name: "李博文", stage: "new", intentScore: 35,
    dialogue: [{ direction: "inbound", content: "看了文章，想了解一下投稿费用" }] },
  { channel: "dm", externalId: "seed-new-003", name: "王悦", stage: "new", intentScore: 40,
    dialogue: [{ direction: "inbound", content: "你们能帮投影响因子 5 以上的吗？" }] },

  // qualified × 1 (AI 2 轮)
  { channel: "wechat_work", externalId: "seed-qual-001", name: "陈思远", stage: "qualified", intentScore: 65,
    dialogue: [
      { direction: "inbound", content: "想发心理学方向 SCI" },
      { direction: "outbound", content: "您好！心理学方向 Q1-Q2 我们有 30+ 期刊资源。请问您当前研究主题、是否已成稿？" },
      { direction: "inbound", content: "实验心理学，初稿快好了" },
      { direction: "outbound", content: "Frontiers in Psychology / Memory & Cognition 都适合，审稿周期 8-12 周。您要看下报价方案吗？" },
    ] },

  // negotiating × 1 (AI 3 轮, 已问报价)
  { channel: "wechat_work", externalId: "seed-nego-001", name: "刘晓辰", stage: "negotiating", intentScore: 80,
    dialogue: [
      { direction: "inbound", content: "教育学 SSCI 二区，急投" },
      { direction: "outbound", content: "您好！SSCI 二区教育学，推荐 Computers & Education / Educational Technology Research。预算和时间方便聊吗？" },
      { direction: "inbound", content: "3 个月内出, 预算 1.5-2 万" },
      { direction: "outbound", content: "可以！基础包 1.8w 含语言润色+格式+投稿+一次大改, 您稿子方便发我看一下吗？" },
      { direction: "inbound", content: "可以, 发你邮箱" },
      { direction: "outbound", content: "好的, 收到我 24h 内出评估报告。是否需要先签合作意向？" },
    ] },

  // won × 2 (转化故事 — demo 杀手锏)
  { channel: "manual", externalId: "seed-won-001", name: "周教授", stage: "won", intentScore: 95,
    dialogue: [
      { direction: "inbound", content: "推荐的 Nature Communications 那篇, 我想再做一篇" },
      { direction: "outbound", content: "周老师好！欢迎二次合作。这次什么主题方向？" },
      { direction: "inbound", content: "AI 在医学影像的应用" },
      { direction: "outbound", content: "完美匹配 npj Digital Medicine（IF 12.4），人工已转接，张顾问稍后联系您。" },
      { direction: "outbound", content: "[已转交人工成交] 张顾问已联系，签约 2.8w 完整套餐。" },
    ] },
  { channel: "comment_zhihu", externalId: "seed-won-002", name: "马同学", stage: "won", intentScore: 92,
    dialogue: [
      { direction: "inbound", content: "硕士毕业最快多久能见刊？" },
      { direction: "outbound", content: "您好！如果稿子已经成型, 选审稿快的期刊 (例如 Frontiers 系列), 平均 6-10 周。要给您评估方案吗？" },
      { direction: "inbound", content: "好" },
      { direction: "outbound", content: "已发您邮箱报价。" },
      { direction: "outbound", content: "[已转交人工成交] 8 周后稳定出版, 签约 1.6w 标准套餐。" },
    ] },

  // lost × 1 (AI 接住, 客户没回 — 第 5 tab 演示)
  { channel: "comment_wechat", externalId: "seed-lost-001", name: "潜水的吴", stage: "lost", intentScore: 22,
    dialogue: [
      { direction: "inbound", content: "你们这个收费多少？" },
      { direction: "outbound", content: "您好！收费根据期刊难度和服务深度从 1-3w 不等。方便了解一下您的论文方向？" },
    ] },
];

const HANXIAO_USER_ID = "5c4f4a1e-7c54-46d5-8b76-37d64d072152"; // PR #143 已知

export async function seedDemoLeads(tenantId: string): Promise<{ inserted: number; skipped: number; messages: number }> {
  let inserted = 0;
  let skipped = 0;
  let messageCount = 0;
  const now = new Date();

  for (const s of SEED_LEADS) {
    // 幂等: 按 (tenantId, channel, externalId) 查重
    const existing = await db.select({ id: leads.id }).from(leads)
      .where(and(eq(leads.tenantId, tenantId), eq(leads.channel, s.channel), eq(leads.externalId, s.externalId)))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ tenantId, externalId: s.externalId }, "seed-demo-leads skip (exists)");
      skipped++;
      continue;
    }

    // updatedAt 错开模拟"本周转热": qualified/negotiating 落在最近 3 天内, won 落在最近 14 天内
    const updatedAt = s.stage === "won" ? new Date(now.getTime() - Math.random() * 14 * 86400_000)
      : s.stage === "lost" ? new Date(now.getTime() - 5 * 86400_000)
      : s.stage === "new" ? now
      : new Date(now.getTime() - Math.random() * 3 * 86400_000);

    const [lead] = await db.insert(leads).values({
      tenantId,
      channel: s.channel,
      externalId: s.externalId,
      name: s.name,
      stage: s.stage,
      intentScore: s.intentScore,
      profile: { seedSource: "demo", note: "5-21 P3 seed-demo-leads" },
      handoverMode: s.stage === "won" ? "human" : "ai",
      assignedUserId: s.stage === "won" ? HANXIAO_USER_ID : null,
      lastMessageAt: updatedAt,
      createdAt: s.stage === "new" ? now : new Date(now.getTime() - Math.random() * 14 * 86400_000),
      updatedAt,
    }).returning({ id: leads.id });

    if (!lead) continue;

    // 写 sales_messages (按对话顺序, 时间戳递增)
    let msgTime = lead.id ? new Date(updatedAt.getTime() - s.dialogue.length * 60_000) : now;
    for (const m of s.dialogue) {
      await db.insert(salesMessages).values({
        tenantId,
        leadId: lead.id,
        direction: m.direction,
        kind: "text",
        content: m.content,
        isAiGenerated: m.direction === "outbound",
        createdAt: msgTime,
      });
      messageCount++;
      msgTime = new Date(msgTime.getTime() + 60_000);
    }
    logger.info({ tenantId, externalId: s.externalId, stage: s.stage, dialogueCount: s.dialogue.length }, "seed-demo-leads inserted");
    inserted++;
  }
  return { inserted, skipped, messages: messageCount };
}

async function main() {
  const tenantId = process.env.HANXIAO_TENANT_ID;
  if (!tenantId) {
    console.error("HANXIAO_TENANT_ID env 缺失 (例: 4c03a3d0-cad4-4286-b14d-d6b12b6422bd)");
    process.exit(1);
  }
  const r = await seedDemoLeads(tenantId);
  console.log(`✅ seed 完成: leads inserted=${r.inserted} skipped=${r.skipped}, sales_messages=${r.messages}`);
  process.exit(0);
}

// avoid unused import warning + suppress sql import unused
void sql;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
