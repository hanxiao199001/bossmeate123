/**
 * 竖屏（9:16）版面分区 —— 数字人视频里「文字能落在哪」的**唯一真相源**（8-12）。
 *
 * ## 病因
 *
 * 老韩反馈字幕挡脸。查下来不是字号问题（7-02 已把 36→15 校准过），
 * 是**锚点方向搞反了**：ASS `Alignment=2` 时 `MarginV` 量的是**文本块底边距屏底**，
 * 文字向**上**生长。`MarginV=84` 把底边钉在距顶 70.8%，然后：
 *
 * ```
 * 2 行 × 字号 15            ≈ 36 单位 → 顶边到距顶 58%
 * 行内强调放大 1.35 倍(fs≈20) ≈ 49 单位 → 顶边到距顶 53%
 * ```
 *
 * 而人物区是 25%–70%。**「底边卡在 70% 然后往上长」必然进脸**。
 * 正解是把整块夹在 70%–85% 之间：底边锚 85%，高度不许越过 70%。
 *
 * ## 🔴 这是「自校验型」判据 —— 版面既然是自己算的，遮挡在合成前就能算出来
 *
 * 不需要人脸检测，也不需要看成片。`checkOcclusion()` 是纯几何，合成前跑，
 * 重叠超阈值就拒绝并自动下移。判据本身错了会自相矛盾（算出来的框和渲染的框不一致），
 * 这类判据从第一天就产出可信信号，不用等台账成熟。
 * （`CC-方法论移植.md` Phase 1 的天然客户，checkerId = `subtitle_occlusion`。）
 */

/** 一个纵向区间，用占全高的比例表示（0=顶，1=底） */
export interface Band {
  /** 距顶比例 */
  from: number;
  /** 距顶比例 */
  to: number;
}

/**
 * 竖屏五区。**改这里就等于改全片版面**，别在别处写死数字。
 *
 * ```
 * 0-12%    顶部安全区   可放标题条（平台状态栏下方）
 * 12-25%   钩子大字区   强调卡的唯一合法位置
 * 25-70%   人物区       🔴 任何文字禁入（数字人半身像的脸+躯干）
 * 70-85%   常规字幕带   逐句字幕的唯一位置，最多 2 行
 * 85-100%  平台 UI 区   禁入（抖音/视频号的文案、进度条、音乐条）
 * ```
 */
export const ZONES = {
  topSafe: { from: 0.0, to: 0.12 },
  hookBand: { from: 0.12, to: 0.25 },
  personBand: { from: 0.25, to: 0.7 },
  subtitleBand: { from: 0.7, to: 0.85 },
  platformUi: { from: 0.85, to: 1.0 },
} as const satisfies Record<string, Band>;

/** 右侧禁入比例（抖音点赞/评论/分享图标列） */
export const RIGHT_UI_EXCLUSION = 0.15;

/** 文字禁入的区间（人物区 + 平台 UI 区） */
export const FORBIDDEN_BANDS: Band[] = [ZONES.personBand, ZONES.platformUi];

/**
 * 人物框。**当前全部形象都是「居中半身」，先给统一默认值**；
 * 将来站姿/侧位形象在形象目录里加 `personBox` 覆盖即可，不改代码（③）。
 */
export interface PersonBox {
  /** 左边距比例 */
  x: number;
  /** 顶边距比例 */
  y: number;
  /** 宽度比例 */
  w: number;
  /** 高度比例 */
  h: number;
}

export const DEFAULT_PERSON_BOX: PersonBox = {
  x: 0,
  y: ZONES.personBand.from,
  w: 1,
  h: ZONES.personBand.to - ZONES.personBand.from,
};

/** 重叠超过这个比例就判遮挡（占文字框面积） */
export const OCCLUSION_TOLERANCE = 0.05;

/**
 * libass 行高 / 字号。CJK 实测约 1.2（含行间留白）。
 * 高一点是保守方向：宁可算得比实际高，也不要算完仍然溢出。
 */
const LINE_HEIGHT_RATIO = 1.2;

/** 行内强调的**期望**放大倍数（7-02 定的视觉值）。放不下时会被下面的 cap 压低 */
export const DESIRED_EMPHASIS_SCALE = 1.35;

/** 常规字幕最多几行 —— 超过就不是字幕是段落了 */
export const MAX_SUBTITLE_LINES = 2;

