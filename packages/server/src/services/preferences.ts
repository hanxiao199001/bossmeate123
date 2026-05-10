/**
 * PR #123 V2 P6 tenant 偏好（5-15）。
 *
 * key/value 通用接口 + 30 min in-memory cache（防 ChatPage 加载频调 DB）。
 * 首批 key：'default_template'（用户上次选的 template）
 */
import { and, eq } from "drizzle-orm";
import { db } from "../models/db.js";
import { tenantPreferences } from "../models/schema.js";
import { logger } from "../config/logger.js";

const CACHE_TTL_MS = 30 * 60 * 1000;
type Entry = { value: string; expiresAt: number };
const cache = new Map<string, Entry>();
const cacheKey = (tenantId: string, key: string): string => `${tenantId}:${key}`;

export async function getPreference(tenantId: string, key: string, defaultValue: string | null = null): Promise<string | null> {
  const ck = cacheKey(tenantId, key);
  const hit = cache.get(ck);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const [row] = await db
    .select({ value: tenantPreferences.preferenceValue })
    .from(tenantPreferences)
    .where(and(eq(tenantPreferences.tenantId, tenantId), eq(tenantPreferences.preferenceKey, key)))
    .limit(1);

  const value = row?.value ?? defaultValue;
  if (value !== null) cache.set(ck, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setPreference(tenantId: string, key: string, value: string): Promise<void> {
  await db
    .insert(tenantPreferences)
    .values({ tenantId, preferenceKey: key, preferenceValue: value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [tenantPreferences.tenantId, tenantPreferences.preferenceKey],
      set: { preferenceValue: value, updatedAt: new Date() },
    });
  cache.set(cacheKey(tenantId, key), { value, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.debug({ tenantId, key, value }, "P6 setPreference");
}

/** 测试用：清 cache */
export function clearPreferenceCache(): void { cache.clear(); }
