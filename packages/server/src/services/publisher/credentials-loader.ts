/**
 * 凭证解密统一入口
 *
 * 所有"读加密凭证并解密用于调用外部平台 API"的路径必须走这里。
 * 这样加密方案、字段命名、字段迁移都只改一处。
 *
 * 规则：
 *  - 如果 DB 里的 credentials 是字符串（期望格式 "iv:authTag:ciphertext"），走 decryptCredentials
 *  - 如果已经是 object（历史未加密数据），直接返回
 *  - 解密失败抛 Error（调用方决定要不要兜底），不要静默回退到密文，那样后续调 API 必然失败
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { platformAccounts } from "../../models/schema.js";
import { decryptCredentials } from "../../utils/crypto.js";

export interface LoadedAccount {
  id: string;
  tenantId: string;
  platform: string;
  accountName: string;
  credentials: Record<string, any>;
  status: string;
  isVerified: boolean | null;
  capability: string | null;
  metadata: Record<string, any>;
}

/**
 * 按 id 加载账号 + 解密后的 credentials。找不到返回 null。
 */
export async function loadDecryptedAccount(
  accountId: string,
  tenantId: string
): Promise<LoadedAccount | null> {
  const [row] = await db
    .select()
    .from(platformAccounts)
    .where(
      and(
        eq(platformAccounts.id, accountId),
        eq(platformAccounts.tenantId, tenantId)
      )
    )
    .limit(1);

  if (!row) return null;
  return hydrateAccount(row);
}

/**
 * 把已读出的 drizzle 行解密成 LoadedAccount。
 * 供批量查询（已 select 一次）避免二次 DB round-trip 的场景使用。
 */
export function hydrateAccount(row: {
  id: string;
  tenantId: string;
  platform: string;
  accountName: string;
  credentials: unknown;
  status: string;
  isVerified: boolean | null;
  capability?: string | null;
  metadata?: unknown;
}): LoadedAccount {
  return {
    id: row.id,
    tenantId: row.tenantId,
    platform: row.platform,
    accountName: row.accountName,
    credentials: decryptCredentialField(row.credentials),
    status: row.status,
    isVerified: row.isVerified,
    capability: (row.capability as string | null) ?? null,
    metadata: (row.metadata as Record<string, any>) ?? {},
  };
}

/**
 * 解密 credentials 字段本身。字符串走 AES-GCM，对象直接返回（向后兼容）。
 */
export function decryptCredentialField(raw: unknown): Record<string, any> {
  if (typeof raw === "string") {
    const plain = decryptCredentials(raw);
    return JSON.parse(plain);
  }
  return (raw as Record<string, any>) ?? {};
}
