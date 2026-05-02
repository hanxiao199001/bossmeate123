/** PR #58.1：produceVideo chart-frame wiring 集成测试。 */
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../models/db.js", () => ({ db: {} }));
const renderChart = vi.fn();
const upload = vi.fn(async (_b: Buffer, p: string) => `https://cdn/${p}`);
const compose = vi.fn(async () => ({ url:"v", remotePath:"v", localPath:"v", durationMs:0, sizeBytes:0 }));
vi.mock("../services/video/chart-renderer.js", () => ({ renderChartFrame: renderChart }));
vi.mock("../services/storage/index.js", () => ({ storage: { upload } }));
vi.mock("../services/video/asset-manager.js", () => ({ assetManager: { fetchJournalCover: vi.fn(async () => ({ url:"https://cdn/cover.jpg" })), fetchJournalScreenshot: vi.fn(), fetchAssets: vi.fn(async () => []), generateColorPlaceholder: vi.fn() } }));
vi.mock("../services/video/tts-service.js", () => ({ ttsService: { synthesize: vi.fn(async () => ({ url:"https://cdn/v.mp3", durationMs:5000 })) } }));
vi.mock("../services/video/composer.js", () => ({ videoComposer: { compose } }));
vi.mock("../services/video/html-renderer.js", () => ({ generateCard: vi.fn(async () => Buffer.from("v2")) }));
const { produceVideo } = await import("../services/video/index.js");
const j = { id:"j-1", name:"L", ifHistory: { data: [{ year:2024, if:88.5 }] } };
const src = () => ((compose.mock.calls[0] as unknown as [{ scenes: { imageSource: string }[] }])[0]).scenes[0].imageSource;
const input = () => ({ tenantId:"t-1", title:"T", journal: j as any, scenes: [{ voiceoverText:"x", visualKeywords:[], sceneType:"data" as any, chartType:"if" as any }] });
beforeEach(() => { renderChart.mockReset(); upload.mockClear(); compose.mockClear(); });
describe("produceVideo chart wiring (#58.1)", () => {
  it("data + chartType + 数据齐 → ComposerScene.imageSource = chart PNG URL", async () => {
    renderChart.mockResolvedValue(Buffer.from("png"));
    await produceVideo(input());
    expect(renderChart).toHaveBeenCalledTimes(1);
    expect(src()).toMatch(/\/assets\/t-1\/charts\/j-1-if-/);
  });
  it("renderChartFrame 抛错 → imageSource 保持 V2 卡片，produceVideo 不抛", async () => {
    renderChart.mockRejectedValue(new Error("boom"));
    await expect(produceVideo(input())).resolves.toBeDefined();
    expect(src()).toMatch(/\/cards\//);
  });
});
