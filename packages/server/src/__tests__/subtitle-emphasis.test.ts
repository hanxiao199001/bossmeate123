/**
 * 混剪提质②: subtitle-emphasis 纯函数单测 — SRT→ASS 关键词强调。
 * 覆盖: 命中高亮 / 相邻命中合并 / 无命中原样 / SRT 边界(多行 cue、空行、缺序号、非法时间)。
 */
import { describe, it, expect } from "vitest";
import { srtToAssWithEmphasis, emphasizeLine, parseSrt, wrapCjkLine } from "../services/digital-human/subtitle-emphasis.js";
import type { SubtitleAssStyle } from "../services/digital-human/video-postprocess.js";

const STYLE: Required<SubtitleAssStyle> = {
  fontName: "Noto Sans CJK SC",
  fontSize: 15, // 7-02 重校准默认(288坐标系≈100px实际)
  primaryColour: "&H00FFFFFF&",
  outlineColour: "&H00000000&",
  outline: 2,
  shadow: 0,
  alignment: 2,
  // 7-02 重校准默认(距底29%)。⚠️ 8-12 起这个值只是**输入** ——
  //   版面层会把它改成 43(底边锚字幕带下沿 85%), 因为 84 会让文字向上长进人物区。
  marginV: 84,
  bold: 1,
};

const srt = (body: string) => body; // 语义标记, 便于阅读

describe("emphasizeLine 关键词内联强调", () => {
  const EM_TAG = `{\\1c&H00FFFF&\\b1\\fs${Math.round(36 * 1.35)}}`;

  it("数字/百分号/硬词命中 → 包上黄色加粗放大标签 + {\\r} 复位", () => {
    const out = emphasizeLine("录用率高达65%值得投", 36);
    expect(out).toContain(`${EM_TAG}录用率${"{\\r}"}`);
    expect(out).toContain(`${EM_TAG}65%${"{\\r}"}`);
  });

  it("分区命中: 中文区号与 Q1-4, '2区' 不被数字规则拆开", () => {
    expect(emphasizeLine("稳居二区", 36)).toContain(`${EM_TAG}二区{\\r}`);
    expect(emphasizeLine("JCR分区Q1", 36)).toContain(`${EM_TAG}Q1{\\r}`);
    // "2区" 应整体命中(分区规则优先于数字规则), 不能只黄 "2" 剩个白 "区"
    expect(emphasizeLine("中科院2区", 36)).toContain("中科院2区{\\r}");
    expect(emphasizeLine("中科院2区", 36)).not.toContain("2{\\r}区");
  });

  it("相邻命中合并: 'IF 3.5' 是一个标签区间, 不碎成两段", () => {
    const out = emphasizeLine("影响因子 IF 3.5 创新高", 36);
    // 整串 "影响因子 IF 3.5"(空白间隔的相邻命中)只允许出现一次开标签
    expect(out).toContain(`${EM_TAG}影响因子 IF 3.5{\\r}`);
    expect(out.split(EM_TAG).length - 1).toBe(1);
  });

  it("无命中 → 文本原样(无任何覆盖标签)", () => {
    const out = emphasizeLine("这本期刊值得关注", 36);
    expect(out).toBe("这本期刊值得关注");
    expect(out).not.toContain("{\\");
  });

  it("拉丁词界: 不误伤 LIFE/SCIENCE 里的 IF/SCI 子串", () => {
    expect(emphasizeLine("LIFE SCIENCE 领域", 36)).not.toContain("{\\1c");
  });

  it("ASS 定界符转义: 文本里的 { } \\ 换全角, 不会注入标签", () => {
    const out = emphasizeLine("花括号{测试}和反斜杠\\", 36);
    expect(out).not.toContain("{测试}");
    expect(out).toContain("｛测试｝");
    expect(out).toContain("＼");
  });
});

describe("parseSrt 边界", () => {
  it("多行 cue 合成 \\n, 多余空行/前后空白容忍", () => {
    const cues = parseSrt(srt(`1
00:00:01,000 --> 00:00:03,000
第一行
第二行


2
00:00:04,000 --> 00:00:05,500
单行
`));
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("第一行\n第二行");
    expect(cues[1]!.startMs).toBe(4000);
    expect(cues[1]!.endMs).toBe(5500);
  });

  it("缺序号的 cue 也能解析; 非法时间/空文本块跳过", () => {
    const cues = parseSrt(srt(`00:00:00,500 --> 00:00:02,000
没有序号也行

不是时间轴的孤儿块

3
00:00:09,000 --> 00:00:08,000
结束早于开始该跳过
`));
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("没有序号也行");
  });

  it("解析不出任何 cue → srtToAssWithEmphasis 返回空串(调用方降级老路径)", () => {
    expect(srtToAssWithEmphasis("完全不是SRT的内容", STYLE, 1080, 1920)).toBe("");
    expect(srtToAssWithEmphasis("", STYLE, 1080, 1920)).toBe("");
  });
});

