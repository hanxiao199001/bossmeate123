/**
 * 5-18 P1: 给韩宵 tenant (你好集团) 插 demo 用 platform_accounts。
 *
 * 用法 (prod):
 *   ssh ubuntu@122.152.234.155 'cd /home/projects/bossmate/packages/server && \
 *     set -a && source ../../.env && set +a && \
 *     HANXIAO_TENANT_ID=4c03a3d0-cad4-4286-b14d-d6b12b6422bd \
 *     node dist/scripts/seed-hanxiao-accounts.js'
 *
 * 幂等：按 (tenant_id, platform, account_name) 唯一性查重，已存在跳过。
 * credentials = {} (jsonb 空对象)：demo 演示流程，publishToAccounts 会优雅返回
 * { success:false, error } 不崩 (wechat adapter line 16-19 / 134 / 187 实测验证)。
 */
import { db } from "../models/db.js";
import { platformAccounts } from "../models/schema.js";
import { and, eq } from "drizzle-orm";
import { logger } from "../config/logger.js";

interface SeedRow {
  platform: string;
  accountName: string;
  groupName: string;
  isVerified: boolean;
  capability: "full" | "draft_only";
}

const SEED_ROWS: SeedRow[] = [
  { platform: "wechat",       accountName: "主号 - 你好集团", groupName: "主矩阵",   isVerified: true,  capability: "draft_only" },
  { platform: "wechat",       accountName: "学术号",          groupName: "细分矩阵", isVerified: true,  capability: "draft_only" },
  { platform: "douyin",       accountName: "主号 - 你好集团", groupName: "主矩阵",   isVerified: false, capability: "draft_only" },
  { platform: "wechat_video", accountName: "主号 - 你好集团", groupName: "主矩阵",   isVerified: false, capability: "draft_only" },
];

export async function seedHanxiaoAccounts(tenantId: string): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const r of SEED_ROWS) {
    const existing = await db.select({ id: platformAccounts.id }).from(platformAccounts)
      .where(and(
        eq(platformAccounts.tenantId, tenantId),
        eq(platformAccounts.platform, r.platform),
        eq(platformAccounts.accountName, r.accountName),
      ))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ tenantId, platform: r.platform, accountName: r.accountName }, "seed skip (exists)");
      skipped++;
      continue;
    }
    await db.insert(platformAccounts).values({
      tenantId,
      platform: r.platform,
      accountName: r.accountName,
      groupName: r.groupName,
      isVerified: r.isVerified,
      capability: r.capability,
      credentials: {}, // 空 jsonb, demo 流程
      status: "active",
    });
    logger.info({ tenantId, platform: r.platform, accountName: r.accountName }, "seed inserted");
    inserted++;
  }
  return { inserted, skipped };
}

async function main() {
  const tenantId = process.env.HANXIAO_TENANT_ID;
  if (!tenantId) {
    console.error("HANXIAO_TENANT_ID env 缺失 (例: HANXIAO_TENANT_ID=4c03a3d0-cad4-4286-b14d-d6b12b6422bd)");
    process.exit(1);
  }
  const r = await seedHanxiaoAccounts(tenantId);
  console.log(`✅ seed 完成: inserted=${r.inserted} skipped=${r.skipped}`);
  process.exit(0);
}

// 仅在直接执行 (不是 import) 时跑 main
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
