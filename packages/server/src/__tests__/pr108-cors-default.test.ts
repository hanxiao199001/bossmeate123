/**
 * PR #108（5-9 hotfix 永久）：CORS 默认值含 boss-mates.com 防回归。
 *
 * Root cause：5-9 prod 事故 — .env 缺 ALLOWED_ORIGINS → fallback 仅 localhost
 * → 浏览器 CORS reject → user 看到白屏 + "没有网络"。
 *
 * 本 test 锁定 env.ts default 永远含 boss-mates.com，防未来 refactor 误删。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}
function readRoot(rel: string): string {
  return readFileSync(join(__dirname, "../../../..", rel), "utf8");
}

describe("PR #108: env.ts ALLOWED_ORIGINS default 含 boss-mates.com", () => {
  const src = readSrc("config/env.ts");

  it("default 含 https://boss-mates.com", () => {
    expect(src).toMatch(/default\([\s\S]*?https:\/\/boss-mates\.com/);
  });

  it("default 含 https://api.boss-mates.com", () => {
    expect(src).toMatch(/https:\/\/api\.boss-mates\.com/);
  });

  it("default 仍含 localhost dev origins（开发环境兼容）", () => {
    expect(src).toMatch(/http:\/\/localhost:5173/);
    expect(src).toMatch(/http:\/\/localhost:3000/);
  });

  it("含 5-9 事故 root cause 注释（防未来 refactor 误删 default）", () => {
    expect(src).toMatch(/5-9.*事故|prod 事故/);
    expect(src).toMatch(/CORS reject|跨域/);
  });
});

describe("PR #108: .env.example 加 ALLOWED_ORIGINS 模板", () => {
  const env = readRoot(".env.example");

  it(".env.example 含 ALLOWED_ORIGINS 行", () => {
    expect(env).toMatch(/ALLOWED_ORIGINS=https:\/\/boss-mates\.com/);
  });

  it(".env.example 含强制提醒注释（PR #108 标记）", () => {
    expect(env).toMatch(/PR #108/);
    expect(env).toMatch(/boss-mates\.com/);
  });
});
