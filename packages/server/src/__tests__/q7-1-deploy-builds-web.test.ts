/**
 * PR Q.7.1：deploy-with-fallback.sh 必含前端 build（防回归）。
 * 5-7 user 验收暴露 deploy:smart 长存 bug：只 build server 不 build web。
 */
import { describe, it, expect } from "vitest";

describe("PR Q.7.1: deploy:smart 必 build 前端", () => {
  it("scripts/deploy-with-fallback.sh 含 pnpm --filter @bossmate/web build", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../../../scripts/deploy-with-fallback.sh", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/pnpm --filter @bossmate\/web build/);
    expect(src).toMatch(/PR Q\.7\.1/);
    // server build 仍在
    expect(src).toMatch(/pnpm --filter @bossmate\/server build/);
  });
});
