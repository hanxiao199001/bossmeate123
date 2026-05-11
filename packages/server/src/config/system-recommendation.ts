/**
 * PR #130（5-13 V2.5 提前）：daily-recommendation system tenant sentinel UUIDs.
 *
 * Decision B 锁: 用固定 UUID system tenant + system user 写入 contents,
 * tenant_id NOT NULL 约束不动 (vs Decision C 加 is_recommendation 列).
 *
 * Frontend ContentPage 切到 "📅 今日推荐" tab 时, 调 GET /content?recommendation=true,
 * backend 用 SYSTEM_RECOMMENDATION_TENANT_ID 替代 request.tenantId 拉数据.
 *
 * 这两个 UUID 在 migrate.ts 末尾 idempotent INSERT (ON CONFLICT DO NOTHING).
 */

export const SYSTEM_RECOMMENDATION_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const SYSTEM_RECOMMENDATION_USER_ID = "00000000-0000-0000-0000-000000000002";
