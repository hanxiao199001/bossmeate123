/**
 * 5-20 PR #192 — 重点期刊手动上传封面 (前后端). file-content regression.
 *   学科题图(PR#191)兜底 + 运营对高频 Top 期刊手动填封面 URL (图床).
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR #192 后端: 封面字段 + 全局期刊可改", () => {
  it("journalPatchSchema 加 coverImageUrl", async () => {
    const src = await readSrc("../routes/journals.ts");
    expect(src).toMatch(/coverImageUrl: z\.string\(\)\.url\(\)\.max\(500\)\.optional\(\)\.nullable\(\)/);
  });
  it("PATCH 放开全局期刊 (owner/admin 可改 tenantId=null)", async () => {
    const src = await readSrc("../routes/journals.ts");
    expect(src).toMatch(/\.where\(and\(eq\(journals\.id, id\), or\(eq\(journals\.tenantId, tenantId\), isNull\(journals\.tenantId\)\)\)\)/);
  });
});

describe("PR #192 前端: 封面输入 + 预览", () => {
  it("PatchPayload/EditableField 含 coverImageUrl", async () => {
    const src = await readSrc("../../../../apps/web/src/hooks/useJournalsAdmin.ts");
    expect(src).toMatch(/coverImageUrl\?: string \| null/);
    expect(src).toMatch(/"apcFee" \| "coverImageUrl"/);
  });
  // 7-08 死测试清理 (确死: 读已删文件): 删 "EditForm 封面 URL 输入框" it —
  //   目标 apps/web/src/pages/JournalsAdminPage.tsx 已删。封面字段的活断言仍在: 后端 journals.ts (coverImageUrl schema + 全局期刊 PATCH)
  //   + 前端 hooks/useJournalsAdmin.ts (PatchPayload/EditableField 含 coverImageUrl) 均保留验证; 仅已删页的 EditForm UI 断言移除。
});
