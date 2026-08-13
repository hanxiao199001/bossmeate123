/**
 * `templateId` 合法性（8-13）—— 数据链最上游的闸。
 *
 * ## 这个字段五步之后变成了决策层的毒数据
 *
 * `A/B/C/E` 是**数字人主播人设**（形象+音色），却被 `mapTemplateLetter` 映射成
 * 「渲染模板名」；而 B/C/E 指向的三个名字从来没有实现：
 *
 * ```
 * 虚构模板名 → getTemplate() 返 null → 静默 fallback 到默认模板
 *   → 400 篇（90 天）标着假 templateId
 *   → 模板分布统计失真（真实单一化 73%，账面 55%）
 *   → 效果账本把默认模板的阅读数记在虚构 key 名下
 *   → 差点污染刚收口的轮换加权决策
 * ```
 */
import { describe, it, expect } from "vitest";

const reg = await import("../services/skills/template-registry.js");

describe("① 合法 = 真有东西渲染它（registry ∪ 独立体裁）", () => {
  it.each(["shunshi-style", "data-card", "storytelling", "listicle"])("已注册「%s」合法", (id) => {
    expect(reg.isRegisteredTemplateId(id)).toBe(true);
  });

  /**
   * journal-roundup 刻意不进 registry（它的渲染器吃多刊 RoundupData，
   * 与 registry 的 htmlGenerator 契约不同），但它**真有渲染器** → 合法。
   * 8-13 首版判据写成"在 registry 里"，把 109 条合法内容报成违规 ——
   * 判据要表达真实不变式，不是表达某一种实现方式。
   */
  it("独立体裁 journal-roundup 合法（有独立渲染器）", () => {
    expect(reg.isRegisteredTemplateId("journal-roundup")).toBe(true);
    expect(reg.getTemplate("journal-roundup")).toBeNull(); // 不在 registry 是预期
  });
});

describe("② 虚构模板名必须判非法", () => {
  it.each(["marketing-conversion", "popular-science", "industry-vertical"])(
    "「%s」非法 —— adapters/ 下根本没有这个文件",
    (id) => {
      expect(reg.isRegisteredTemplateId(id)).toBe(false);
    },
  );

  it.each(["A", "B", "C", "E"])("人设字母「%s」非法 —— 它属于 personaLetter", (id) => {
    expect(reg.isRegisteredTemplateId(id)).toBe(false);
  });

  it.each([null, undefined, "", 42, {}])("非字符串/空值「%s」非法", (v) => {
    expect(reg.isRegisteredTemplateId(v)).toBe(false);
  });
});

describe("③ 拒绝而非静默改写", () => {
  /**
   * 静默改写会让「传错了」与「传对了」在下游同样看不出来 —— 正是本案的病根：
   * getTemplate 返 null 后静默 fallback，于是 400 篇假标签一路流到决策层。
   */
  it("assertRegisteredTemplateId 对非法值抛错，错误信息要能指路", () => {
    expect(() => reg.assertRegisteredTemplateId("popular-science", "batch-worker")).toThrow(/INVALID_TEMPLATE_ID/);
    try {
      reg.assertRegisteredTemplateId("C", "batch-worker");
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("batch-worker");     // 哪里传的
      expect(msg).toContain("personaLetter");    // 该往哪放
      expect(msg).toContain("shunshi-style");    // 合法值有哪些
    }
  });

  it("合法值原样返回", () => {
    expect(reg.assertRegisteredTemplateId("data-card", "x")).toBe("data-card");
  });
});

describe("④ 独立体裁清单本身", () => {
  it("加成员前必须确认它真有渲染器 —— 改这张表是显式动作", () => {
    expect([...reg.NON_REGISTRY_GENRES]).toEqual(["journal-roundup"]);
  });
});