// ══════════════════════════════════════════════════════════════════
// 几何换算（全部纯函数，输入输出都写明单位，别在调用方自己乘除）
// ══════════════════════════════════════════════════════════════════

/** 区间高度（比例） */
export function bandHeight(b: Band): number {
  return Math.max(0, b.to - b.from);
}

/**
 * `Alignment=2`（底部居中）时，把文本块底边锚到某区间下沿所需的 ASS MarginV。
 * @param playResY ASS 坐标系高度（本项目固定 288，见 subtitle-emphasis 文件头）
 */
export function marginVForBand(b: Band, playResY: number): number {
  return Math.round(playResY * (1 - b.to));
}

/**
 * 一个 N 行、字号 F 的文本块在 ASS 坐标系里占多高（单位数）。
 * 行内有强调时按放大后的字号算 —— libass 的行高取该行最高字形。
 */
export function blockHeightUnits(lines: number, fontSize: number, emphasisScale = 1): number {
  return lines * fontSize * emphasisScale * LINE_HEIGHT_RATIO;
}

/**
 * 文本块实际占据的纵向区间（比例）。底边锚在 `band.to`，向上生长。
 */
export function textBoxForBand(
  band: Band,
  lines: number,
  fontSize: number,
  playResY: number,
  emphasisScale = 1,
): Band {
  const hPct = blockHeightUnits(lines, fontSize, emphasisScale) / playResY;
  return { from: band.to - hPct, to: band.to };
}

/**
 * 在给定区间内，N 行文本允许的最大字号（含强调放大后仍不溢出）。
 * 这就是「字号上限按『N 行放得下』反推」。
 */
export function maxFontSizeForBand(band: Band, lines: number, playResY: number, emphasisScale = 1): number {
  const avail = bandHeight(band) * playResY;
  return Math.floor(avail / (lines * emphasisScale * LINE_HEIGHT_RATIO));
}

/**
 * 给定字号与行数，强调放大最多能到多少倍而不溢出区间。
 *
 * ⚠️ 8-12 实测：字号 15 / 2 行 / 期望 1.35 倍，在 15% 的字幕带里**放不下**
 * （2×15×1.35×1.2 = 48.6 单位 > 43.2 单位）。所以强调倍数必须由版面反推，
 * 不能是一个拍脑袋的常数 —— 否则每次调字号都可能悄悄把字幕顶进人物区。
 */
export function emphasisScaleCap(band: Band, lines: number, fontSize: number, playResY: number): number {
  const avail = bandHeight(band) * playResY;
  if (fontSize <= 0 || lines <= 0) return DESIRED_EMPHASIS_SCALE;
  const cap = avail / (lines * fontSize * LINE_HEIGHT_RATIO);
  return Math.min(DESIRED_EMPHASIS_SCALE, Math.max(1, Number(cap.toFixed(2))));
}

// ══════════════════════════════════════════════════════════════════
// ④ 确定性遮挡检查
// ══════════════════════════════════════════════════════════════════

export interface OcclusionResult {
  ok: boolean;
  /** 重叠面积 / 文字框面积 */
  overlapRatio: number;
  /** 撞上了哪个禁区 */
  hit?: "person" | "platformUi";
  /** 修正建议：把文本块底边锚到这个比例处（= 合法区下沿） */
  suggestedBandTo?: number;
  detail?: string;
}

function overlap(a: Band, b: Band): number {
  return Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
}

/**
 * 纯几何遮挡检查。文字框 vs 人物框 / 平台 UI 区。
 *
 * 只比纵向 —— 人物框当前恒为整宽（居中半身），横向不构成额外约束。
 * 将来 ③ 给出真正的 `personBox.x/w` 后，这里再加横向判定（届时改这一个函数）。
 */
