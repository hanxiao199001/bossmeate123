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
import { decryptCredentials, encryptCredentials } from "../../utils/crypto.js";
import { logger } from "../../config/logger.js";

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

/**
 * 把 patch 合并进账号已解密的 credentials, 重新 AES-GCM 加密写回 platform_accounts.credentials.
 *
 * 用途: token 刷新后持久化新 token (而非每次发布重新 fetch — 浪费配额, 且 OAuth 平台会丢 refresh_token).
 *   - wechat: { accessToken, tokenExpiresAt }
 *   - douyin OAuth: { accessToken, refreshToken, tokenExpiresAt, openId }
 *
 * patch 只覆盖传入字段, 其余 credentials 字段保留 (如 appId/appSecret/clientKey).
 * 返回合并后的明文 credentials, 调用方可直接拿新 token 继续用.
 */
export async function persistAccountCredentials(
  accountId: string,
  tenantId: string,
  patch: Record<string, any>,
): Promise<Record<string, any>> {
  const [row] = await db
    .select()
    .from(platformAccounts)
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new Error(`persistAccountCredentials: platform_account 不存在 ${accountId}`);

  const current = decryptCredentialField(row.credentials);
  const merged = { ...current, ...patch };
  // 与 routes/accounts.ts 存储约定一致: 加密串写进 jsonb 列.
  const encrypted = encryptCredentials(JSON.stringify(merged));

  await db
    .update(platformAccounts)
    .set({ credentials: encrypted as any, updatedAt: new Date() })
    .where(and(eq(platformAccounts.id, accountId), eq(platformAccounts.tenantId, tenantId)));

  logger.info({ accountId, platform: row.platform, fields: Object.keys(patch) }, "platform_account.credentials.persisted");
  return merged;
}

export interface RefreshedToken {
  accessToken: string;
  /** token 有效期 (秒). 据此算 tokenExpiresAt 落库. */
  expiresInSec: number;
  /** 一并持久化的其他字段 (如 OAuth refresh_token / openId). */
  extra?: Record<string, any>;
}

/**
 * 通用"取有效 access_token"模式 — 各平台 token 刷新复用此骨架, 只需提供 refresh() 实现.
 *
 * 逻辑: credentials.accessToken 还剩 > skewMs 就直接返回 (命中缓存);
 *   否则调 refresh() 拿新 token → 算 tokenExpiresAt → persistAccountCredentials 落库 → 返回新 token.
 *
 * refresh() 由各平台实现:
 *   - wechat: GET /cgi-bin/token?grant_type=client_credential (拿 access_token + expires_in)
 *   - douyin: POST /oauth/refresh_token/ (用 refresh_token 换新 access_token)
 */
export async function ensureFreshAccessToken(opts: {
  accountId: string;
  tenantId: string;
  credentials: Record<string, any>;
  refresh: () => Promise<RefreshedToken>;
  /** 提前量, 默认 5 分钟 — 剩余有效期低于此值就刷新, 避免临界过期. */
  skewMs?: number;
}): Promise<string> {
  const { accountId, tenantId, credentials, refresh } = opts;
  const skewMs = opts.skewMs ?? 5 * 60 * 1000;

  const cached = credentials.accessToken as string | undefined;
  const expiresRaw = credentials.tokenExpiresAt as string | number | undefined;
  if (cached && expiresRaw !== undefined && expiresRaw !== null) {
    const exp = new Date(expiresRaw).getTime();
    if (Number.isFinite(exp) && exp - Date.now() > skewMs) {
      return cached;
    }
  }

  const fresh = await refresh();
  const tokenExpiresAt = new Date(Date.now() + fresh.expiresInSec * 1000).toISOString();
  await persistAccountCredentials(accountId, tenantId, {
    accessToken: fresh.accessToken,
    tokenExpiresAt,
    ...(fresh.extra ?? {}),
  });
  return fresh.accessToken;
}
