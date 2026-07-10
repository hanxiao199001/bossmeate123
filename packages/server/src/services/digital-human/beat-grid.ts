/**
 * 7-10 卡点转场: B-roll 插入/消失时刻从"seed 均匀随机"改为吸附 BGM 节拍网格。
 *
 * 网格定义: 原点 origin = 主视频起点(片头 xfade offset off1 — 即观众听到人声/BGM 正拍的起点),
 *   拍长 beatDur = 60 / bpm(bpm 来自 clip-styles 预设: upbeat 110 / energetic 128 / calm 无 bpm 不卡点)。
 *   网格上的合法时刻 = origin + n * beatDur (n 为整数)。
 *
 * 为什么原点取主视频起点而不是 t=0: BGM 用 amix duration=longest 从 t=0 起播, 但片头有 fade/标题,
 *   观感上的"节奏开始"在人声进来那一刻; 且 off1 本身就是片头→主体的 xfade 时刻, 以它为 0 拍,
 *   片头转场天然落在第 0 拍上, 不用额外吸附。
 *
 * 独立成零依赖模块的原因同 intro-templates: 单测/沙盒烧帧脚本直接 import, 不拖 env/storage。
 */

export interface BeatGrid {
  origin: number;  // 网格原点(秒) = 主视频起点 off1
  beatDur: number; // 单拍时长(秒) = 60 / bpm
}

/**
 * 把时刻 t 吸附到最近的整拍(unitBeats=2 则吸附到最近的偶数拍)。
 * mode:
 *   "nearest" 四舍五入到最近拍(默认, B-roll 起点用);
 *   "floor"   只向前吸(片尾 xfade 用 — 向后吸会把 offset 推过主视频末尾, ffmpeg 直接报错)。
 */
export function snapToBeat(t: number, grid: BeatGrid, unitBeats = 1, mode: "nearest" | "floor" = "nearest"): number {
  const step = grid.beatDur * unitBeats;
  const n = (t - grid.origin) / step;
  const snapped = grid.origin + (mode === "floor" ? Math.floor(n) : Math.round(n)) * step;
  return +snapped.toFixed(3);
}

export interface BrollSlot { start: number; seg: number; }

/**
 * B-roll 排期(seed 驱动, 原 video-remix.planBrollSlots 搬入):
 *   全部落在主视频 25%~80% 区间(避开片头/片尾 xfade), 每段 2.6~3.2s, 多张互不重叠且间隔 ≥5s
 *   (把区间均分成 slot, 抖动上限扣掉段长+最小间隔, 数学上保证任意相邻两段 gap ≥ 5s)。
 *
 * 7-10 新增 beat 参数: 传入节拍网格时, 起点吸附到最近整拍、段长吸附到整拍数(≥1 拍) —
 *   B-roll 的出现和消失都踩在拍上。吸附位移 ≤ 半拍(110bpm≈0.27s / 128bpm≈0.23s),
 *   远小于 MIN_GAP=5s 的预留量, 吸附后相邻两段间隔仍 ≥4s, 不会重叠。
 *   beat 不传(无 BGM / calm 风格无 bpm) = 完全回退老随机行为。
 */
export function planBrollSlots(
  r: () => number,
  mainDur: number,
  mainStart: number,
  count: number,
  beat?: BeatGrid,
): BrollSlot[] {
  const MIN_GAP = 5, SEG_MIN = 2.6, SEG_MAX = 3.2;
  const spanStart = mainStart + mainDur * 0.25;
  const span = mainDur * 0.55; // 25%~80%
  const n = Math.min(count, 3, Math.floor((span + MIN_GAP) / (SEG_MAX + MIN_GAP)));
  if (n <= 0) return [];
  const slot = span / n;
  const out: BrollSlot[] = [];
  for (let i = 0; i < n; i++) {
    let seg = +(SEG_MIN + r() * (SEG_MAX - SEG_MIN)).toFixed(3);
    const jitterMax = Math.max(0, slot - seg - MIN_GAP);
    let start = +(spanStart + i * slot + r() * jitterMax).toFixed(3);
    if (beat) {
      start = snapToBeat(start, beat);
      // 段长吸整拍数: 保证淡出结束也在拍上; clamp 到 ≥1 拍防 0 长段
      seg = +Math.max(beat.beatDur, Math.round(seg / beat.beatDur) * beat.beatDur).toFixed(3);
    }
    out.push({ start, seg });
  }
  return out;
}
