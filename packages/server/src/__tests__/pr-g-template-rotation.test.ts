/**
 * PR-G — 文章模板轮换. pickRotatingTemplateId 在已注册模板间轮换.
 */
import { describe, it, expect } from "vitest";
import { pickRotatingTemplateId, listTemplates, getDefaultTemplateId } from "../services/skills/template-registry.js";

describe("PR-G: 模板轮换", () => {
  it("pickRotatingTemplateId 返回已注册模板 id", () => {
    const ids = new Set(listTemplates().map((t) => t.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    expect(ids.has(pickRotatingTemplateId(() => 0))).toBe(true);
    expect(ids.has(pickRotatingTemplateId(() => 0.99))).toBe(true);
  });
  it("不同 random 覆盖到多个模板 (不止默认)", () => {
    const got = new Set<string>();
    for (let i = 0; i < listTemplates().length; i++) {
      got.add(pickRotatingTemplateId(() => i / listTemplates().length));
    }
    expect(got.size).toBeGreaterThanOrEqual(2); // 轮换到多个, 不全是默认
    expect(got.size).toBe(listTemplates().length);
  });
  it("默认 id 仍是 shunshi-style (未改 getDefaultTemplateId)", () => {
    expect(getDefaultTemplateId()).toBe("shunshi-style");
  });
});
