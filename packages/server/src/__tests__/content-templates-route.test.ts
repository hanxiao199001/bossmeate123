/**
 * PR Q.2：content_templates 路由 + schema + admin UI 防回归测试。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.2: content_templates schema + 路由", () => {
  it("migrate.ts 含 content_templates 表创建 + 4 系统模板 seed (user 5-5 拍板 A+B+C+E)", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS content_templates/);
    expect(src).toMatch(/'shunshi-style'/);          // A 学术权威
    expect(src).toMatch(/'marketing-conversion'/);   // B 营销转化
    expect(src).toMatch(/'popular-science'/);        // C 科普轻松
    expect(src).toMatch(/'industry-vertical'/);      // E 行业垂直
    expect(src).toMatch(/platform_accounts ADD COLUMN template_id/);
    expect(src).toMatch(/section_count INTEGER NOT NULL/);
    expect(src).toMatch(/structure_json JSONB NOT NULL/);
    expect(src).toMatch(/chart_config JSONB NOT NULL/);
    expect(src).toMatch(/image_strategy JSONB NOT NULL/);
  });

  it("schema.ts 导出 contentTemplates + 6 jsonb 字段 + platformAccounts.templateId", async () => {
    const src = await readSrc("../models/schema.ts");
    expect(src).toMatch(/export const contentTemplates = pgTable/);
    expect(src).toMatch(/sectionCount:\s*integer/);
    expect(src).toMatch(/structureJson:\s*jsonb/);
    expect(src).toMatch(/chartConfig:\s*jsonb/);
    expect(src).toMatch(/imageStrategy:\s*jsonb/);
    expect(src).toMatch(/isDefault:\s*boolean/);
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
