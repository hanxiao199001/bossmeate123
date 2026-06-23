/**
 * 6-22 剪辑风格预设 + 账号自动匹配。
 *   现实版"学习+匹配": 用账号的 {领域, 范围, 人设} 三个信号规则映射到一套预设(语速/每幕时长/BGM风格)。
 *   不做"逐帧克隆别人视频"(研究级、不现实)。手动可在账号设置覆盖 clipStyle。
 *   v1 落地参数: ttsSpeed(语速) / sceneDurationMs(每幕默认时长) / bgmTag(BGM子目录, 不同风格不同曲库)。
 *   字幕动效/转场作为 v2 增量(需 composer 改造), 此处先不含。
 */
export type ClipStyleKey = "academic" | "popsci" | "marketing" | "data";

export interface ClipStylePreset {
  key: ClipStyleKey;
  label: string;
  ttsSpeed: number;        // 语速(atempo 倍数)
  sceneDurationMs: number; // 每幕默认时长(caller 未指定时用)
  bgmTag: string;          // BGM 子目录 data/bgm/<bgmTag>/; 不存在则回退 data/bgm/
  desc: string;
}

export const CLIP_STYLES: Record<ClipStyleKey, ClipStylePreset> = {
  academic:  { key: "academic",  label: "学术严谨稳重", ttsSpeed: 1.20, sceneDurationMs: 5500, bgmTag: "calm",      desc: "沉稳清晰、信息卡/数据图为主，适合医学/国外SCI/严肃学术号" },
  popsci:    { key: "popsci",    label: "科普轻快卡点", ttsSpeed: 1.28, sceneDurationMs: 3500, bgmTag: "upbeat",    desc: "快节奏、口语化，适合泛科普号" },
  marketing: { key: "marketing", label: "营销转化",     ttsSpeed: 1.20, sceneDurationMs: 4000, bgmTag: "energetic", desc: "钩子前置、强CTA，适合引流号" },
  data:      { key: "data",      label: "数据流",       ttsSpeed: 1.10, sceneDurationMs: 5000, bgmTag: "calm",      desc: "图表/数字为主、中速" },
};

export function isClipStyleKey(v: unknown): v is ClipStyleKey {
  return typeof v === "string" && v in CLIP_STYLES;
}

/**
 * 账号 → 剪辑风格 自动匹配:
 *   1) 手动设了 clipStyle 就用它(最高优先, 用户覆盖);
 *   2) 人设里带"营销/引流"→marketing, "科普/轻松/通俗"→popsci;
 *   3) 默认: 国外SCI 或 严肃学科(医学/生物/化学/物理/工程) → academic; 其余 → popsci。
 */
export function pickClipStyle(a: {
  clipStyle?: string | null;
  disciplines?: unknown;
  discipline?: string | null;
  journalScope?: string | null;
  persona?: string | null;
}): ClipStylePreset {
  if (isClipStyleKey(a.clipStyle)) return CLIP_STYLES[a.clipStyle];

  const persona = (a.persona ?? "").toString();
  if (/营销|引流|转化|带货|卖课|获客/.test(persona)) return CLIP_STYLES.marketing;
  if (/科普|轻松|有趣|通俗|搞笑|活泼/.test(persona)) return CLIP_STYLES.popsci;

  const ds = Array.isArray(a.disciplines) ? (a.disciplines as string[]) : a.discipline ? [a.discipline] : [];
  const SERIOUS = new Set(["medicine", "biology", "chemistry", "physics", "engineering", "environment", "agriculture"]);
  const serious = ds.some((d) => SERIOUS.has(d));
  if (a.journalScope === "international" || serious) return CLIP_STYLES.academic;
  return CLIP_STYLES.popsci;
}
