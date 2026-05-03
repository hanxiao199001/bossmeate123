/**
 * Tenant 级 feature flag —— B.5
 *
 * isSalesAgentEnabled(tenantId) = env.SALES_AGENT_ENABLED && tenant_feature_flags.sales_agent_enabled
 *
 * 双 AND：全局 env 是总闸（生产关掉一秒就全停），tenant flag 是白名单（默认 false）。
 * 表无记录 = false（合规护城河，新租户必须显式开启灰度）。
 *
 * 5s in-memory cache（Map + Date.now()）— 避免每条 inbound 都打 DB。
 */
import { and, eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { tenantFeatureFlags } from "../models/schema.js";
import { env } from "../config/env.js";

const TTL_MS = 5_000;
const cache = new Map<string, { value: boolean; loadedAt: number }>();

/** 测试 / 强制刷新用。 */
export function clearFeatureFlagCache(): void {
  cache.clear();
}

async function loadFlag(tenantId: string, flagName: string): Promise<boolean> {
  const key = `${tenantId}:${flagName}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.value;
  const [row] = await db
    .select({ enabled: tenantFeatureFlags.enabled })
    .from(tenantFeatureFlags)
    .where(and(eq(tenantFeatureFlags.tenantId, tenantId), eq(tenantFeatureFlags.flagName, flagName)))
    .limit(1);
  const value = row?.enabled === true; // 表无记录 → false（白名单制）
  cache.set(key, { value, loadedAt: Date.now() });
  return value;
}

/**
 * AI 销售总开关 = 全局 env && tenant flag。
 * env=false → 直接返 false（不走 DB），全局总闸优先。
 * env=true → 查 tenant_feature_flags.sales_agent_enabled。
 */
export async function isSalesAgentEnabled(tenantId: string): Promise<boolean> {
  if (!env.SALES_AGENT_ENABLED) return false;
  return await loadFlag(tenantId, "sales_agent_enabled");
}
