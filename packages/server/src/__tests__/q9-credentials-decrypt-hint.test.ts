/**
 * PR Q.9：凭证解密失败错误信息加强 + admin script 防回归。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(48),
    CREDENTIALS_KEY: undefined,
    LOG_LEVEL: "error",
    NODE_ENV: "test",
    PORT: 3000,
    API_PREFIX: "/api",
    DATABASE_URL: "postgres://test/test",
  },
}));

const { encryptCredentials, decryptCredentials } = await import("../utils/crypto.js");

describe("PR Q.9: encrypt → decrypt round-trip", () => {
  it("正常 round-trip OK", () => {
    const enc = encryptCredentials(JSON.stringify({ appId: "wx123", appSecret: "abc" }));
    expect(decryptCredentials(enc)).toBe(JSON.stringify({ appId: "wx123", appSecret: "abc" }));
  });

  it("用错 key 解密 → 错误信息含 admin script 修复提示", () => {
    const enc = encryptCredentials("foo");
    // 用别的 key 解密 → authTag 失败
    expect(() => decryptCredentials(enc, "wrong-key-32-chars-xxxxxxxxxxxx")).toThrow(/scripts\/update-wechat-config\.ts/);
  });

  it("CREDENTIALS_KEY 未设时错误信息含 fallback 提示", () => {
    const enc = encryptCredentials("bar");
    expect(() => decryptCredentials(enc, "another-wrong-key-aaaaaaaaaaaaa")).toThrow(/JWT_SECRET.*独立 CREDENTIALS_KEY/);
  });
});

async function read(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.9: update-wechat-config.ts admin script 防回归", () => {
  it("脚本含 env vars 校验 + encrypt + UPDATE + round-trip 自检", async () => {
    const src = await read("../../scripts/update-wechat-config.ts");
    expect(src).toMatch(/WECHAT_APP_ID/);
    expect(src).toMatch(/WECHAT_APP_SECRET/);
    expect(src).toMatch(/encryptCredentials/);
    expect(src).toMatch(/round.?trip|roundTrip/);
    expect(src).toMatch(/\.update\(platformAccounts\)/);
  });
});
