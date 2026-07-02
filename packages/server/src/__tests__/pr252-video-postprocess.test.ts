/**
 * 5-24 PR #252 — DVH 视频 ffmpeg 后处理.
 * 关 subtitleEmbedded → 拿 taskResult.subtitlesUrl SRT → ffmpeg burn-in 自定义样式 → BossMate OSS.
 * 失败 fallback 原 videoUrl, 不阻塞链路.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const SUBMIT = "../services/digital-human/submit-task.ts";
const QUERY = "../services/digital-human/query-task.ts";
const POSTPROCESS = "../services/digital-human/video-postprocess.ts";
const BRIDGE = "../services/digital-human/article-bridge.ts";

describe("PR #252: 关闭 DVH 内嵌字幕", () => {
  it("submit-task subtitleEmbedded=false", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).toMatch(/subtitleEmbedded: false/);
    expect(src).not.toMatch(/subtitleEmbedded: true/);
  });
  it("submit-task 移除 subtitleStyle (DVH 不渲染)", async () => {
    const src = await readSrc(SUBMIT);
    expect(src).not.toMatch(/SubtitleStyle\(\{[\s\S]*size:/);
  });
});

describe("PR #252: query-task 透传 subtitlesUrl", () => {
  it("DvhQueryResult 加 subtitlesUrl?: string", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/subtitlesUrl\?: string/);
  });
  it("query.ok 返回带 subtitlesUrl", async () => {
    const src = await readSrc(QUERY);
    expect(src).toMatch(/subtitlesUrl: r\.subtitlesUrl/);
  });
});

describe("PR #252: video-postprocess 模块", () => {
  it("默认 ASS style: 白字黑边", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/primaryColour: env\.DVH_SUBTITLE_PRIMARY_COLOUR/);
    expect(src).toMatch(/outlineColour: env\.DVH_SUBTITLE_OUTLINE_COLOUR/);
  });
  it("默认 ASS style 全读 env (PR-E 配置化)", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/fontName: env\.DVH_SUBTITLE_FONT_NAME/);
    expect(src).toMatch(/fontSize: env\.DVH_SUBTITLE_FONT_SIZE/);
    expect(src).toMatch(/alignment: env\.DVH_SUBTITLE_ALIGNMENT/);
  });
  it("ffmpeg subtitles 滤镜 + libx264 编码", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/subtitles=\$\{srtPath\}:force_style/);
    expect(src).toMatch(/"-c:v", "libx264"/);
    expect(src).toMatch(/"-c:a", "copy"/);
  });
  it("失败 fallback 原 videoUrl 不阻塞链路", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/dvh\.postprocess\.failed_fallback_original/);
    expect(src).toMatch(/return \{ videoUrl, postprocessed: false \}/);
  });
  it("缺 SRT 也兜底 (subtitlesUrl 为空)", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/dvh\.postprocess\.no_srt_skip/);
  });
  it("处理后上传到 BossMate OSS (复用 storage 模块)", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/import \{ storage \} from "\.\.\/storage\/index\.js"/);
    expect(src).toMatch(/storage\.upload\(buffer, ossKey, "video\/mp4"\)/);
    expect(src).toMatch(/dvh-videos\/\$\{taskUuid\}\.mp4/);
  });
  it("tmpdir 工作目录用完清理", async () => {
    const src = await readSrc(POSTPROCESS);
    expect(src).toMatch(/await rm\(workDir, \{ recursive: true, force: true \}\)/);
  });
});

describe("PR #252: article-bridge 集成", () => {
  it("import postprocessVideoWithSubtitle", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/import \{ postprocessVideoWithSubtitle \} from ".\/video-postprocess\.js"/);
  });
  it("produceVideo 在 query 后调 postprocess", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/const pp = await postprocessVideoWithSubtitle\(\{/);
    // 7-02: 音频驱动重构后 subtitlesUrl 改为变量(音频驱动自生成SRT / 文字驱动用 query)。断言文字驱动路径仍取 query.subtitlesUrl。
    expect(src).toMatch(/subtitlesUrl = query\.subtitlesUrl \?\? ""/);
  });
  it("returned videoUrl 用 pp.videoUrl (后处理版本)", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/videoUrl: pp\.videoUrl/);
  });
});
