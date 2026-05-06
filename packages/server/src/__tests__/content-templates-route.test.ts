/**
 * PR Q.2：content_templates 路由 + schema + admin UI 防回归测试。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.2: content_templates schema + 路由", () => {
  it("migrate.ts 含 content_templates 表创建 + 3 全局模板 seed", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS content_templates/);
    expect(src).toMatch(/'shunshi-default'/);
    expect(src).toMatch(/'academic-rigor'/);
    expect(src).toMatch(/'marketing-breakthrough'/);
    expect(src).toMatch(/platform_accounts ADD COLUMN template_id/);
  });

  it("schema.ts 导出 contentTemplates + platformAccounts.templateId", async () => {
    const src = await readSrc("../models/schema.ts");
    expect(src).toMatch(/export const contentTemplates = pgTable/);
    expect(src).toMatch(/templateId:\s*uuid\("template_id"\)/);
  });

  it("routes/templates.ts 含 OR(isNull, eq) 全局可见性 + 该 tenant 自定义", async () => {
    const src = await readSrc("../routes/templates.ts");
    expect(src).toMatch(/contentTemplatesRoutes/);
    expect(src).toMatch(/isNull\(contentTemplates\.tenantId\)/);
  });

  it("index.ts 注册 content-templates 路由", async () => {
    const src = await readSrc("../index.ts");
    expect(src).toMatch(/contentTemplatesRoutes/);
    expect(src).toMatch(/\/content-templates/);
  });

  it("routes/accounts.ts updateAccountSchema 接 templateId", async () => {
    const src = await readSrc("../routes/accounts.ts");
    expect(src).toMatch(/templateId:\s*z\.string\(\)\.uuid\(\)/);
  });
});
