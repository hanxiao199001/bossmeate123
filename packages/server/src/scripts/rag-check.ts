/**
 * 6-26 第三管(RAG写法参考)体检 — 不生成文章, 几秒出结果, 把失败原因分开照:
 *   ① PG knowledgeEntries 该租户 content_format 条数 (语料在不在这个号的租户)
 *   ② LanceDB 向量 content_format 条数 (向量化成功没)
 *   ③ 实际检索一次, 看写法参考命中几篇 (检索得到没)
 * 用法(服务器 packages/server 下):
 *   pnpm rag:check --account "Paper咨询与发表"
 *   选填 --topic "自定义选题" --tenant <tenantId>
 */
import { and, eq, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { knowledgeEntries, platformAccounts } from "../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";
import { countVectors } from "../services/knowledge/vector-store.js";
import { retrieveForArticle } from "../services/knowledge/rag-retriever.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const acctQ = arg("account");
  let tenantId = arg("tenant");
  let acctName = acctQ ?? "";

  if (!tenantId && acctQ) {
    const [a] = await db.select().from(platformAccounts)
      .where(sql`(${platformAccounts.accountName} ILIKE ${"%" + acctQ + "%"} OR ${platformAccounts.id}::text = ${acctQ})`).limit(1);
    if (!a) { console.error(`❌ 没找到账号 ${acctQ}`); process.exitCode = 1; return; }
    tenantId = a.tenantId; acctName = a.accountName ?? acctQ;
  }
  if (!tenantId) tenantId = SYSTEM_RECOMMENDATION_TENANT_ID;

  console.log(`\n🩺 第三管(RAG写法参考)体检`);
  console.log(`账号《${acctName || "—"}》  tenantId=${tenantId}\n`);

  // ① PG 元数据条数
  const [pgRow] = await db.select({ n: sql<number>`count(*)::int` }).from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.tenantId, tenantId), eq(knowledgeEntries.category, "content_format")));
  const pgCount = pgRow?.n ?? 0;
  console.log(`① PG  content_format 条数: ${pgCount}`);

  // ② LanceDB 向量条数
  let vecCount = -1;
  try { vecCount = await countVectors(tenantId, "content_format"); } catch (e) { console.log("   (向量库查询异常:", e instanceof Error ? e.message : e, ")"); }
  console.log(`② 向量 content_format 条数: ${vecCount}`);

  // ③ 实际检索
  const topic = arg("topic") ?? (acctName || "SCI 期刊推荐 投稿选刊");
  const r = await retrieveForArticle({ tenantId, topic, keywords: [] });
  const cf = r.sources.find((s) => s.category === "content_format");
  console.log(`③ 检索 topic="${topic}" → 写法参考命中 ${cf?.count ?? 0} 篇  | 全子库: ${r.sources.map((s) => `${s.category}:${s.count}`).join(", ") || "全空"}`);

  // —— 判读 ——
  console.log(`\n—— 判读 ——`);
  if (pgCount === 0) {
    console.log(`❌ 该租户 content_format 0 条 → 语料没灌进这个号的租户(多半 ingest 没带 --account)。`);
    console.log(`   重灌: pnpm ingest:wechat --account "${acctName}"`);
  } else if (vecCount === 0) {
    console.log(`❌ PG 有 ${pgCount} 条但向量 0 条 → 向量写入坏了(embedding 失败?)。重灌: pnpm ingest:wechat --account "${acctName}"`);
  } else if (!cf || cf.count === 0) {
    console.log(`⚠️ 库里有 ${pgCount} 条但检索 0 命中 → 类目已修, 八成 topic 太泛或相似度阈值偏高。换 --topic "更贴近某本刊的选题" 再试。`);
  } else {
    console.log(`✅ 第三管通了: 该租户 ${pgCount} 条写法参考, 本次检索命中 ${cf.count} 篇。RAG 写法参考已真正注入生成。`);
  }
  console.log("");
}
main().then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error("体检异常:", e instanceof Error ? e.message : e); await closePool(); process.exit(1); });
