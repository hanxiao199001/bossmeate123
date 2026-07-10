/**
 * 7-10 音色库纯函数单测: 克隆/预置判型(与 tts-service 检测判据一致)、
 * 录音入库默认名、存量补录命名、voice_id 尾号展示、改名/临时音色入参校验。
 */
import { describe, it, expect } from "vitest";
import {
  inferVoiceType,
  defaultCloneName,
  backfillCloneName,
  voiceTail,
  sanitizeCatalogName,
  sanitizeVoiceOverride,
} from "../services/voice/catalog-utils.js";

describe("inferVoiceType — 判据须与 tts-service /-vc-|^cosyvoice-/i 一致", () => {
  it("百炼声音复刻 voice_id(含 -vc-) → cloned", () => {
    expect(inferVoiceType("qwen-tts-vc-hanvoice-x8f2k1")).toBe("cloned");
    expect(inferVoiceType("ABC-VC-123")).toBe("cloned"); // 大小写不敏感
  });
  it("cosyvoice- 前缀 → cloned", () => {
    expect(inferVoiceType("cosyvoice-v2-hanxiao")).toBe("cloned");
    expect(inferVoiceType("CosyVoice-x")).toBe("cloned");
  });
  it("qwen-tts 预置音色名 → preset", () => {
    for (const v of ["Cherry", "Serena", "Ethan", "Chelsie"]) {
      expect(inferVoiceType(v)).toBe("preset");
    }
  });
  it("cosyvoice 出现在中间(非前缀)且无 -vc- → preset", () => {
    expect(inferVoiceType("my-cosyvoice")).toBe("preset");
  });
});

describe("defaultCloneName — 录音入库默认名", () => {
  const d = new Date(2026, 6, 10); // 2026-07-10
  it("带账号名: '账号名的声音 M-D'", () => {
    expect(defaultCloneName("韩肖的号", d)).toBe("韩肖的号的声音 7-10");
  });
  it("无账号名/空白 → '我的声音 M-D'", () => {
    expect(defaultCloneName(undefined, d)).toBe("我的声音 7-10");
    expect(defaultCloneName("   ", d)).toBe("我的声音 7-10");
    expect(defaultCloneName(null, d)).toBe("我的声音 7-10");
  });
  it("超长账号名截断到 60(voice_catalog.name 列宽)", () => {
    expect(defaultCloneName("长".repeat(80), d).length).toBeLessThanOrEqual(60);
  });
});

describe("backfillCloneName — 存量 clonedVoiceId 补录命名(migration 024 语义对照)", () => {
  it("备注名优先于账号名", () => {
    expect(backfillCloneName("待登录·3", "老韩抖音主号")).toBe("老韩抖音主号的声音");
  });
  it("无备注用账号名; 都无 → '账号的声音'", () => {
    expect(backfillCloneName("韩说期刊", null)).toBe("韩说期刊的声音");
    expect(backfillCloneName("", "")).toBe("账号的声音");
  });
  it("截断到 60", () => {
    expect(backfillCloneName("长".repeat(80), null).length).toBeLessThanOrEqual(60);
  });
});

describe("voiceTail — 尾 6 位展示", () => {
  it("长 id 取尾 6 位加省略号", () => {
    expect(voiceTail("qwen-tts-vc-hanvoice-x8f2k1")).toBe("…x8f2k1");
  });
  it("短 id 原样返回(如预置名 Cherry)", () => {
    expect(voiceTail("Cherry")).toBe("Cherry");
    expect(voiceTail("Ethan")).toBe("Ethan");
  });
});

describe("sanitizeCatalogName — 改名校验", () => {
  it("正常名去空白通过", () => {
    expect(sanitizeCatalogName("  韩肖本人 ")).toBe("韩肖本人");
  });
  it("空/纯空白/超 60/非字符串 → null", () => {
    expect(sanitizeCatalogName("")).toBeNull();
    expect(sanitizeCatalogName("   ")).toBeNull();
    expect(sanitizeCatalogName("长".repeat(61))).toBeNull();
    expect(sanitizeCatalogName(123)).toBeNull();
    expect(sanitizeCatalogName(undefined)).toBeNull();
  });
});

describe("sanitizeVoiceOverride — 单次生成临时音色校验", () => {
  it("合法 voice_id 去空白通过", () => {
    expect(sanitizeVoiceOverride(" qwen-tts-vc-abc ")).toBe("qwen-tts-vc-abc");
    expect(sanitizeVoiceOverride("Cherry")).toBe("Cherry");
  });
  it("空/超 120/非字符串 → undefined(回落账号绑定/系统默认)", () => {
    expect(sanitizeVoiceOverride("")).toBeUndefined();
    expect(sanitizeVoiceOverride("  ")).toBeUndefined();
    expect(sanitizeVoiceOverride("x".repeat(121))).toBeUndefined();
    expect(sanitizeVoiceOverride(null)).toBeUndefined();
    expect(sanitizeVoiceOverride({})).toBeUndefined();
  });
});
