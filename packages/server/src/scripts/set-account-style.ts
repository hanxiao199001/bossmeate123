/**
 * 6-25 把风格画像(styleProfile)设到指定账号 —— 学历史文章后,让生成照该号风格走。
 * 用法(服务器 packages/server 下):
 *   pnpm set:style --account "Paper咨询与发表" --file ../../data/wechat-corpus/styleProfile.txt
 *   选填 --platform wechat(默认按名模糊匹配, 多个匹配会列出让你加 --id 精确指定)
 */
import { readFileSync } from "node:fs";
import { eq, and, or, sql } from "drizzle-orm";
import { db, closePool } from "../models/db.js";
import { platformAccounts } from "../models/schema.js";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const acctQ = arg("account");
  const id = arg("id");
  const file = arg("file");
  if ((!acctQ && !id) || !file) {
    console.error('用法: pnpm set:style --account "公众号名" --file <styleProfile.txt> [--id <账号id>]');
    process.exitCode = 1; return;
  }
  const style = readFileSync(file, "utf-8").trim();
  if (!style) { console.error("❌ styleProfile 文件为空"); process.exitCode = 1; return; }

  const rows = id
    ? await db.select().from(platformAccounts).where(eq(platformAccounts.id, id)).limit(5)
    : await db.select().from(platformAccounts)
        .where(and(eq(platformAccounts.platform, "wechat"),
          sql`(${platformAccounts.accountName} ILIKE ${"%" + acctQ + "%"})`)).limit(10);
  if (rows.length === 0) { console.error(`❌ 没找到匹配账号: ${acctQ ?? id}`); process.exitCode = 1; return; }
  if (rows.length > 1) {
    console.error(`⚠️ 匹配到 ${rows.length} 个, 请用 --id 精确指定其一:`);
    for (const r of rows) console.error(`   ${r.id}  ${r.accountName}  [${r.platform}]`);
    process.exitCode = 1; return;
  }
  const a = rows[0]!;
  await db.update(platformAccounts).set({ styleProfile: style, updatedAt: new Date() }).where(eq(platformAccounts.id, a.id));
  console.log(`✅ 已把风格画像设到账号「${a.accountName}」[${a.id}]  (styleProfile ${style.length} 字)`);
  console.log("   之后该号生成的文章会注入这段风格。");
}

main().then(async () => { await closePool(); process.exit(process.exitCode ?? 0); })
  .catch(async (e) => { console.error("设置异常:", e); await closePool(); process.exit(1); });
