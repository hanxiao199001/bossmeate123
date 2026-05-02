/** Track A.3：chart-renderer 单测。spec 要求 1 unit happy + 1 unit sharp 抛错 fallback。 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32), CREDENTIALS_KEY: "k", LOG_LEVEL: "error",
    NODE_ENV: "test", PORT: 3000, API_PREFIX: "/api", ALLOWED_ORIGINS: "http://localhost:3000",
    DATABASE_URL: "postgres://test/test",
  },
}));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const toBufferMock = vi.fn();
const sharpMock = vi.fn(() => ({ resize: () => ({ png: () => ({ toBuffer: toBufferMock }) }) }));
vi.mock("sharp", () => ({ default: sharpMock }));

const { renderChartFrame } = await import("../services/video/chart-renderer.js");

beforeEach(() => { sharpMock.mockClear(); toBufferMock.mockReset(); });

describe("renderChartFrame", () => {
  it("happy: SVG → sharp → PNG buffer (length > 0) + sharp 调用 1 次", async () => {
    toBufferMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]));
    const buf = await renderChartFrame({
      type: "if",
      data: { data: [{ year: 2022, if: 80 }, { year: 2023, if: 85 }, { year: 2024, if: 88.5 }] },
    });
    expect(sharpMock).toHaveBeenCalledTimes(1);
    expect(buf).not.toBeNull();
    expect(buf!.length).toBeGreaterThan(0);
    const inputSvg = (sharpMock.mock.calls[0] as unknown as [Buffer])[0].toString("utf8");
    expect(inputSvg).toContain("<svg");
    expect(inputSvg).toContain("近 10 年 IF 历史");
  });

  it("sharp 抛错 → 返 null + console.error（compose caller 走 fallback，不 throw）", async () => {
    toBufferMock.mockRejectedValue(new Error("[mock] sharp engine crash"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const buf = await renderChartFrame({
      type: "car",
      data: { data: [{ year: 2023, carIndex: 0.04 }, { year: 2024, carIndex: 0.069 }] },
    });
    expect(buf).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0][0]).toMatch(/chart render failed \(car\)/);
    errSpy.mockRestore();
  });
});
