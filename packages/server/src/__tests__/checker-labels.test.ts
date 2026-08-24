/**
 * 检查器人话标签 —— 8-24 首份带新内容的周报暴露的问题。
 *
 * 实测那份周报的证据区：
 * ```
 * output_health.title_placeholder  命中 2 / 已裁决 0
 * 另有 8 道闸零命中：body_truncated、placeholder_asset_in_body、ai_fallback_text…
 * ```
 * 运营看不懂，而**看不懂的行会被整段跳过 —— 连同旁边看得懂的一起**。
 */
import { describe, it, expect } from "vitest";
import { checkerLabel, missingLabels } from "../services/ops/checker-labels.js";

describe("code → 人话", () => {
  it.each([
    ["output_health.title_placeholder", "标题里有没替换掉的占位符"],
    ["body_truncated", "正文被截断了"],                    // 短 code 也要能查到
    ["output_health.body_truncated", "正文被截断了"],       // 长短同义
    ["title_body_inconsistent", "标题喊保录，而正文说这刊有风险"],
    ["placeholder_asset_in_body", "正文里混进了占位图"],
  ])("%s → %s", (code, label) => {
    expect(checkerLabel(code)).toBe(label);
  });

  it("🔴 缺映射时显示「未知检查项(code)」，绝不静默透传原始 code", () => {
    // 静默透传的话，「忘了加标签」和「它本来就叫这个名字」在页面上一模一样，
    // 没人会发现该补 —— 缺失必须可见。
    const r = checkerLabel("some_new_checker_nobody_labeled");
    expect(r).toBe("未知检查项(some_new_checker_nobody_labeled)");
    expect(r).not.toBe("some_new_checker_nobody_labeled");
  });
});

describe("🔴 守卫：新增检查器必须同步加标签", () => {
  it("红线类 reason 全部有人话标签", async () => {
    const { RED_LINE_REASONS } = await import("../services/publisher/draft-distributor.js");
    // 有一条例外：title_hard_banned 刻意不在红线名单里，但它也该有标签
    const missing = missingLabels([...RED_LINE_REASONS, "title_hard_banned"]);
    expect(missing, `这些 code 还没有人话标签：${missing.join(", ")}`).toEqual([]);
  });

  it("出稿健康闸的十项全部有标签", () => {
    const gates = [
      "title_placeholder", "body_too_short", "body_truncated", "placeholder_asset_in_body",
      "ai_fallback_text", "title_empty", "template_residue", "title_too_short",
      "fallback_phrase", "body_repetition",
    ];
    expect(missingLabels(gates)).toEqual([]);
  });
});
