/**
 * 6-25 标题样片: 喂一本真实期刊数据 → 按公众号标题 DNA 产 5 个候选标题。
 * 用法(服务器 packages/server 下):
 *   pnpm sample:titles                     # 随机挑一本有IF的刊
 *   pnpm sample:titles --journal <id>
 *   pnpm sample:titles --account "Paper"   # 用该号领域选刊 + 注入该号 styleProfile
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { journals, platformAccounts } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID, SYSTEM_RECOMMENDATION_USER_ID } from "../config/system-recommendation.js";
import { generateTitles } from "../services/content-engine/title-generator.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const jid = arg("journal");
  const acctQ = arg("account");
  let disc: string | undefined, styleProfile: string | undefined;
  if (acctQ) {
    const [a] = await db.select().from(platformAccounts)
      .where(sql`(${platformAccounts.accountName} ILIKE ${"%" + acctQ + "%"} OR ${platformAccounts.id}::text = ${acctQ})`).limit(1);
    if (a) { const ds = Array.isArray(a.disciplines) ? (a.disciplines as string[]) : []; disc = ds[0] ?? (a.discipline ?? undefined); styleProfile = a.styleProfile ?? undefined;
      console.log(`账号《${a.accountName}》 领域=${disc ?? "不限"} styleProfile=${styleProfile ? "已设" : "未设"}`); }
  }
  // 6-25 修: 原 discCond 用裸 "AND ..."/空 sql`` 塞进 and() → 空时 "and )" 语法错(42601)、有值时双 AND。改条件数组拼接。
  const conds = [eq(journals.status, "active"), isNotNull(journals.impactFactor)];
  if (disc) conds.push(sql`${journals.discipline} ILIKE ${"%" + disc + "%"}`);
  const [j] = jid
    ? await db.select().from(journals).where(eq(journals.id, jid)).limit(1)
    : await db.select().from(journals).where(and(...conds)).orderBy(sql`random()`).limit(1);
  if (!j) { console.error("❌ 没找到可用期刊"); process.exitCode = 1; return; }

  console.log(`\n🔖 给期刊《${j.name ?? j.nameEn}》产标题  (IF=${j.impactFactor ?? "—"} 分区=${(j as any).casPartitionNew ?? (j as any).casPartition ?? "—"})\n`);
  const titles = await generateTitles({
    tenantId: SYSTEM_RECOMMENDATION_TENANT_ID, userId: SYSTEM_RECOMMENDATION_USER_ID,
    styleProfile,
    journal: {
      name: j.name, nameEn: j.nameEn, publisher: (j as any).publisher,
      casPartition: (j as any).casPartitionNew ?? (j as any).casPartition, jcrPartition: (j as any).jcrSubjects,
      impactFactor: j.impactFactor, reviewCycle: (j as any).reviewCycle, acceptanceRate: (j as any).acceptanceRate,
      selfCitationRate: (j as any).selfCitationRate, discipline: (j as any).discipline,
    },
    count: 5,
  });
  console.log("候选标题:");
  titles.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log("\n👉 看哪几个像你写的 / 哪里要调, 告诉我改标题DNA。\n");
}
main().then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error("生成异常:", e); await closePool(); process.exit(1); });
