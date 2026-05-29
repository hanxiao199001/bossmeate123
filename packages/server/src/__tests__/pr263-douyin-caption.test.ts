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

const { generateDouyinCaption, generateDouyinCaptionVariants } = await import("../services/publisher/douyin-caption.js");

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

describe("PR #265: generateDouyinCaptionVariants (多号差异化)", () => {
  it("LLM 返回 N 套 → 解析为 N 个互不相同的文案, 写回 metadata", async () => {
    contentRow = { id: "v1", tenantId: "t1", title: "投稿攻略", body: "", metadata: {} };
    chatMock.mockResolvedValue({ content: JSON.stringify([
      { hookTitle: "标题A 录用率翻倍", hashtags: ["科研", "SCI"], lead: "关注我" },
      { hookTitle: "标题B 避坑指南", hashtags: ["论文", "读研"], lead: "收藏起来" },
      { hookTitle: "标题C 审稿内幕", hashtags: ["投稿", "学术"], lead: "评论区聊" },
    ]) });
    const vs = await generateDouyinCaptionVariants({ contentId: "v1", tenantId: "t1", count: 3 });
    expect(vs.length).toBe(3);
    expect(new Set(vs.map((v) => v.hookTitle)).size).toBe(3); // 互不相同
    expect(vs[0].fullText).toContain("#科研");
    expect(capturedSet.value.metadata.douyinCaptionVariants.length).toBe(3);
  });

  it("LLM 只给 1 套但要 3 套 → 规则变体补齐到 3, 且各不相同", async () => {
    contentRow = { id: "v2", tenantId: "t1", title: "某期刊投稿", body: "", metadata: {} };
    chatMock.mockResolvedValue({ content: JSON.stringify([{ hookTitle: "唯一一套", hashtags: ["科研"], lead: "关注" }]) });
    const vs = await generateDouyinCaptionVariants({ contentId: "v2", tenantId: "t1", count: 3 });
    expect(vs.length).toBe(3);
    expect(new Set(vs.map((v) => v.hookTitle)).size).toBe(3);
  });

  it("LLM 全失败 → 3 套规则变体, fullText 均非空且标题不同", async () => {
    contentRow = { id: "v3", tenantId: "t1", title: "投稿干货", body: "", metadata: {} };
    chatMock.mockRejectedValue(new Error("llm down"));
    const vs = await generateDouyinCaptionVariants({ contentId: "v3", tenantId: "t1", count: 3 });
    expect(vs.length).toBe(3);
    expect(vs.every((v) => v.fullText.length > 0)).toBe(true);
    expect(new Set(vs.map((v) => v.hookTitle)).size).toBe(3);
  });

  it("缓存命中 (variants 数 >= count 且非 force) → 不调 LLM 不写库", async () => {
    const cachedVs = [
      { hookTitle: "c1", hashtags: ["a"], lead: "l", fullText: "c1\nl\n#a", generatedAt: "2026" },
      { hookTitle: "c2", hashtags: ["b"], lead: "l", fullText: "c2\nl\n#b", generatedAt: "2026" },
      { hookTitle: "c3", hashtags: ["c"], lead: "l", fullText: "c3\nl\n#c", generatedAt: "2026" },
    ];
    contentRow = { id: "v4", tenantId: "t1", title: "t", body: "", metadata: { douyinCaptionVariants: cachedVs } };
    const vs = await generateDouyinCaptionVariants({ contentId: "v4", tenantId: "t1", count: 3 });
    expect(vs).toEqual(cachedVs);
    expect(chatMock).not.toHaveBeenCalled();
    expect(capturedSet.value).toBeUndefined();
  });
});
