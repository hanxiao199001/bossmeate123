/**
 * 5-23 hotfix — ContentDetailPage 2 bug 防回归.
 *
 * Bug 1: canPublish 加 'generated' (推荐池文章 status='generated' 能发, 不再灰按钮)
 * Bug 2: 返回 link 用 navigate(-1) (来路 /workbench 就回 /workbench, 不写死 /content)
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("5-23 hotfix: ContentDetailPage canPublish + 返回", () => {
  it("Bug 1: canPublish 含 'generated' (state-machine 新状态)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    // canPublish 必含 generated + 历史兼容 approved + draft
    expect(src).toMatch(
      /canPublish\s*=[\s\S]{0,200}content\.status === "generated"[\s\S]{0,100}content\.status === "approved"[\s\S]{0,100}content\.status === "draft"/
    );
  });

  it("Bug 2: 顶部 nav 用 navigate(-1) 不写死 /content", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    // 主 nav 区域 (line ~535) 应用 button + navigate(-1), 非 <Link to="/content">
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*navigate\(-1\)\}[\s\S]{0,200}← 返回/);
    // error fallback (无 content) 仍可保留 Link to="/content" (无 history 时安全)
    // 不强制断言, 但确保 主 nav "返回列表" 字面已替换
    expect(src).not.toMatch(/<Link to="\/content"[\s\S]{0,80}← 返回列表/);
  });

  it("canEdit 不动 — 不应含 'generated' (保 state-machine 语义, 生成文章不编辑)", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ContentDetailPage.tsx");
    // canEdit 应只含 draft + reviewing, 不能加 generated (那样会破坏 state machine)
    const canEditMatch = src.match(/canEdit\s*=[\s\S]{0,300}content\.status === "draft"[\s\S]{0,100}content\.status === "reviewing"\s*\)/);
    expect(canEditMatch).not.toBeNull();
    // 该段块内不应含 generated
    expect(canEditMatch![0]).not.toMatch(/generated/);
  });
});
