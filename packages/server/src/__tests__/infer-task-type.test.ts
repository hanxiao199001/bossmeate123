import { describe, it, expect, vi } from "vitest";

// 屏蔽 env 和 logger 初始化副作用
vi.mock("../config/env.js", () => ({
  env: {
    DEEPSEEK_API_KEY: "test-deepseek",
    QWEN_API_KEY: "test-qwen",
    DEFAULT_EXPENSIVE_MODEL: "deepseek-chat",
    DEFAULT_CHEAP_MODEL: "deepseek-chat",
    MODEL_CIRCUIT_BREAKER_THRESHOLD: 5,
    LOG_LEVEL: "error",
    NODE_ENV: "test",
  },
}));

vi.mock("../config/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

const { inferTaskType } = await import("../services/ai/chat-service.js");

describe("inferTaskType", () => {
  describe("显式 skillType 映射", () => {
    it.each([
      ["article", "content_generation"],
      ["video", "content_generation"],
      ["content_generation", "content_generation"],
      ["knowledge_extract", "knowledge_search"],
      ["knowledge_search", "knowledge_search"],
      ["style_analysis", "quality_check"],
      ["quality_check", "quality_check"],
      ["customer_service", "customer_service"],
      ["formatting", "formatting"],
      ["requirement_analysis", "requirement_analysis"],
      ["daily_chat", "daily_chat"],
      ["translation", "translation"],
    ])("skillType=%s → %s", (skill, expected) => {
      expect(inferTaskType(skill)).toBe(expected);
    });
  });

  describe("兜底逻辑", () => {
    it("未识别 skillType + 长文本 → content_generation", () => {
      const longMsg = "x".repeat(250);
      expect(inferTaskType("unknown_skill", longMsg)).toBe("content_generation");
    });

    it("未识别 skillType + 短文本 → daily_chat", () => {
      expect(inferTaskType("unknown_skill", "短消息")).toBe("daily_chat");
    });

    it("general（前端默认值）+ 短文本 → daily_chat", () => {
      expect(inferTaskType("general", "你好")).toBe("daily_chat");
    });

    it("general + 长文本 → content_generation（尊重消息长度兜底）", () => {
      const longMsg = "x".repeat(201);
      expect(inferTaskType("general", longMsg)).toBe("content_generation");
    });

    it("skillType=undefined + 长文本 → content_generation", () => {
      const longMsg = "x".repeat(300);
      expect(inferTaskType(undefined, longMsg)).toBe("content_generation");
    });

    it("skillType=undefined + 短文本 → daily_chat", () => {
      expect(inferTaskType(undefined, "hi")).toBe("daily_chat");
    });

    it("skillType=undefined + 无消息 → daily_chat", () => {
      expect(inferTaskType()).toBe("daily_chat");
    });

    it("空字符串 skillType → 走兜底", () => {
      expect(inferTaskType("", "hi")).toBe("daily_chat");
    });
  });

  describe("边界", () => {
    it("消息恰好 200 字 → 短文本兜底", () => {
      expect(inferTaskType(undefined, "x".repeat(200))).toBe("daily_chat");
    });
    it("消息 201 字 → 长文本兜底", () => {
      expect(inferTaskType(undefined, "x".repeat(201))).toBe("content_generation");
    });
  });
});
