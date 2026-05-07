/**
 * PR Q.7.2：shunshi-style palette 注入 + 4 套 css_theme.palette 7 字段 防回归。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.7.2: shunshi inline CSS palette 化（4 套主色调真差异化）", () => {
  it("BLUE / RED const 改为 占位字符串（运行时 .replaceAll 注入）", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/const RED = "\{\{ACCENT\}\}"/);
    expect(src).toMatch(/const BLUE = "\{\{PRIMARY\}\}"/);
    expect(src).toMatch(/PLACEHOLDER_BG = "linear-gradient\([^"]*\{\{PRIMARY_BG\}\}/);
  });

  it("generateShunshiStyleHtml 末尾 .replaceAll 占位 → palette 真值（5 替换）", async () => {
    const src = await readSrc("../services/publisher/adapters/shunshi-style-template.ts");
    expect(src).toMatch(/\.replaceAll\("\{\{PRIMARY\}\}", palette\.primary\)/);
    expect(src).toMatch(/\.replaceAll\("\{\{ACCENT\}\}", palette\.accent\)/);
    expect(src).toMatch(/\.replaceAll\("\{\{PRIMARY_BG\}\}", palette\.primaryBg\)/);
    expect(src).toMatch(/\.replaceAll\("#FAFAFA", palette\.cardBg\)/);
    expect(src).toMatch(/\.replaceAll\("#F5F5F5", palette\.borderColor\)/);
  });

  it("chart-config-resolver PALETTES 4 套都含 7 字段（primaryBg/cardBg/borderColor）", async () => {
    const src = await readSrc("../services/skills/chart-config-resolver.ts");
    expect(src).toMatch(/primaryBg:\s*string/);
    expect(src).toMatch(/cardBg:\s*string/);
    expect(src).toMatch(/borderColor:\s*string/);
    // 4 套主色调真值
    expect(src).toMatch(/"blue-gray":\s*\{[^}]*primary:\s*"#2C5F8D"/);
    expect(src).toMatch(/"orange-red":\s*\{[^}]*primary:\s*"#DC143C"/);
    expect(src).toMatch(/"cyan-mint":\s*\{[^}]*primary:\s*"#F39C12"/);
    expect(src).toMatch(/"purple-indigo":\s*\{[^}]*primary:\s*"#6B46C1"/);
  });

  it("migrate.ts 4 套 css_theme.palette UPDATE 7 字段（jsonb_set）", async () => {
    const src = await readSrc("../models/migrate.ts");
    expect(src).toMatch(/PR Q\.7\.2/);
    expect(src).toMatch(/\{palette,primaryBg\}/);
    expect(src).toMatch(/\{palette,cardBg\}/);
    expect(src).toMatch(/\{palette,borderColor\}/);
    expect(src).toMatch(/jsonb_set/);
    expect(src).toMatch(/"#DC143C"/);  // B 营销 primary
    expect(src).toMatch(/"#F39C12"/);  // C 科普 primary
  });
});
