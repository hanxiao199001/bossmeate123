/**
 * 占位 mp4 URL — DVH_REAL_MODE=false 或 real 失败 fallback 时使用。
 * 5-20 排练日 user 替换真兜底 mp4（替换 3 个 URL，移除「占位」标记）。
 */
import type { TemplateId } from "./template-mapping.js";

export interface DvhMockResult {
  videoUrl: string;
  durationMs: number;
  taskUuid: string;
}

// PLACEHOLDER — 5-20 排练日替换
const FIXTURES: DvhMockResult[] = [
  { videoUrl: "https://example.com/mock-dvh-1.mp4", durationMs: 28000, taskUuid: "mock-fixture-1" },
  { videoUrl: "https://example.com/mock-dvh-2.mp4", durationMs: 32000, taskUuid: "mock-fixture-2" },
  { videoUrl: "https://example.com/mock-dvh-3.mp4", durationMs: 25000, taskUuid: "mock-fixture-3" },
];

export function getMockDvhFixture(templateId: TemplateId): DvhMockResult {
  const idx = templateId.charCodeAt(0) % FIXTURES.length;
  return FIXTURES[idx]!;
}
