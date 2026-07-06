/**
 * PR #123 V2 P6 模版偏好（5-15）防回归。
 * - schema + migration + service + route + article-skill 接入 + 前端 fetch/PUT
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string { return readFileSync(join(__dirname, "..", rel), "utf8"); }
// 7-06: readWeb 已删 — 唯一调用方(ChatPage 前端断言)随 ChatPage.tsx(43668dd 删除)一并移除。

describe("PR #123 schema + migration", () => {
  const schema = readSrc("models/schema.ts");
  const migrate = readSrc("models/migrate.ts");

  it("schema.ts 含 tenantPreferences pgTable + PK 复合 (tenant_id, preference_key)", () => {
    expect(schema).toMatch(/export const tenantPreferences = pgTable/);
    expect(schema).toMatch(/primaryKey\(\{\s*columns:\s*\[table\.tenantId,\s*table\.preferenceKey\]\s*\}\)/);
  });

  it("migrate.ts 含 CREATE TABLE tenant_preferences + PRIMARY KEY 复合", () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS tenant_preferences/);
    expect(migrate).toMatch(/PRIMARY KEY \(tenant_id,\s*preference_key\)/);
  });
});

describe("PR #123 service/preferences.ts", () => {
  const src = readSrc("services/preferences.ts");

  it("含 getPreference + setPreference + clearPreferenceCache", () => {
    expect(src).toMatch(/export async function getPreference/);
    expect(src).toMatch(/export async function setPreference/);
    expect(src).toMatch(/export function clearPreferenceCache/);
  });

  it("setPreference 用 onConflictDoUpdate (upsert，避免唯一键冲突)", () => {
    expect(src).toMatch(/onConflictDoUpdate/);
    expect(src).toMatch(/target:\s*\[tenantPreferences\.tenantId,\s*tenantPreferences\.preferenceKey\]/);
  });

  it("30 min in-memory cache（防 ChatPage 加载频调 DB）", () => {
    expect(src).toMatch(/CACHE_TTL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
    expect(src).toMatch(/cache\.set/);
    expect(src).toMatch(/cache\.get/);
    expect(src).toMatch(/Date\.now\(\)\s*<\s*hit\.expiresAt/);
  });
});

describe("PR #123 routes/preferences.ts", () => {
  const src = readSrc("routes/preferences.ts");

  it("含 GET /preferences + GET/PUT /preferences/:key", () => {
    expect(src).toMatch(/get\("\/preferences",/);
    expect(src).toMatch(/get\("\/preferences\/:key"/);
    expect(src).toMatch(/put\("\/preferences\/:key"/);
  });

  it("PUT 校验 key 白名单（防滥写任意 key）", () => {
    expect(src).toMatch(/ALLOWED_KEYS/);
    expect(src).toMatch(/"default_template"/);
    expect(src).toMatch(/KEY_NOT_ALLOWED/);
  });

  it("key 格式正则校验 + value zod schema", () => {
    expect(src).toMatch(/KEY_REGEX/);
    expect(src).toMatch(/putBodySchema.*z\.object/s);
  });
});

describe("PR #123 article-skill 接入", () => {
  const src = readSrc("services/skills/article-skill.ts");

  it("templateId fallback 链：metadata → preference → default", () => {
    expect(src).toMatch(/getPreference\(context\.tenantId,\s*"default_template"/);
    // 7-06 断言跟进: 最终兜底 `?? getDefaultTemplateId` 已于 PR-G(模板轮换)演进为
    //   `?? (env.ARTICLE_TEMPLATE_ROTATION === "false" ? getDefaultTemplateId() : pickRotatingTemplateId())`。
    //   三级兜底(metadata→preference→default/rotation)仍在, 断言更新到现状。
    expect(src).toMatch(/explicitTemplateId\s*=\s*explicitTemplateId\s*\?\?/);
    expect(src).toMatch(/getDefaultTemplateId\(\)/);
  });

  it("用户显式选 template 时写回 preference（下次默认）", () => {
    expect(src).toMatch(/setPreference\(context\.tenantId,\s*"default_template"/);
    expect(src).toMatch(/mdId\s*&&\s*mdId\s*!==\s*pref/);
  });

  it("含 PR #123 注释", () => {
    expect(src).toMatch(/PR #123 P6/);
  });
});

describe("PR #123 boot 接入", () => {
  const idx = readSrc("index.ts");

  it("index.ts 注册 preferencesRoutes 到 protectedApp", () => {
    expect(idx).toMatch(/preferencesRoutes/);
    expect(idx).toMatch(/protectedApp\.register\(preferencesRoutes/);
  });

  // 7-06 死测试清理: 删 3 条 ChatPage 前端断言 + readWeb("pages/ChatPage.tsx") —
  //   断言目标 apps/web/src/pages/ChatPage.tsx 已于 43668dd 删除(/chat 整页下线)。
  //   原 readWeb 在 describe body 即 ENOENT crash-load, 连累本文件所有后端断言(schema/service/route/article-skill)整套没跑。
  //   模板偏好后端逻辑仍在(describe 1-4 保留验证); 前端偏好 UI 已随 ChatPage 下线, 无存活取代页可断言, 故删。
});
