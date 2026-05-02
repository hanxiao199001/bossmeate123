/**
 * 守护：DEFAULT_TEMPLATE_ID 必须是 shunshi-style（task #11 V7 e2e 验证后切换）。
 *
 * 这是一个 1 行 PR 的"防回退"测试 —— 任何后续误改回 data-card 立刻 fail，提醒
 * reviewer 这是有意决策（让 V7 4 章节深度分析在所有新生成 article 默认渲染）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../models/db.js", () => ({ db: {} }));

const { DEFAULT_TEMPLATE_ID, getDefaultTemplateId, getTemplate, listTemplates } =
  await import("../services/skills/template-registry.js");

describe("DEFAULT_TEMPLATE_ID 守护", () => {
  it("必须是 shunshi-style（V7 4 章节深度分析的唯一渲染模板）", () => {
    expect(DEFAULT_TEMPLATE_ID).toBe("shunshi-style");
    expect(getDefaultTemplateId()).toBe("shunshi-style");
  });

  it("shunshi-style 必须在 registry 注册（默认指向必须存在）", () => {
    const t = getTemplate("shunshi-style");
    expect(t).not.toBeNull();
    expect(t?.id).toBe("shunshi-style");
  });

  it("data-card / storytelling / listicle 仍可显式选用（向后兼容不破坏）", () => {
    const ids = listTemplates().map((t) => t.id);
    expect(ids).toContain("data-card");
    expect(ids).toContain("storytelling");
    expect(ids).toContain("listicle");
    expect(ids).toContain("shunshi-style");
  });
});