describe("srtToAssWithEmphasis 完整 ASS 输出", () => {
  const SRT = srt(`1
00:00:01,000 --> 00:00:03,200
影响因子 3.5 稳步上升

2
00:00:03,200 --> 00:00:06,000
审稿周期约2个月
避雷预警要看
`);

  it("含 Script Info / V4+ Styles / Events 三段, 样式字段映射自现有 style", () => {
    const ass = srtToAssWithEmphasis(SRT, STYLE, 1080, 1920);
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("PlayResY: 288"); // 锚定 ffmpeg subrip 默认坐标系, 字号/边距与老路径视觉一致
    expect(ass).toContain("[V4+ Styles]");
    // Style 行: 字体/字号/颜色(尾 & 已规整)/描边/位置/边距/粗体(-1)
    // 8-12 行为变更：字号与 MarginV 取**版面解算后**的值，不再直接用 env。
    //   MarginV 84→43（84 会把文字块顶进人物区，实测重叠 95%，见 vertical-layout.test.ts）
    expect(ass).toContain("Style: Default,Noto Sans CJK SC,15,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,8,8,43,1");
    expect(ass).toContain("[Events]");
  });

  it("Dialogue 时间转换 SRT→ASS(逗号毫秒→点厘秒), 多行 cue 用 \\N", () => {
    const ass = srtToAssWithEmphasis(SRT, STYLE, 1080, 1920);
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:03.20,Default,,0,0,0,,");
    expect(ass).toContain("避雷");
    expect(ass).toContain("\\N"); // 第二条 cue 两行
  });

  it("命中行带强调标签, 无命中部分保持原文", () => {
    const ass = srtToAssWithEmphasis(SRT, STYLE, 1080, 1920);
    // 13字超 maxChars(10) → 强制换行(空格断点)后再强调, 标签跨 \N 合法
    // 8-12 行为变更：强调字号 = 15×1.2 = 18（原 15×1.35≈20）。
    //   1.35 在字号 15 / 2 行时数学上放不进 15% 的字幕带，由版面层压到 1.2。
    expect(ass).toContain("{\\1c&H00FFFF&\\b1\\fs18}影响因子 3.5{\\r}\\N稳步上升");
    expect(ass).toContain("{\\1c&H00FFFF&\\b1\\fs18}审稿周期{\\r}约{\\1c&H00FFFF&\\b1\\fs18}2{\\r}个月");
  });
});

describe("emphasizeLine maxEmphasis 上限(7-02 防满屏黄字)", () => {
  it("超上限按信息量权重挑: 带小数/百分号数值 > 分区 > 硬词", () => {
    // 3 个合并区间: 影响因子26.3(w3) / 中科院1区(w2) / 录用率65%(w3) → cap2 留两个 w3
    const out = emphasizeLine("影响因子26.3中科院1区录用率65%高", 15, 2);
    expect(out).toContain("}影响因子26.3{\\r}");
    expect(out).toContain("}录用率65%{\\r}");
    expect(out).not.toContain("}中科院1区{\\r}");
    expect(out.split("{\\1c").length - 1).toBe(2);
  });
  it("0 = 不限(纯函数默认), 全部命中都强调", () => {
    const out = emphasizeLine("影响因子26.3中科院1区录用率65%高", 15, 0);
    expect(out.split("{\\1c").length - 1).toBe(3);
  });
});

describe("wrapCjkLine 中文强制换行(libass 0.15 不折 CJK)", () => {
  it("不超限原样返回", () => {
    expect(wrapCjkLine("十个字以内不折行", 10)).toEqual(["十个字以内不折行"]);
  });
  it("超限优先在中点附近标点断", () => {
    expect(wrapCjkLine("前面七个字没错的，后面六个字", 10)).toEqual(["前面七个字没错的", "后面六个字"]);
  });
  it("无标点硬切中点", () => {
    expect(wrapCjkLine("一二三四五六七八九十一二", 10)).toEqual(["一二三四五六", "七八九十一二"]);
  });
});
