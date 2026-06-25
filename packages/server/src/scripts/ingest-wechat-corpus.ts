/**
 * 6-25 把公众号历史文章全量喂进 RAG 知识库(写法/句式参考, 非数据源)。
 *   读 data/wechat-corpus/_full/corpus.json → 每篇一条 content_format 知识 → 向量化入库。
 *   生成时按选题检索, 拉到"你写过的相近文章"做写法参考; 数据仍以期刊库为准, 不抄旧文数字。
 * 用法(服务器 packages/server 下):
 *   pnpm ingest:wechat --account "Paper咨询与发表"          # 入到该号租户
 *   选填 --tenant <tenantId> --category content_format|style --dir <corpus.json目录> --limit N
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { platformAccounts } from "../models/schema.js";
import { createEntries } from "../services/knowledge/knowledge-service.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../config/system-recommendation.js";

function arg(n: string): string | undefined { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const acctQ = arg("account");
  let tenantId = arg("tenant");
  const category = (arg("category") || "content_format");
  const dir = arg("dir") || "../../data/wechat-corpus/_full";
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  let accountName = acctQ || "";

  if (!tenantId && acctQ) {
    const [a] = await db.select().from(platformAccounts)
      .where(sql`(${platformAccounts.accountName} ILIKE ${"%" + acctQ + "%"} OR ${platformAccounts.id}::text = ${acctQ})`).limit(1);
    if (!a) { console.error(`❌ 没找到账号 ${acctQ}`); process.exitCode = 1; return; }
    tenantId = a.tenantId; accountName = a.accountName ?? acctQ;
  }
  if (!tenantId) tenantId = SYSTEM_RECOMMENDATION_TENANT_ID;

  const corpusPath = resolve(process.cwd(), dir, "corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as Array<{ title: string; date: string; body: string; chars: number }>;
  const items = corpus.filter((c) => c.chars >= 200).slice(0, limit ?? corpus.length);
  console.log(`📥 入库 ${items.length} 篇 → tenant=${tenantId} category=${category} (来源公众号: ${accountName || "—"})`);

  let done = 0;
  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    await createEntries(slice.map((c) => ({
      tenantId: tenantId!,
      category,
      title: c.title.slice(0, 200),
      content: c.body.slice(0, 6000),
      source: `wechat_history:${accountName || "public"}`,
      metadata: { date: c.date, account: accountName, kind: "公众号历史文章·写法参考" },
    })) as any);
    done += slice.length;
    console.log(`  …已入库 ${done}/${items.length}`);
  }
  console.log(`✅ 完成: ${done} 篇历史文章已进 RAG(category=${category})。生成时会按选题检索做写法参考。`);
  console.log("   注意: 数据(IF/分区等)仍以期刊库为准, RAG 只供写法/句式参考, 不抄旧文数字。");
}
main().then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error("入库异常:", e); await closePool(); process.exit(1); });
