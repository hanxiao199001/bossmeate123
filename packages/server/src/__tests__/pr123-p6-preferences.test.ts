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
function readWeb(rel: string): string { return readFileSync(join(__dirname, "../../../../apps/web/src", rel), "utf8"); }

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
    expect(src).toMatch(/explicitTemplateId\s*=\s*explicitTemplateId\s*\?\?\s*getDefaultTemplateId/);
  });

  it("用户显式选 template 时写回 preference（下次默认）", () => {
    expect(src).toMatch(/setPreference\(context\.tenantId,\s*"default_template"/);
    expect(src).toMatch(/mdId\s*&&\s*mdId\s*!==\s*pref/);
  });

  it("含 PR #123 注释", () => {
    expect(src).toMatch(/PR #123 P6/);
  });
});

describe("PR #123 boot 接入 + 前端", () => {
  const idx = readSrc("index.ts");
  const chat = readWeb("pages/ChatPage.tsx");

  it("index.ts 注册 preferencesRoutes 到 protectedApp", () => {
    expect(idx).toMatch(/preferencesRoutes/);
    expect(idx).toMatch(/protectedApp\.register\(preferencesRoutes/);
  });

  it("ChatPage 加载时 fetch /preferences/default_template", () => {
    expect(chat).toMatch(/api\.get[\s\S]{0,80}\/preferences\/default_template/);
  });

  it("ChatPage 用户切模板后自动 PUT /preferences/default_template", () => {
    expect(chat).toMatch(/api\.put[\s\S]{0,80}\/preferences\/default_template[\s\S]{0,80}value:\s*templateId/);
  });

  it("ChatPage fetch 失败时 fallback 到 isDefault（向后兼容）", () => {
    expect(chat).toMatch(/list\.find\(\(t\) => t\.isDefault\)/);
  });
});
