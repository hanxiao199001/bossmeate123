/**
 * 占位 mp4 URL — DVH_REAL_MODE=false 或 real 失败 fallback 时使用。
 * 7-13 收尾: 原 example.com 死链会让用户拿到打不开的视频。改为 env 可配 (DVH_MOCK_FIXTURE_BASE),
 *   默认指向 OSS 上真实存在的占位样片桶; 生产必须开 DVH_REAL_MODE=true, 兜底只在真合成失败时兜。
 */
import type { TemplateId } from "./template-mapping.js";
import { env } from "../../config/env.js";

export interface DvhMockResult {
  videoUrl: string;
  durationMs: number;
  taskUuid: string;
}

// 7-13: 兜底样片 base 走 env; 未配则用 OSS 占位桶 (真实可播放的通用样片, 非死链)。
const FIXTURE_BASE = env.DVH_MOCK_FIXTURE_BASE || "https://bossmate-media.oss-cn-beijing.aliyuncs.com/dvh-fixtures";
const FIXTURES: DvhMockResult[] = [
  { videoUrl: `${FIXTURE_BASE}/placeholder-1.mp4`, durationMs: 28000, taskUuid: "mock-fixture-1" },
  { videoUrl: `${FIXTURE_BASE}/placeholder-2.mp4`, durationMs: 32000, taskUuid: "mock-fixture-2" },
  { videoUrl: `${FIXTURE_BASE}/placeholder-3.mp4`, durationMs: 25000, taskUuid: "mock-fixture-3" },
];

export function getMockDvhFixture(templateId: TemplateId): DvhMockResult {
  const idx = templateId.charCodeAt(0) % FIXTURES.length;
  return FIXTURES[idx]!;
}
