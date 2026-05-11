/**
 * PR #132 (5-12): backend HTML 模板外链必含 target=_blank + rel=noopener noreferrer.
 * 静态 grep 防回归 — 任何 PR 改动模板若漏掉外链属性即失败.
 */
import { describe, it, expect } from "vitest";

describe("PR #132 backend HTML 模板外链新 tab + 安全 rel", () => {
  it("shunshi-style-template 期刊官网 anchor 含 target+rel", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/publisher/adapters/shunshi-style-template.ts", import.meta.url), "utf8");
    // 必含 anchor + target + rel
    expect(src).toMatch(/<a href="\$\{safe\}"\s+target="_blank"\s+rel="noopener noreferrer"/);
    // 反向防回归：不存在裸 anchor (无 target)
    expect(src).not.toMatch(/<a href="\$\{safe\}"\s+style=/);
  });

  it("wechat-article-template 期刊官网 anchor 含 target+rel", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/publisher/adapters/wechat-article-template.ts", import.meta.url), "utf8");
    expect(src).toMatch(/<a href="\$\{esc\(journal\.website\)\}"\s+target="_blank"\s+rel="noopener noreferrer"/);
  });

  it("journal-template skill 期刊官网 + 知网 anchor 全含 target+rel", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../services/skills/journal-template.ts", import.meta.url), "utf8");
    expect(src).toMatch(/<a href="\$\{esc\(j\.website\)\}"\s+target="_blank"\s+rel="noopener noreferrer"/);
    expect(src).toMatch(/<a href="\$\{esc\(j\.cnkiUrl\)\}"\s+target="_blank"\s+rel="noopener noreferrer"/);
  });
});
