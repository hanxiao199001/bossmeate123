/**
 * 数字人形象批量粘贴解析纯函数单测(红线: 新增功能必带测试防回归)。
 * 覆盖: |分隔 / 全角｜ / Tab / 多空格 / 缺 voiceCode 用默认 / 非 CH_2d_ 标错 / 去重(现有+批内) / 缺必填。
 */
import { describe, it, expect } from "vitest";
import { parseDvhCatalogPaste, makeDvhKey, DEFAULT_DVH_VOICE } from "./dvhCatalogParse";

describe("parseDvhCatalogPaste — 分隔符容错", () => {
  it("竖线 | 分隔: 名字|code|voice|preview 全字段", () => {
    const { entries, errors } = parseDvhCatalogPaste(
      "博远-西装男 | CH_2d_37AsLhUrBxacjHP0 | aiyuan | https://x.jpg",
    );
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      avatarLabel: "博远-西装男",
      avatarCode: "CH_2d_37AsLhUrBxacjHP0",
      voiceCode: "aiyuan",
      preview: "https://x.jpg",
      isDup: false,
      codeWarning: false,
    });
  });

  it("Tab 分隔(从表格粘贴)与全角 ｜ 都识别", () => {
    const { entries } = parseDvhCatalogPaste(
      "小美\tCH_2d_aaaaBBBBccccDDDD\tmaoxiaomei\n晓晓 ｜ CH_2d_eeeeFFFFgggghhhh",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].voiceCode).toBe("maoxiaomei");
    expect(entries[1].avatarLabel).toBe("晓晓");
  });

  it("多个空格分隔(无竖线/Tab)", () => {
    const { entries } = parseDvhCatalogPaste("博远    CH_2d_37AsLhUrBxacjHP0    aixia");
    expect(entries).toHaveLength(1);
    expect(entries[0].avatarCode).toBe("CH_2d_37AsLhUrBxacjHP0");
    expect(entries[0].voiceCode).toBe("aixia");
  });
});

describe("parseDvhCatalogPaste — voiceCode 默认", () => {
  it("省略 voiceCode(空段) → 用系统默认音色", () => {
    const { entries } = parseDvhCatalogPaste("博远-西装男 | CH_2d_37AsLhUrBxacjHP0 |  | https://x.jpg");
    expect(entries[0].voiceCode).toBe(DEFAULT_DVH_VOICE.code);
    expect(entries[0].voiceLabel).toBe(DEFAULT_DVH_VOICE.label);
  });

  it("完全不写 voiceCode 列 → 默认音色", () => {
    const { entries } = parseDvhCatalogPaste("博远 | CH_2d_37AsLhUrBxacjHP0");
    expect(entries[0].voiceCode).toBe(DEFAULT_DVH_VOICE.code);
    expect(entries[0].preview).toBeUndefined();
  });

  it("可覆盖默认音色", () => {
    const { entries } = parseDvhCatalogPaste("博远 | CH_2d_37AsLhUrBxacjHP0", {
      defaultVoiceCode: "custom_v",
      defaultVoiceLabel: "自定义",
    });
    expect(entries[0].voiceCode).toBe("custom_v");
    expect(entries[0].voiceLabel).toBe("自定义");
  });
});

describe("parseDvhCatalogPaste — 校验与去重", () => {
  it("非 CH_2d_ 开头 → codeWarning=true 但仍入列(不阻断)", () => {
    const { entries } = parseDvhCatalogPaste("怪 | XX_bad_code | aixia\n好 | CH_2d_okokokokokokokok");
    expect(entries).toHaveLength(2);
    expect(entries[0].codeWarning).toBe(true);
    expect(entries[1].codeWarning).toBe(false);
  });

  it("缺名字或缺 code → 记 error 跳过, 其它行不受影响", () => {
    const { entries, errors } = parseDvhCatalogPaste(
      "正常 | CH_2d_okokokokokokokok\n| CH_2d_onlycodeXXXXXXXX\n只有名字",
    );
    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });

  it("同 code 已在现有目录 → isDup=true(导入跳过)", () => {
    const { entries } = parseDvhCatalogPaste("重复 | CH_2d_existExistExist", {
      existingCodes: ["CH_2d_existExistExist"],
    });
    expect(entries[0].isDup).toBe(true);
  });

  it("批内同 code 重复 → 首条 false, 后续 true", () => {
    const { entries } = parseDvhCatalogPaste(
      "A | CH_2d_sameSameSameSame\nB | CH_2d_sameSameSameSame",
    );
    expect(entries[0].isDup).toBe(false);
    expect(entries[1].isDup).toBe(true);
  });

  it("空文本 → 空结果", () => {
    expect(parseDvhCatalogPaste("")).toEqual({ entries: [], errors: [] });
    expect(parseDvhCatalogPaste("\n\n  \n")).toEqual({ entries: [], errors: [] });
  });
});

describe("makeDvhKey", () => {
  it("名字去空格 + code 末 4 位, 保证唯一", () => {
    expect(makeDvhKey("博远 西装", "CH_2d_37AsLhUrBxacjHP0")).toBe("博远_西装_jHP0");
  });
});
