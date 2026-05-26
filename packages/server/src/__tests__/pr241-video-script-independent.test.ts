/**
 * 5-23 PR #241 v2 — 视频脚本独立化, 长度扩到 90 秒版本.
 * 老韩反馈: 18 秒视频承载不了期刊内容, 目标 1 分半 (~90 秒, 250-350 字, 5 段式).
 * 改: prompt 长度规格 + slice 上限 600 + bridge 阈值 100.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const TEMPLATE = "../services/skills/journal-template.ts";
const SKILL = "../services/skills/article-skill.ts";
const BRIDGE = "../services/digital-human/article-bridge.ts";

describe("PR #241 v2: AIGeneratedContent 加 videoScript", () => {
  it("interface 含 videoScript + 250-350 字注释", async () => {
    const src = await readSrc(TEMPLATE);
    expect(src).toMatch(/videoScript\?: string;\s+\/\/ PR #241 v2: 250-350 字纯文本/);
  });
});

describe("PR #241 v2: article-skill prompt 90 秒五段式", () => {
  it("prompt 含 90 秒目标 + 250-350 字规格", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/\*\*250-350 字\*\* 纯文本/);
    expect(src).toMatch(/目标视频时长 1 分半 \/ 90 秒/);
  });
  it("五段式结构 (开场+定位+数据+人群+CTA)", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/开场钩子\*\* \(15-25 字 \/ 5 秒\)/);
    expect(src).toMatch(/期刊定位\*\* \(40-60 字/);
    expect(src).toMatch(/投稿数据\*\* \(80-110 字/);
    expect(src).toMatch(/适合人群\*\* \(60-90 字/);
    expect(src).toMatch(/行动号召\*\* \(25-40 字/);
  });
  it("数据约束: 分区/收录/APC 引用历史 PR 规则", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/PR #232/);
    expect(src).toMatch(/PR #230\/#233/);
    expect(src).toMatch(/PR #228/);
    expect(src).toMatch(/PR #229/);
  });
  it("风格指引: B 站知识区博主拆解口吻", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/B 站知识区博主/);
    expect(src).toMatch(/口语化 \+ 短句 \+ 节奏感/);
  });
  it("JSON schema 含 90 秒 + 五段式标注", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/250-350 字\*\*\(目标 90 秒视频\)/);
    expect(src).toMatch(/五段式/);
  });
  it("parse slice 上限 600 (允许 buffer 至 ~400 字)", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/parsed\.videoScript\.trim\(\)\.slice\(0, 600\)/);
  });
  it("metadata 透传 videoScript", async () => {
    const src = await readSrc(SKILL);
    expect(src).toMatch(/videoScript: aiContent\.videoScript/);
  });
});

describe("PR #241 v2: article-bridge 优先 + 长度阈值 100", () => {
  it("extractNarration 改签接 article + 内部判 metadata.videoScript", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/function extractNarration\(article: \{ title: string \| null; body: string \| null; metadata: unknown \}\)/);
    expect(src).toMatch(/meta\?\.videoScript/);
  });
  it("阈值 >= 100 字 (过滤太短的兜底数据), slice 上限 600", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/vs\.trim\(\)\.length >= 100/);
    expect(src).toMatch(/vs\.trim\(\)\.slice\(0, 600\)/);
  });
  it("缺 videoScript 时 fallback 老逻辑", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/Fallback: 老逻辑 title \+ body 前 80 字/);
  });
  it("调用点改成 extractNarration(article)", async () => {
    const src = await readSrc(BRIDGE);
    expect(src).toMatch(/const narration = extractNarration\(article\);/);
  });
});
