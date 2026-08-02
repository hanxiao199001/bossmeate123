/**
 * 防锚定闸(Golden Set 的地基)。
 *
 * 【为什么这是最重要的一个文件】
 *   Golden Set 要回答的问题是"人的判断 vs 六维分差在哪"。标注人只要先看见"83 分",
 *   他的判断就被那个数字拽过去了 —— 这不是"轻微偏差", 而是这批数据**测不到它要测的东西**,
 *   整批作废且**看不出来作废**(数据长得完全正常, 只是相关性虚高)。
 *   所以这道闸不能只靠"前端不显示": 数据只要进了响应体, 早晚会有人 console.log 出来、
 *   会被下一个改前端的人顺手渲染上去。**在后端就剔除**才是真闸。
 *
 * 【三层锁】
 *   ① 白名单投影: buildBlindCard() 逐字段手写构造, 全程不 spread contents 行, 也不带 metadata blob。
 *   ② 运行时体检: assertBlind() 深扫最终 payload, 命中评分类 key 直接抛错(500 好过静默泄漏)。
 *   ③ 接口时序闸: 系统分接口要求"你已经标过这一篇"才给看(见 routes/golden-set.ts)。
 *
 * 【维护须知】
 *   往 contents.metadata 里加任何新的评分/审稿类字段时, 把 key 加进 BLINDED_KEYS。
 *   忘了加也不会静默 —— 只要它进了 blind 响应, assertBlind 会当场炸(测试也锁了)。
 */

/**
 * 禁止出现在"标注前"响应里的 key(小写比较)。
 * 覆盖: 六维质检 / 轻量质检分 / AI 审稿 / 质检状态与待审原因 / 校准样本。
 */
export const BLINDED_KEYS: readonly string[] = [
  // —— 六维质检(quality-pipeline.ts qualityPipelineMeta 的全部产物)
  "sixdimscores",
  "sixdimtotal",
  "sixdimpassed",
  "sixdimdegraded",
  "sixdimdegradedreason",
  "sixdimscoredby",
  "sixdimscorermodel",
  "sixdimweak",
  "qualityloop",
  "datadensity",
  // —— 轻量质检 / 通用分数
  "qualityscore",
  "qualitypassed",
  "score",
  "totalscore",
  "scores",
  "grade",
  "rating",
  // —— AI 审稿(影子模式)
  "aireview",
  "verdict",
  "confidence",
  // —— 质检状态 / 待审原因(也是强锚: "待审"两个字等于告诉标注人这篇不行)
  "status",
  "needsreview",
  "needsreviewreason",
  "reviewreason",
  "gateunavailable",
  "titleissue",
  "bodyfabrication",
  "validatorissues",
  "haswarnings",
  "warnings",
  // —— 人工历史裁决(同样是锚)
  "calibration",
  "userselected",
  "userrejected",
  // —— 本工具自己的标注结果(候选列表里也不该带别人的标, 防标注者互相锚定)
  "label",
  "annotations",
];

const BLINDED_SET = new Set(BLINDED_KEYS);

