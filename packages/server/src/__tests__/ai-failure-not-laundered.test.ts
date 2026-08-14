/**
 * AI 调用失败不许被洗成成品（8-14，红线 #14 第七次）。
 *
 * 实证：8-13 百炼 403（Workspace.AccessDenied），主备模型全挂 →
 * chat-service 把一句道歉文案当 content 返回 → article-skill 抽不出 JSON →
 * 产出「期刊推荐：图书与情报，影响因子 N/A」落库 needs_review。
 * 一次外部故障变成了一篇看着像成品的废稿。
 */
import { describe, it, expect } from "vitest";
import { isAiFallbackText, AI_FALLBACK_UNAVAILABLE } from "../services/ai/fallback-messages.js";
import { classifyFailure } from "../services/ops/failure-kind.js";
import { AiUnavailableError, isAiUnavailableError } from "../services/ai/chat-service.js";

describe("① 失败的形态必须可判别", () => {
  it("chat-service 的道歉文案整句可识别 —— 它不是内容", () => {
    expect(isAiFallbackText(AI_FALLBACK_UNAVAILABLE)).toBe(true);
    expect(isAiFallbackText("抱歉，AI暂时无法响应，请稍后重试。")).toBe(true);
  });

  it("正常内容里出现「抱歉」不算失败 —— 判据是整句不是两个字", () => {
    expect(isAiFallbackText("很抱歉地通知各位，该刊已被剔除预警名单，投稿需谨慎评估。")).toBe(false);
  });
});

describe("② 失败要落到能自动重跑的那一类", () => {
  /**
   * 这条链路是整个自动重跑体系的地基：
   * AiUnavailableError → service_down → deferred → 服务恢复后原样重跑。
   * 判成 content_error 就等于把一篇好稿子判死。
   */
  it("AI 主备全挂 → service_down（服务恢复可重跑），不是内容自己的问题", () => {
    expect(classifyFailure(new AiUnavailableError("exhausted", "deepseek", "deepseek-v4-pro"))).toBe("service_down");
  });

  it("跨模块实例也认得出来（按 name，不靠 instanceof）", () => {
    const fake = Object.assign(new Error("AI 不可用: 主备模型全部调用失败"), { name: "AiUnavailableError" });
    expect(isAiUnavailableError(fake)).toBe(true);
    expect(classifyFailure(fake)).toBe("service_down");
  });
});

describe("③ 兜底标题的形态本身要被出稿健康闸认出来", () => {
  it("「期刊推荐：X，影响因子 N/A」命中 title_placeholder", async () => {
    const { checkOutputHealth } = await import("../services/publisher/output-health.js");
    const r = checkOutputHealth({ title: "期刊推荐：图书与情报，影响因子 N/A", body: "x".repeat(2000) });
    expect(r.issues.some((i) => i.code === "title_placeholder")).toBe(true);
  });
});

describe("④ 三种「等于没返回」的形态，一种都不能漏", () => {
  /**
   * 日志实证（近 45 天 11 条 JSON 抽取失败）：
   *   7 条 outputTokens=0 / rawLength=18 → 调用失败, 拿到的是道歉文案
   *   3 条 outputTokens=6001 / rawLength=0 → 撞满 maxTokens, 推理型模型把预算
   *        全烧在思维链上, 可见输出为空。**它不带任何错误信号** ——
   *        finishReason 正常、没有异常、没有兜底文案。只认 error 的守卫整类漏掉。
   *   1 条 outputTokens=2506 / rawLength=2109 → 真的抽不出 JSON（正文是真的）
   *
   * 前两类必须转 deferred；第三类不在本守卫范围（它确实拿到了内容）。
   */
  const shapes = [
    { name: "调用失败(道歉文案)", content: "抱歉，AI暂时无法响应，请稍后重试。", finishReason: "error", outputTokens: 0, mustFail: true },
    { name: "道歉文案但 finishReason 正常(修复前的硬编码值)", content: "抱歉，AI暂时无法响应，请稍后重试。", finishReason: "stop", outputTokens: 0, mustFail: true },
    { name: "正文为空但烧满 token", content: "", finishReason: "stop", outputTokens: 6001, mustFail: true },
    { name: "只有空白字符", content: "  \n  ", finishReason: "stop", outputTokens: 6001, mustFail: true },
    { name: "真内容抽不出 JSON —— 不归本守卫管", content: '{ "title": "投北大核心还是CSSCI？', finishReason: "stop", outputTokens: 2506, mustFail: false },
  ];

  for (const s of shapes) {
    it(`${s.name} → ${s.mustFail ? "必须拦下" : "放行"}`, () => {
      const failed =
        s.finishReason === "error" || isAiFallbackText(s.content) || s.content.trim().length === 0;
      expect(failed).toBe(s.mustFail);
    });
  }
});
