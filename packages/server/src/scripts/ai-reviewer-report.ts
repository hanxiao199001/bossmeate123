/**
 * 7-05 ④ AI 审稿一致率报表 — 影子期转正(shadow → live)的依据。
 *
 * 逻辑: 扫既有 metadata.aiReview 记录, 找同一 content 后续的人工裁决
 * (metadata.calibration, source=human/历史无 source 也算人工), 对比:
 *   AI approve ↔ 人工 accept = 一致; AI reject ↔ 人工 reject = 一致; 其余 = 分歧。
 *   AI unsure 不计入一致率分母 (存疑本来就是留人, 无对错), 单独统计。
 *
 * 用法 (packages/server 下): pnpm review:report
 */
import { desc, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { contents } from "../models/schema.js";

interface PairRow {
  id: string;
  title: string | null;
  ai: Record<string, any>;
  human: Record<string, any>;
}

async function main() {
  const rows = await db
    .select({ id: contents.id, title: contents.title, metadata: contents.metadata })
    .from(contents)
    .where(sql`${contents.metadata} ? 'aiReview' AND ${contents.metadata} ? 'calibration'
      AND COALESCE(${contents.metadata}->'calibration'->>'source', 'human') = 'human'`)
    .orderBy(desc(contents.updatedAt))
    .limit(1000);

  const pairs: PairRow[] = [];
  for (const r of rows) {
    const md = (r.metadata ?? {}) as Record<string, any>;
    const ai = md.aiReview, human = md.calibration;
    if (!ai?.verdict || !human?.verdict) continue;
    // 只算"AI 先审、人工后裁"的 (AI 是影子建议, 人工是真值); 时间倒挂的样本剔除
    if (ai.checkedAt && human.at && String(ai.checkedAt) > String(human.at)) continue;
    pairs.push({ id: r.id, title: r.title, ai, human });
  }

  let agree = 0, disagree = 0, unsure = 0;
  const disagreements: Array<{ id: string; title: string; ai: string; human: string; aiReason: string; humanReason: string }> = [];
  for (const p of pairs) {
    const aiV = String(p.ai.verdict);
    const humanV = String(p.human.verdict); // accept | reject
    if (aiV === "unsure") { unsure++; continue; }
    const match = (aiV === "approve" && humanV === "accept") || (aiV === "reject" && humanV === "reject");
    if (match) agree++;
    else {
      disagree++;
      disagreements.push({
        id: p.id,
        title: (p.title ?? "(无标题)").slice(0, 50),
        ai: `${aiV}(conf=${Number(p.ai.confidence ?? 0).toFixed(2)})`,
        human: humanV,
        aiReason: String(p.ai.reason ?? "").slice(0, 80),
        humanReason: String(p.human.reason ?? "").slice(0, 80),
      });
    }
  }

  const decided = agree + disagree;
  const rate = decided > 0 ? (agree / decided) * 100 : 0;

  console.log("========== AI 审稿一致率报表 ==========");
  console.log(`可对比样本(AI 有明确裁决 + 人工有真值): ${decided}`);
  console.log(`  一致: ${agree}`);
  console.log(`  分歧: ${disagree}`);
  console.log(`  AI 存疑(不计分母): ${unsure}`);
  console.log(`一致率: ${decided > 0 ? rate.toFixed(1) + "%" : "— (无样本)"}`);
  console.log("");
  if (disagreements.length > 0) {
    console.log("---------- 分歧清单 ----------");
    for (const d of disagreements) {
      console.log(`· [${d.id.slice(0, 8)}] ${d.title}`);
      console.log(`    AI: ${d.ai} — ${d.aiReason}`);
      console.log(`    人工: ${d.human} — ${d.humanReason || "(未填理由)"}`);
    }
    console.log("");
  }
  console.log("---------- 转正建议 ----------");
  if (decided < 20) {
    console.log(`样本量 ${decided} < 20, 统计意义不足 — 继续影子模式积累, 暂不建议切 live。`);
  } else if (rate > 90) {
    console.log(`一致率 ${rate.toFixed(1)}% > 90% 且样本量充足 — 可以切 live:`);
    console.log(`  服务器 .env 设 AI_REVIEWER_MODE=live (阈值 AI_REVIEWER_MIN_CONFIDENCE=0.75, 日上限 AI_REVIEWER_DAILY_CAP=10 已兜底), 重启后生效。`);
    console.log(`  切换后前两周每天抽查 metadata.aiReview.spotCheck=true 的自动采用样本。`);
  } else {
    console.log(`一致率 ${rate.toFixed(1)}% ≤ 90% — 不建议切 live。优先分析分歧清单, 补人工校准样本(few-shot 锚定)后再看。`);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