/** 深扫对象, 返回所有命中禁用 key 的路径(空数组 = 干净)。 */
export function findScoreLeaks(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 12 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`, depth + 1));
      return;
    }
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      const here = `${p}.${k}`;
      if (BLINDED_SET.has(k.toLowerCase())) hits.push(here);
      walk(sub, here, depth + 1);
    }
  };
  walk(value, path, 0);
  return hits;
}

export class AnchorLeakError extends Error {
  constructor(public readonly leaks: string[]) {
    super(`防锚定闸拦截: 标注前响应里出现评分类字段 ${leaks.join(", ")}`);
    this.name = "AnchorLeakError";
  }
}

/**
 * 最终防线: 发响应前跑一遍。命中即抛 —— 宁可 500, 也不能让标注人看见分数。
 * (一次响应几十条卡片、每条几个字段, 深扫成本可忽略。)
 */
export function assertBlind<T>(payload: T): T {
  const leaks = findScoreLeaks(payload);
  if (leaks.length > 0) throw new AnchorLeakError(leaks);
  return payload;
}

// ============ 白名单投影 ============

/** 内容形态标签 — 判断"对不对口"要用, 本身不含质量信号。 */
export type ContentKind = "domestic" | "international" | "roundup" | "video" | "other";

export const CONTENT_KIND_TEXT: Record<ContentKind, string> = {
  domestic: "国内刊单篇",
  international: "国际刊单篇",
  roundup: "多刊盘点",
  video: "视频脚本",
  other: "其他",
};

/** 期刊信息(判断对不对口/数据真不真, 与质量评价无关) */
export interface BlindJournal {
  id: string;
  name: string | null;
  nameEn: string | null;
  impactFactor: number | null;
  compositeImpactFactor: number | null;
  partition: string | null;
  casPartitionNew: string | null;
  catalogs: string[];
  cscdLevel: string | null;
  pkuCoreLevel: string | null;
}

/**
 * 标注卡 —— 标注人在"提交之前"能看到的**全部**信息。
 * 刻意没有: 六维分 / AI 审稿 / status(待审=强锚) / 别人的标注。
 */
export interface BlindCard {
  id: string;
  title: string | null;
  body: string | null;
  kind: ContentKind;
  kindText: string;
  createdAt: string | null;
  journal: BlindJournal | null;
  /** 我(当前标注人)之前标过什么 —— 自己的判断不是锚, 而且要能改 */
  myLabel: string | null;
  myReason: string | null;
}

/** 原始行(路由从 DB 明确投影出来的字段, 不含任何评分列) */
export interface BlindCardSource {
  id: string;
  title: string | null;
  body: string | null;
  type: string | null;
  createdAt: Date | string | null;
  isRoundup: boolean;
  journal: (BlindJournal & { journalKind: string | null }) | null;
  myLabel?: string | null;
  myReason?: string | null;
}

const VIDEO_TYPES = new Set(["video", "video_script"]);

/** 内容形态判定: 视频 > 盘点 > 按期刊归属(journal_kind 归一列, 见 migration 030)。 */
export function resolveContentKind(src: Pick<BlindCardSource, "type" | "isRoundup" | "journal">): ContentKind {
  if (src.type && VIDEO_TYPES.has(src.type)) return "video";
  if (src.isRoundup) return "roundup";
  const jk = src.journal?.journalKind;
  if (jk === "intl") return "international";
  // 'both'(骑墙刊: 国际指标+国内目录)按国内算 —— 这类稿子的读者与选题口径都是国内投稿人
  if (jk === "cn" || jk === "both") return "domestic";
  return "other";
}

/**
 * 逐字段手写构造标注卡。
 * ⚠️ 绝不要改成 `{ ...row, ... }` —— 那一行就是整个防锚定设计的破口:
 *   contents 行里带 metadata(六维分全在里面)和 status, spread 一次全泄。
 */
export function buildBlindCard(src: BlindCardSource): BlindCard {
  const kind = resolveContentKind(src);
  return {
    id: src.id,
    title: src.title ?? null,
    body: src.body ?? null,
    kind,
    kindText: CONTENT_KIND_TEXT[kind],
    createdAt: src.createdAt instanceof Date ? src.createdAt.toISOString() : (src.createdAt ?? null),
    journal: src.journal
      ? {
          id: src.journal.id,
          name: src.journal.name,
          nameEn: src.journal.nameEn,
          impactFactor: src.journal.impactFactor,
          compositeImpactFactor: src.journal.compositeImpactFactor,
          partition: src.journal.partition,
          casPartitionNew: src.journal.casPartitionNew,
          catalogs: Array.isArray(src.journal.catalogs) ? src.journal.catalogs.map(String) : [],
          cscdLevel: src.journal.cscdLevel,
          pkuCoreLevel: src.journal.pkuCoreLevel,
        }
      : null,
    myLabel: src.myLabel ?? null,
    myReason: src.myReason ?? null,
  };
}

/**
 * BlindCard 用 myLabel/myReason 表达"我自己标过什么"(自己的判断不是锚)。
 * 但它们的 key 若叫 label/reason 就会被 assertBlind 拦下 —— 这里明确用带 my 前缀的名字,
 * 既过闸又语义清楚: 卡片里出现的标注**只可能是你自己的**, 永远看不到别人的。
 */