export function checkOcclusion(textBox: Band, person: PersonBox = DEFAULT_PERSON_BOX): OcclusionResult {
  const h = bandHeight(textBox);
  if (h <= 0) return { ok: true, overlapRatio: 0 };

  const personBand: Band = { from: person.y, to: person.y + person.h };
  const withPerson = overlap(textBox, personBand) / h;
  const withUi = overlap(textBox, ZONES.platformUi) / h;

  if (withPerson > OCCLUSION_TOLERANCE) {
    return {
      ok: false,
      overlapRatio: Number(withPerson.toFixed(3)),
      hit: "person",
      suggestedBandTo: ZONES.subtitleBand.to,
      detail:
        `文字框 ${(textBox.from * 100).toFixed(1)}%~${(textBox.to * 100).toFixed(1)}% ` +
        `与人物区 ${(personBand.from * 100).toFixed(0)}%~${(personBand.to * 100).toFixed(0)}% ` +
        `重叠 ${(withPerson * 100).toFixed(1)}%（阈值 ${OCCLUSION_TOLERANCE * 100}%）`,
    };
  }
  if (withUi > OCCLUSION_TOLERANCE) {
    return {
      ok: false,
      overlapRatio: Number(withUi.toFixed(3)),
      hit: "platformUi",
      suggestedBandTo: ZONES.subtitleBand.to,
      detail: `文字框伸进平台 UI 区，重叠 ${(withUi * 100).toFixed(1)}%`,
    };
  }
  return { ok: true, overlapRatio: Number(Math.max(withPerson, withUi).toFixed(3)) };
}

/**
 * 常规字幕的完整版面解算：给定 env 里的字号与 MarginV，算出**合法**的一组参数。
 *
 * 返回值里的 `corrected` 说明「env 给的值会挡脸，已自动改」——
 * 调用方应当把它记进日志（checkerId=`subtitle_occlusion`），而不是静默吞掉：
 * 静默修正会让人以为 env 生效了，下次调 env 又白调一遍。
 */
export interface SubtitleLayout {
  /** 应当写进 ASS 的 MarginV */
  marginV: number;
  /** 允许的最大行数 */
  maxLines: number;
  /** 允许的字号（可能低于 env 值） */
  fontSize: number;
  /** 允许的强调放大倍数（可能低于 1.35） */
  emphasisScale: number;
  /** 解算出的文字框 */
  textBox: Band;
  /** 是否对 env 值做了修正 */
  corrected: boolean;
  /** 逐条修正说明，供日志与台账 */
  notes: string[];
  /** 解算完的自查结果（checkerId=subtitle_occlusion 的数据源） */
  occlusion: OcclusionResult;
}

export function solveSubtitleLayout(input: {
  fontSize: number;
  marginV: number;
  playResY: number;
  /** 实际需要几行（按真实 cue 折行统计）。默认按上限 2 行算 */
  linesNeeded?: number;
  person?: PersonBox;
}): SubtitleLayout {
  const { playResY, person = DEFAULT_PERSON_BOX } = input;
  const band = ZONES.subtitleBand;
  // 某条 cue 折成 3 行时整轨一起降字号, 而不是让那一条溢出人物区
  const lines = Math.max(1, input.linesNeeded ?? MAX_SUBTITLE_LINES);
  const notes: string[] = [];
  let corrected = false;

  // ① MarginV 必须把底边锚在字幕带下沿；env 里若是别的值，一律以版面为准
  const wantMarginV = marginVForBand(band, playResY);
  let marginV = input.marginV;
  if (marginV !== wantMarginV) {
    notes.push(`MarginV ${marginV} → ${wantMarginV}（底边锚到字幕带下沿 ${band.to * 100}%）`);
    marginV = wantMarginV;
    corrected = true;
  }

  // ② 字号不得超过「MAX_SUBTITLE_LINES 行放得下」的上限（先按不放大算）
  let fontSize = input.fontSize;
  const fsCap = maxFontSizeForBand(band, lines, playResY, 1);
  if (fontSize > fsCap) {
    notes.push(`字号 ${fontSize} → ${fsCap}（最长一条要 ${lines} 行，放不下）`);
    fontSize = fsCap;
    corrected = true;
  }

  // ③ 强调放大倍数由剩余空间反推
  const emphasisScale = emphasisScaleCap(band, lines, fontSize, playResY);
  if (emphasisScale < DESIRED_EMPHASIS_SCALE) {
    notes.push(`强调放大 ${DESIRED_EMPHASIS_SCALE} → ${emphasisScale}（再大就顶进人物区）`);
    corrected = true;
  }

  const textBox = textBoxForBand({ ...band, to: 1 - marginV / playResY }, lines, fontSize, playResY, emphasisScale);
  // 🔴 解算完再自查一遍 —— 判据自己也要过判据, 否则"算错了"和"算对了"在下游同样看不出来
  const occ = checkOcclusion(textBox, person);
  if (!occ.ok) notes.push(`⚠️ 解算后仍遮挡: ${occ.detail}`);
  return { marginV, maxLines: lines, fontSize, emphasisScale, textBox, corrected, notes, occlusion: occ };
}
