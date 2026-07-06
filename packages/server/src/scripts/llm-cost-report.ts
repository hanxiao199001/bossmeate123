/**
 * LLM 成本日报 — pnpm cost:report [--days 7]
 *
 * 读 cost_ledger kind='llm'(由 chat-service 出口自动落库, 见 services/billing/llm-cost.ts),
 * 输出: ① 租户 × 日 汇总(金额/token/调用数) ② 按模型细分 ③ 本月合计。
 * 金额为价目表估算(分→元), 以百炼控制台账单为准。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../models/db.js";
import { costLedger, tenants } from "../models/schema.js";

function yuan(cents: number | string): string {
  return (Number(cents) / 100).toFixed(2);
}

async function main() {
  const daysIdx = process.argv.indexOf("--days");
  const days = daysIdx > -1 ? Math.max(1, Number(process.argv[daysIdx + 1]) || 7) : 7;
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  since.setHours(0, 0, 0, 0);

  const dayExpr = sql<string>`to_char(${costLedger.createdAt}, 'MM-DD')`;
  const perDay = await db
    .select({
      tenantId: costLedger.tenantId,
      tenantName: tenants.name,
      day: dayExpr,
      cents: sql<string>`SUM(${costLedger.amountCents})`,
      tokens: sql<string>`COALESCE(SUM(${costLedger.quantity}), 0)`,
      calls: sql<string>`COUNT(*)`,
    })
    .from(costLedger)
    .leftJoin(tenants, eq(costLedger.tenantId, tenants.id))
    .where(and(eq(costLedger.kind, "llm"), gte(costLedger.createdAt, since)))
    .groupBy(costLedger.tenantId, tenants.name, dayExpr)
    .orderBy(costLedger.tenantId, dayExpr);

  console.log(`========== LLM 成本日报(近 ${days} 天, 估算价, 以百炼账单为准) ==========\n`);
  if (perDay.length === 0) {
    console.log("(无记录 — llm 记账自本功能部署后才开始积累, 或该时段无 AI 调用)");
  }
  let curTenant = "";
  for (const r of perDay) {
    const label = `${r.tenantName ?? "(已删租户)"} [${r.tenantId.slice(0, 8)}]`;
    if (label !== curTenant) {
      curTenant = label;
      console.log(`\n【${label}】`);
    }
    console.log(`  ${r.day}  ¥${yuan(r.cents).padStart(8)}  ${String(r.tokens).padStart(10)} tok  ${String(r.calls).padStart(5)} 次`);
  }

  // 按模型细分(note 格式: "provider/model task=... in=... out=...")
  const modelExpr = sql<string>`split_part(split_part(${costLedger.note}, ' ', 1), '/', 2)`;
  const perModel = await db
    .select({
      model: modelExpr,
      cents: sql<string>`SUM(${costLedger.amountCents})`,
      tokens: sql<string>`COALESCE(SUM(${costLedger.quantity}), 0)`,
      calls: sql<string>`COUNT(*)`,
    })
    .from(costLedger)
    .where(and(eq(costLedger.kind, "llm"), gte(costLedger.createdAt, since)))
    .groupBy(modelExpr)
    .orderBy(sql`SUM(${costLedger.amountCents}) DESC`);

  console.log(`\n---------- 按模型(近 ${days} 天) ----------`);
  for (const r of perModel) {
    console.log(`  ${(r.model || "(未知)").padEnd(20)} ¥${yuan(r.cents).padStart(8)}  ${String(r.tokens).padStart(10)} tok  ${String(r.calls).padStart(5)} 次`);
  }

  // 本月合计(按租户)
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthly = await db
    .select({
      tenantId: costLedger.tenantId,
      tenantName: tenants.name,
      cents: sql<string>`SUM(${costLedger.amountCents})`,
    })
    .from(costLedger)
    .leftJoin(tenants, eq(costLedger.tenantId, tenants.id))
    .where(and(eq(costLedger.kind, "llm"), gte(costLedger.createdAt, monthStart)))
    .groupBy(costLedger.tenantId, tenants.name)
    .orderBy(sql`SUM(${costLedger.amountCents}) DESC`);

  console.log(`\n---------- 本月合计(自 ${monthStart.toISOString().slice(0, 10)}) ----------`);
  let totalCents = 0;
  for (const r of monthly) {
    totalCents += Number(r.cents);
    console.log(`  ${(r.tenantName ?? "(已删租户)").padEnd(24)} ¥${yuan(r.cents)}`);
  }
  console.log(`  ${"— 全站".padEnd(24)} ¥${yuan(totalCents)}`);
  console.log("\n提示: 预算闸(checkBudget)读同一张表, 租户 config.budgetConfig 配了日/月上限即自动拦截超支生成。");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
