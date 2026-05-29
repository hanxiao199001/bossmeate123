/**
 * 5-29 PR #262 — token 持久化共用 helper.
 * persistAccountCredentials: 合并 patch → AES-GCM 加密写回 platform_accounts.credentials (真实 crypto round-trip).
 * ensureFreshAccessToken: 未过期命中缓存不刷新; 过期则 refresh()→持久化→返回新 token.
 * crypto 用真实实现 (只 mock env 提供密钥), db 用 fake 捕获 update payload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { CREDENTIALS_KEY: "test-credentials-key-0123456789ab", JWT_SECRET: "x".repeat(32), LOG_LEVEL: "error", NODE_ENV: "test" },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let rowCredentials: unknown = {};
const capturedUpdate: { set?: any } = {};
const updateWhere = vi.fn(async () => undefined);
const updateSet = vi.fn((v: any) => { capturedUpdate.set = v; return { where: updateWhere }; });
const updateFn = vi.fn(() => ({ set: updateSet }));
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => [{ id: "acc-1", tenantId: "t-1", platform: "douyin", credentials: rowCredentials }]) })),
      })),
    })),
    update: updateFn,
  },
}));

const { persistAccountCredentials, ensureFreshAccessToken } = await import("../services/publisher/credentials-loader.js");
const { encryptCredentials, decryptCredentials } = await import("../utils/crypto.js");

beforeEach(() => {
  capturedUpdate.set = undefined;
  updateWhere.mockClear(); updateSet.mockClear(); updateFn.mockClear();
  rowCredentials = encryptCredentials(JSON.stringify({ appId: "A", appSecret: "S", accessToken: "old-token" }));
});

describe("PR #262: persistAccountCredentials", () => {
  it("合并 patch + 加密回写, 保留原有字段 (appSecret 不丢)", async () => {
    const merged = await persistAccountCredentials("acc-1", "t-1", { accessToken: "new-token", tokenExpiresAt: "2030-01-01T00:00:00.000Z" });
    // 返回明文合并结果
    expect(merged.appId).toBe("A");
    expect(merged.appSecret).toBe("S");
    expect(merged.accessToken).toBe("new-token");
    // 写库的是加密串, 解密后字段正确
    expect(typeof capturedUpdate.set.credentials).toBe("string");
    const back = JSON.parse(decryptCredentials(capturedUpdate.set.credentials));
    expect(back.appSecret).toBe("S");
    expect(back.accessToken).toBe("new-token");
    expect(back.tokenExpiresAt).toBe("2030-01-01T00:00:00.000Z");
    expect(capturedUpdate.set.updatedAt).toBeInstanceOf(Date);
  });
});

describe("PR #262: ensureFreshAccessToken", () => {
  it("token 未过期 → 命中缓存, 不调 refresh 不写库", async () => {
    const refresh = vi.fn();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const token = await ensureFreshAccessToken({
      accountId: "acc-1", tenantId: "t-1",
      credentials: { accessToken: "cached-token", tokenExpiresAt: future },
      refresh,
    });
    expect(token).toBe("cached-token");
    expect(refresh).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("token 过期 → 调 refresh + 持久化新 token/refresh_token, 返回新 token", async () => {
    const refresh = vi.fn(async () => ({ accessToken: "fresh-token", expiresInSec: 7200, extra: { refreshToken: "rt-9", openId: "oid-9" } }));
    const past = new Date(Date.now() - 1000).toISOString();
    const token = await ensureFreshAccessToken({
      accountId: "acc-1", tenantId: "t-1",
      credentials: { accessToken: "expired", tokenExpiresAt: past },
      refresh,
    });
    expect(token).toBe("fresh-token");
    expect(refresh).toHaveBeenCalledTimes(1);
    // 持久化: 解密写库内容含新 token + refresh_token + openId
    const back = JSON.parse(decryptCredentials(capturedUpdate.set.credentials));
    expect(back.accessToken).toBe("fresh-token");
    expect(back.refreshToken).toBe("rt-9");
    expect(back.openId).toBe("oid-9");
    expect(typeof back.tokenExpiresAt).toBe("string");
  });
});
