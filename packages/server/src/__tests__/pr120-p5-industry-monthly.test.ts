/**
 * PR #120 P5 行业月度 cron 单元 + 静态校验。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(48), LOG_LEVEL: "error", NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", DATABASE_URL: "postgres://t/t" },
}));

const { INDUSTRIES, INDUSTRY_TEMPLATE_MAP } = await import("../services/industry-monthly/topic-generator.js");

describe("P5 INDUSTRIES + 模板绑定", () => {
  it("4 行业固定: medical / it / law / education", () => {
    expect(INDUSTRIES).toEqual(["medical", "it", "law", "education"]);
  });

  it("4 行业模板绑定（user spec 5-14）：medical=A / it=E / law=A / education=C", () => {
    expect(INDUSTRY_TEMPLATE_MAP.medical).toBe("shunshi-style");        // A
    expect(INDUSTRY_TEMPLATE_MAP.it).toBe("industry-vertical");          // E
    expect(INDUSTRY_TEMPLATE_MAP.law).toBe("shunshi-style");             // A
    expect(INDUSTRY_TEMPLATE_MAP.education).toBe("popular-science");     // C
  });
});

describe("P5 topic-generator 静态约束（user 强约束）", () => {
  it("源代码含 5 项严格 prompt 约束", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/topic-generator.ts", import.meta.url), "utf8");
    // 1. 学术专业不 sensational
    expect(src).toMatch(/学术专业|sensational|震惊体|标题党/);
    // 2. 50 个分散不重复
    expect(src).toMatch(/分散不重复|覆盖子领域/);
    expect(src).toMatch(/TOPIC_COUNT\s*=\s*50/);
    // 3. 12-30 字
    expect(src).toMatch(/MIN_LEN\s*=\s*12/);
    expect(src).toMatch(/MAX_LEN\s*=\s*30/);
    // 4. few-shot 引导
    expect(src).toMatch(/INDUSTRY_FEW_SHOT/);
    // 5. JSON 输出 + 禁止 markdown
    expect(src).toMatch(/纯 JSON 数组|禁止 markdown 包裹/);
  });

  it("4 行业各 ≥3 few-shot 示例", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/topic-generator.ts", import.meta.url), "utf8");
    // 每个行业至少 3 行 few-shot 字符串
    for (const ind of ["medical:", "it:", "law:", "education:"]) {
      const idx = src.indexOf(`  ${ind}`);
      expect(idx).toBeGreaterThan(0);
    }
  });

  it("解析后过滤：长度 12-30 + 去重 + 数量 ≥10 才返回", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/topic-generator.ts", import.meta.url), "utf8");
    expect(src).toMatch(/seen\.has\(trimmed\)/); // 去重
    expect(src).toMatch(/trimmed\.length < MIN_LEN \|\| trimmed\.length > MAX_LEN/);
    expect(src).toMatch(/topics\.length < 10/); // 兜底
  });
});

describe("P5 cron-handler 静态校验", () => {
  it("含 runIndustryBatch / runAllIndustriesMonthly / cronMonthlyAllTenants", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/cron-handler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export async function runIndustryBatch/);
    expect(src).toMatch(/export async function runAllIndustriesMonthly/);
    expect(src).toMatch(/export async function cronMonthlyAllTenants/);
  });

  it("接 P4 batch service createBatch（强依赖）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/cron-handler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import\s*\{[^}]*createBatch[^}]*\}\s*from\s*["']\.\.\/batch\/batch-service/);
    expect(src).toMatch(/createBatch\(/);
  });

  it("template 绑定行业 + journalId 缺则 AI 推荐", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/cron-handler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/INDUSTRY_TEMPLATE_MAP\[args\.industry\]/);
    expect(src).toMatch(/journalId:\s*null/);
  });

  it("cronMonthlyAllTenants 找 active tenant 的 owner user", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/industry-monthly/cron-handler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/eq\(tenants\.status,\s*"active"\)/);
    expect(src).toMatch(/eq\(users\.role,\s*"owner"\)/);
  });
});

describe("P5 admin trigger route", () => {
  it("含 POST /admin/industry-monthly/trigger + admin guard + 5 industry enum", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/industry-monthly.ts", import.meta.url), "utf8");
    expect(src).toMatch(/post\("\/admin\/industry-monthly\/trigger"/);
    expect(src).toMatch(/isAdmin\(request\.user\.role\)/);
    expect(src).toMatch(/z\.enum\(\["medical",\s*"it",\s*"law",\s*"education",\s*"all"\]\)/);
    expect(src).toMatch(/runAllIndustriesMonthly|runIndustryBatch/);
  });

  it("含 GET /admin/industry-monthly/industries（列出 4 行业）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../routes/industry-monthly.ts", import.meta.url), "utf8");
    expect(src).toMatch(/get\("\/admin\/industry-monthly\/industries"/);
  });
});

describe("P5 scheduler cron 注册 + handler", () => {
  it("scheduler 含 'industry-monthly' job type + cron pattern '0 0 1 * *' BJ", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/scheduler.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"industry-monthly"/);
    expect(src).toMatch(/industry-monthly-schedule/);
    expect(src).toMatch(/"0 0 1 \* \*"/);
    expect(src).toMatch(/Asia\/Shanghai/);
    expect(src).toMatch(/cronMonthlyAllTenants/);
  });
});

describe("P5 boot 接入 (index.ts)", () => {
  it("index.ts 含 industryMonthlyRoutes 注册到 protectedApp", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/industryMonthlyRoutes/);
    expect(src).toMatch(/protectedApp\.register\(industryMonthlyRoutes/);
  });
});
