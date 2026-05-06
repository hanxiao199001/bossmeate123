/**
 * PR Q.0：article→video auto-bridge 拆按钮防回归。
 * 确保 chat.ts 不再自动触发视频，articles.ts 有用户手动触发端点。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.0: 拆按钮防回归", () => {
  it("routes/chat.ts 不再调用 triggerVideoFromArticle（auto-bridge 已下线）", async () => {
    const src = await readSrc("../routes/chat.ts");
    expect(src).not.toMatch(/triggerVideoFromArticle\s*\(/);
    expect(src).toMatch(/PR Q\.0/);
  });

  it("routes/articles.ts 含 POST /:id/generate-video 用户手动触发端点", async () => {
    const src = await readSrc("../routes/articles.ts");
    expect(src).toMatch(/generate-video/);
    expect(src).toMatch(/triggerVideoFromArticle/);
    expect(src).toMatch(/NO_JOURNAL_ID/);
  });

  it("articles 路由已注册到 protectedApp", async () => {
    const src = await readSrc("../index.ts");
    expect(src).toMatch(/articlesRoutes/);
  });
});
