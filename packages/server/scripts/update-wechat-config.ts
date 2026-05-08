/**
 * PR Q.9 admin 脚本：UPDATE platform_accounts.credentials 公众号 row（重新加密）。
 *
 * 5-13 demo blocker：user 一键发布报"凭证解密失败 Unsupported state or unable to authenticate data"。
 * Root cause：当前 JWT_SECRET / CREDENTIALS_KEY 与 user 之前创建 wechat config 时的 key 不一致
 * （key 历史变更）→ AES-GCM authTag 验证失败 → 旧密文无法解密。
 *
 * 修法：user 公众号后台重置 app_secret → 通过本脚本（env vars）重新加密 + UPDATE。
 *
 * 用法：
 *   ssh ubuntu@122.152.234.155
 *   cd /home/projects/bossmate
 *   WECHAT_APP_SECRET="<真新 secret>" \
 *     WECHAT_APP_ID="wxfae94e195cf225fb" \
 *     ACCOUNT_NAME="老韩很野vibecoding" \
 *     pnpm exec tsx packages/server/scripts/update-wechat-config.ts
 */
import { eq, and } from "drizzle-orm";
import { db } from "../src/models/db.js";
import { platformAccounts } from "../src/models/schema.js";
import { encryptCredentials, decryptCredentials } from "../src/utils/crypto.js";
import { logger } from "../src/config/logger.js";

async function main() {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  const accountName = process.env.ACCOUNT_NAME;

  if (!appId || !appSecret) {
    console.error("❌ 缺 env：WECHAT_APP_ID + WECHAT_APP_SECRET 必填，ACCOUNT_NAME 可选");
    process.exit(1);
  }

  // 找已有 wechat 行（如有 ACCOUNT_NAME 进一步过滤）
  const conditions = [eq(platformAccounts.platform, "wechat")];
  if (accountName) conditions.push(eq(platformAccounts.accountName, accountName));
  const existing = await db.select().from(platformAccounts).where(and(...conditions));

  if (existing.length === 0) {
    console.error(`❌ 未找到 wechat 账号${accountName ? ` (account_name=${accountName})` : ""}`);
    process.exit(1);
  }
  if (existing.length > 1 && !accountName) {
    console.error(`❌ 找到 ${existing.length} 个 wechat 账号，请加 ACCOUNT_NAME env 指定`);
    existing.forEach((r) => console.error(`  - id=${r.id} name=${r.accountName}`));
    process.exit(1);
  }

  const target = existing[0];
  const newCreds = JSON.stringify({ appId, appSecret });
  const encrypted = encryptCredentials(newCreds);

  // 自检：encrypt → decrypt round-trip 必须返回原明文，否则 key 配置有问题
  const roundTrip = decryptCredentials(encrypted);
  if (roundTrip !== newCreds) {
    console.error("❌ encrypt → decrypt round-trip 不一致，CREDENTIALS_KEY / JWT_SECRET 配置有问题");
    process.exit(2);
  }

  await db
    .update(platformAccounts)
    .set({ credentials: encrypted, isVerified: false, updatedAt: new Date() })
    .where(eq(platformAccounts.id, target.id));

  logger.info({ id: target.id, appId, accountName: target.accountName }, "Q.9 wechat credentials 已重新加密");
  console.log(`✅ 更新成功 id=${target.id} account_name="${target.accountName}"`);
  console.log(`   isVerified 已重置为 false（用户下次发布时会自动 verify）`);
  console.log(`   重新加密 credentials 长度: ${encrypted.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ 顶层异常:", err instanceof Error ? err.message : err);
  process.exit(1);
});
