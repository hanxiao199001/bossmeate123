/** PR #58.2: VideoSkill V7 emit chartType — LLM happy + ordinal normalization fallback。 */
import { describe, it, expect, vi } from "vitest";
vi.mock("../config/env.js", () => ({ env: { JWT_SECRET:"x".repeat(32), CREDENTIALS_KEY:"k", LOG_LEVEL:"error", NODE_ENV:"test", PORT:3000, API_PREFIX:"/api", ALLOWED_ORIGINS:"http://localhost:3000", DATABASE_URL:"postgres://test/test" } }));
vi.mock("../config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../models/db.js", () => ({ db: {} }));
const { VideoSkill } = await import("../services/skills/video-skill.js");
const j = { id:"j", name:"L", ifHistory:{ data:[{ year:2024, if:88.5 }], lastUpdatedAt:"x" } };
const provider = (scenes: unknown[]): any => ({ name:"fake", chat: vi.fn(async () => ({ content: JSON.stringify({ scenes }) })) });
describe("VideoSkill V7 chartType emission (#58.2)", () => {
  it("LLM 带 chartType → scene.chartType 命中；非 data 场景不带 chartType", async () => {
    const skill = new VideoSkill(provider([
      { sceneNumber:1, duration:7, sceneType:"opening", voiceoverText:"x" },
      { sceneNumber:2, duration:8, sceneType:"data", chartType:"top10", voiceoverText:"x" },
    ])) as any;
    const out = await skill.tryGenerateV7Scenes(j);
    expect(out[0].chartType).toBeUndefined();
    expect(out[1].chartType).toBe("top10");
  });
  it("LLM 漏 chartType（含非法值）→ ordinal normalization 按 data 场景序号兜底 if/car/volume/top10", async () => {
    const skill = new VideoSkill(provider([
      { sceneNumber:1, duration:8, sceneType:"data", chartType:"BOGUS", voiceoverText:"x" },
      { sceneNumber:2, duration:8, sceneType:"data", voiceoverText:"x" },
      { sceneNumber:3, duration:8, sceneType:"data", voiceoverText:"x" },
      { sceneNumber:4, duration:8, sceneType:"data", voiceoverText:"x" },
      { sceneNumber:5, duration:8, sceneType:"data", voiceoverText:"x" },
    ])) as any;
    const out = await skill.tryGenerateV7Scenes(j);
    const ct = out.filter((s: any) => s.sceneType === "data").map((s: any) => s.chartType);
    expect(ct).toEqual(["if", "car", "volume", "top10", "top10"]);
  });
});
