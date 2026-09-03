/**
 * 欠费失明第四层（8-26）——「认出来了、也记了，但把人指向了错的账户」。
 *
 * 8-25 阿里云百炼账户欠费，同时打死 LLM / TTS / DVH 三条线。告警确实响了，
 * 但文案取的是**路由名** `provider`：
 *
 *     实况：阿里云百炼欠费
 *     告警：「deepseek 返回额度不足/欠费」
 *     detail：{"provider": "deepseek"}
 *
 * 于是排查的人跑去查 DeepSeek 官方账户余额 —— 而 `DEEPSEEK_VIA=bailian` 从 7-26 起就打开了，
 * 那个账户根本没在用。错误正文里明明带着 help.aliyun.com 的链接，没人读到那一层。
 *
 * `BillingAccount` 这个类型 7-26 就建好了，只是没接到告警上。
 * **建了模型不等于用了模型**：欠费告警的主语必须是「扣谁的钱」，不是「走哪条路由」。
 *
 * 前三层在 llm-arrearage-blindness.test.ts。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const BASE_ENV = {
  JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error", NODE_ENV: "test",
  PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
  DATABASE_URL: "postgres://t/t",
  DEEPSEEK_API_KEY: "dk", QWEN_API_KEY: "qk",
};

/** 按指定的 DEEPSEEK_VIA 重新加载 llm-endpoints（它读 env，必须重置模块） */
async function loadWithVia(deepseekVia: "official" | "bailian") {
  vi.resetModules();
  vi.doMock("../config/env.js", () => ({ env: { ...BASE_ENV, DEEPSEEK_VIA: deepseekVia } }));
  return await import("../services/ai/llm-endpoints.js");
}

beforeEach(() => { vi.resetModules(); });

describe("④ 欠费告警必须指向扣费账户，而不是路由名", () => {
  it("DEEPSEEK_VIA=bailian：走 deepseek 路由，但要喊「阿里云百炼」——8-25 踩的就是这条", async () => {
    const { describeQuotaAction } = await loadWithVia("bailian");
    const r = describeQuotaAction("deepseek");
    expect(r.account).toBe("bailian");
    expect(r.label).toBe("阿里云百炼");
    expect(r.action).toContain("阿里云百炼");
    // 🔴 核心：这句"去哪充值"里不许出现路由名，否则又把人指错地方
    expect(r.action).not.toContain("DeepSeek");
  });

  it("DEEPSEEK_VIA=official：同一条 deepseek 路由，改喊「DeepSeek 官方」", async () => {
    const { describeQuotaAction } = await loadWithVia("official");
    const r = describeQuotaAction("deepseek");
    expect(r.account).toBe("deepseek");
    expect(r.label).toBe("DeepSeek 官方");
    expect(r.action).not.toContain("阿里云");
  });

  it("同一个 provider 名在两种配置下给出不同账户 —— 锁住「不许硬编码」这件事本身", async () => {
    const bailian = (await loadWithVia("bailian")).describeQuotaAction("deepseek");
    const official = (await loadWithVia("official")).describeQuotaAction("deepseek");
    expect(bailian.label).not.toBe(official.label);
  });

  it("qwen 恒定扣阿里云，与 DEEPSEEK_VIA 无关", async () => {
    for (const via of ["official", "bailian"] as const) {
      const r = (await loadWithVia(via)).describeQuotaAction("qwen");
      expect(r.account).toBe("bailian");
      expect(r.label).toBe("阿里云百炼");
    }
  });

  it("账户名有人话标签 —— 别把 'bailian' 这种内部标识符直接甩给人看（红线：内部标识符不许裸奔）", async () => {
    const { billingAccountLabel } = await loadWithVia("bailian");
    expect(billingAccountLabel("bailian")).toBe("阿里云百炼");
    expect(billingAccountLabel("deepseek")).toBe("DeepSeek 官方");
  });
});
