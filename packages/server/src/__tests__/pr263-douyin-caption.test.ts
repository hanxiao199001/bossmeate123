/**
 * 5-29 PR #263 — 抖音文案包生成.
 * 覆盖: LLM 成功解析 / LLM 失败规则兜底 / metadata 缓存命中.
 * mock provider-factory + db; 不发真实 LLM.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error", NODE_ENV: "test" },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let contentRow: any = null;
let selectCall = 0;
const capturedSet: { value?: any } = {};
vi.mock("../models/db.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => { selectCall++; return selectCall === 1 ? (contentRow ? [contentRow] : []) : []; }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: any) => { capturedSet.value = v; return { where: vi.fn(async () => undefined) }; }),
    })),
  },
}));

const chatMock = vi.fn();
vi.mock("../services/ai/provider-factory.js", () => ({
  getProviders: () => ({ cheap: [{ chat: chatMock }], expensive: [{ chat: chatMock }] }),
}));

const { generateDouyinCaption } = await import("../services/publisher/douyin-caption.js");

beforeEach(() => {
  selectCall = 0;
  capturedSet.value = undefined;
  contentRow = null;
  chatMock.mockReset();
});

describe("PR #263: generateDouyinCaption", () => {
  it("LLM 成功 → 解析钩子标题+话题, fullText 含 #话题, 写回 metadata", async () => {
    contentRow = { id: "c1", tenantId: "t1", title: "测试标题", body: "脚本正文若干", metadata: { videoScript: "数字人视频脚本内容，长度足够触发使用" } };
    chatMock.mockResolvedValue({ content: '{"hookTitle":"3个细节决定论文录用","hashtags":["科研","论文投稿","SCI"],"lead":"关注我看更多干货"}' });
    const cap = await generateDouyinCaption({ contentId: "c1", tenantId: "t1" });
    expect(cap.hookTitle).toContain("录用");
    expect(cap.hashtags).toContain("科研");
    expect(cap.hashtags.length).toBeLessThanOrEqual(6);
    expect(cap.fullText).toContain("#科研");
    expect(cap.fullText).toContain("3个细节");
    // 写回 metadata.douyinCaption
    expect(capturedSet.value.metadata.douyinCaption.fullText).toBe(cap.fullText);
  });

  it("LLM 抛错 → 规则兜底, fullText 非空 + 含学科种子话题", async () => {
    contentRow = { id: "c2", tenantId: "t1", title: "某期刊投稿指南", body: "", metadata: {} };
    chatMock.mockRejectedValue(new Error("llm down"));
    const cap = await generateDouyinCaption({ contentId: "c2", tenantId: "t1" });
    expect(cap.fullText.length).toBeGreaterThan(0);
    expect(cap.hashtags).toContain("学术");
    expect(cap.hookTitle).toContain("投稿指南");
    expect(capturedSet.value.metadata.douyinCaption).toBeTruthy();
  });

  it("缓存命中 (metadata.douyinCaption 已存在 + 非 force) → 直接返回, 不调 LLM 不写库", async () => {
    const cached = { hookTitle: "缓存标题", hashtags: ["a"], lead: "y", fullText: "缓存标题\ny\n#a", generatedAt: "2026-05-29T00:00:00.000Z" };
    contentRow = { id: "c3", tenantId: "t1", title: "t", body: "", metadata: { douyinCaption: cached } };
    const cap = await generateDouyinCaption({ contentId: "c3", tenantId: "t1" });
    expect(cap).toEqual(cached);
    expect(chatMock).not.toHaveBeenCalled();
    expect(capturedSet.value).toBeUndefined();
  });
});
