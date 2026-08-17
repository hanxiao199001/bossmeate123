/**
 * 欠费三层失明（8-17 事故）。
 *
 * 百炼欠费自 7-23 起断续发作 6 次（8-16 单日 154 次 400 Arrearage），
 * 整条内容线停摆，而 `ops_incidents` 零条、简报一个字没提、
 * `llm:check` 还在回「✅ 配置成对，可以起服务」。
 *
 * 三层各自独立就足以致命，所以三层各有一组用例。
 */
import { describe, it, expect } from "vitest";
import { classifyFailure, isQuotaLikeError } from "../services/ops/failure-kind.js";
import { AiUnavailableError } from "../services/ai/chat-service.js";

/** 生产原文（8-17 实测抓到的真实返回） */
const ARREARAGE_BODY =
  'API 400: {"error":{"message":"Access denied, please make sure your account is in good standing. ' +
  'For details, see: https://help.aliyun.com/zh/model-studio/error-code#overdue-payment",' +
  '"type":"Arrearage","param":null,"code":"Arrearage"}}';

describe("① 欠费要能被认出来", () => {
  it("原始 400 Arrearage → quota_exceeded（充值后可原样重跑）", () => {
    expect(classifyFailure(new Error(ARREARAGE_BODY))).toBe("quota_exceeded");
    expect(isQuotaLikeError(0, ARREARAGE_BODY)).toBe(true);
  });
});

describe("② 包装不许把欠费信号吃掉", () => {
  /**
   * 🔴 这是本次事故的核心机制。
   *
   * failure-kind 的文件头早写着：「欠费时下游表现常常是'超时'或'主备全挂'，
   * 若先判 service_down，探测会一直探到服务'不通'却永远说不出'是因为没钱'」。
   * 8-14 加的 AiUnavailableError 包装不带原文，正好制造了它预言的那个情形 ——
   * 实测被包过之后 classifyFailure 返回 service_down。
   */
  it("带上底层原文 → 仍判 quota_exceeded（说得出「是因为没钱」）", () => {
    const wrapped = new AiUnavailableError("exhausted", "deepseek", "deepseek-v4-pro", new Error(ARREARAGE_BODY));
    expect(classifyFailure(wrapped)).toBe("quota_exceeded");
  });

  it("不带原文时退化成 service_down —— 这正是要避免的形态，锁住它以免有人把参数去掉", () => {
    const bare = new AiUnavailableError("exhausted", "deepseek", "deepseek-v4-pro");
    expect(classifyFailure(bare)).toBe("service_down");
  });

  it("底层原文进 message，排查时一眼看得到", () => {
    const wrapped = new AiUnavailableError("exhausted", "deepseek", "m", new Error(ARREARAGE_BODY));
    expect(wrapped.message).toContain("Arrearage");
    expect(wrapped.lastError).toContain("Arrearage");
  });

  it("非欠费的底层错误不受影响，仍判 service_down", () => {
    const wrapped = new AiUnavailableError("exhausted", "deepseek", "m", new Error("socket hang up"));
    expect(classifyFailure(wrapped)).toBe("service_down");
  });
});

describe("③ 探活口径：不计费探活答不了「能不能干活」", () => {
  /**
   * 欠费期间 GET /models 照样 200 —— 这不是 bug，是两个问题：
   * 「地址和 key 对不对」与「账户还有没有钱」。前者答不了后者。
   * 用例锁的是这条口径本身：判据文本里必须能识别欠费特征。
   */
  it("欠费响应体能被识别（llm:check 的账户探针据此判定）", () => {
    const detect = (body: string) => /arrearage|overdue|欠费|in good standing/i.test(body);
    expect(detect(ARREARAGE_BODY)).toBe(true);
    expect(detect('{"error":{"message":"rate limit exceeded"}}')).toBe(false);
  });
});
