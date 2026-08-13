/**
 * PR-G — 文章模板轮换. pickRotatingTemplateId 在**可轮换**模板间轮换.
 *
 * ⚠️ 8-13 口径变更：轮换集 ≠ 注册集。
 * `rotationEnabled:false` 的模板仍然注册（存量内容要 getTemplate 非空、显式指定仍可用），
 * 但不参与自动轮换。所以本文件里所有"覆盖到几个模板"的断言，
 * 分母一律改成 `listRotatableTemplates()`，不能再用 `listTemplates()`。
 * （用注册集当分母 = 期望轮换到一个已下线的模板，正是要防的事。）
 */
import { describe, it, expect } from "vitest";
import {
  pickRotatingTemplateId,
  listTemplates,
  listRotatableTemplates,
  getDefaultTemplateId,
} from "../services/skills/template-registry.js";

describe("PR-G: 模板轮换", () => {
  it("pickRotatingTemplateId 返回**可轮换**模板 id", () => {
    const ids = new Set(listRotatableTemplates().map((t) => t.id));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    expect(ids.has(pickRotatingTemplateId(() => 0))).toBe(true);
    expect(ids.has(pickRotatingTemplateId(() => 0.99))).toBe(true);
  });
  it("不同 random 覆盖到全部可轮换模板 (不止默认)", () => {
    const n = listRotatableTemplates().length;
    const got = new Set<string>();
    for (let i = 0; i < n; i++) got.add(pickRotatingTemplateId(() => i / n));
    expect(got.size).toBeGreaterThanOrEqual(2); // 轮换到多个, 不全是默认
    expect(got.size).toBe(n);
  });

  it("已下线的模板仍在注册表里, 但不在轮换集里", () => {
    expect(listTemplates().length).toBeGreaterThan(listRotatableTemplates().length);
    const off = listTemplates().filter((t) => t.rotationEnabled === false).map((t) => t.id);
    const rot = listRotatableTemplates().map((t) => t.id);
    for (const id of off) expect(rot).not.toContain(id);
  });
  it("默认 id 仍是 shunshi-style (未改 getDefaultTemplateId)", () => {
    expect(getDefaultTemplateId()).toBe("shunshi-style");
  });
});
