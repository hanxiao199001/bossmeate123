/**
 * 8-02 生成结果闭环 —— 把"零产出/产出不足"从**看意图**改成**看结果**。
 *
 * 【病根】原来这两条告警建立在 daily-cron 的 `totalProduced = batchIds.length + roundupCount` 上,
 *   而 batchIds 装的是 `createBatch()` 的返回值 —— createBatch 只是 `db.insert(batches)`, **纯入队**。
 *   真正的生成在下游 batch-worker 异步跑。所以:
 *     入队成功 → totalProduced 漂亮 → 两条告警都不响, 哪怕下游一篇都没生出来。
 *   实测(近 14 天): batch_rows 失败 416 / 成功 526, 而 zero_output / low_output / generation_failed
 *   三条 incident **一条都没有**。欠费/AI 挂掉恰恰长这样: 入队照常成功(几条 DB insert), 下游全军覆没。
 *
 * 【为什么放在简报侧而不是 daily-cron】
 *   daily-cron 03:00 排产, 那一刻批次刚入队、一篇都还没生成 —— 在那里查 contents 永远是 0。
 *   简报 09:30 跑, 那时当天批次早已跑完, 查到的才是**结果**。
 *   同时这也避免改 runDailyContentByType 的返回值语义(会波及它的调用方)。
 *
 * 【为什么用 batch_rows 自比而不是 contents/入队 比值】
 *   contents 里还有 roundup、数字人文案、admin 直接生成等**不走 batch 入队**的内容,
 *   分子分母根本不是同一个集合 —— 实测该比值在 96%~179% 之间乱跳(07-29 是 179%),
 *   按 ±30% 卡会天天误报。batch_rows 自己的 failed/total 才是"入队了但没生出来"的真实比例,
 *   实测 19 天稳定 0%、事故日 67%, 信噪比极好。
 */
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { batchRows, contents } from "../../models/schema.js";
import { logger } from "../../config/logger.js";

/** 实际产出低于目标的这个比例算"明显不够"(与 daily-cron 的 LOW_OUTPUT_RATIO 同一语感) */
export const OUTCOME_LOW_RATIO = 0.6;
/** batch_rows 失败率超过这个数 = 生成链路异常。实测正常日 0%、事故日 67%, 20% 已很宽松 */
export const PIPELINE_FAIL_RATIO = 0.2;
/** 样本太小时不判失败率(3 行挂 1 行 = 33%, 那是噪音不是信号) */
export const PIPELINE_MIN_ROWS = 10;

export interface GenerationOutcome {
  /** 当天**实际生成**的 contents 条数(结果, 不是入队意图) */
  generated: number;
  /**
   * 8-07 当天走了**降级标题兜底**的条数(metadata.titleFallback)。
   * 由来: article-skill 的 JSON 抽取失败兜底连续三天 100% 命中(80 篇), 而它零日志、
   *   零 incident、零标记 —— 8-05 建的失败分类体系对它完全失明(见 CLAUDE.md 红线 #14 第六条)。
   *   这个案子的核心教训就是"它悄悄发生了三天没人知道", 所以计数进简报, 让它从此不可能悄悄发生。
   */
  titleFallback: number;
  /** 当天排产目标 */
  target: number;
  /** 当天 batch_rows: 总数 / 失败数 */
  batchTotal: number;
  batchFailed: number;
}

/**
 * 采集当天生成结果。
 * ⚠️ 时间口径: contents / batch_rows 的 created_at 都是 `timestamp without time zone`(存 naive UTC),
 *   drizzle 传 JS Date 时按 UTC 比 —— 与 startOfBjDay() 给的瞬间正好对得上。
 *   **别**在这两张表上写 `AT TIME ZONE 'Asia/Shanghai'`(会反向偏移 8 小时, 8-02 自检踩过两次)。
 */
export async function collectGenerationOutcome(
  startOfTodayUtc: Date,
  target: number,
): Promise<GenerationOutcome> {
  const endOfToday = new Date(startOfTodayUtc.getTime() + 86_400_000);
  try {
    const [genRow] = await db
      .select({
        n: sql<string>`COUNT(*)`,
        fb: sql<string>`COUNT(*) FILTER (WHERE ${contents.metadata} ? 'titleFallback')`,
      })
      .from(contents)
      .where(and(gte(contents.createdAt, startOfTodayUtc), lt(contents.createdAt, endOfToday)));
    const [brRow] = await db
      .select({
        total: sql<string>`COUNT(*)`,
        failed: sql<string>`COUNT(*) FILTER (WHERE ${batchRows.status} = 'failed')`,
      })
      .from(batchRows)
      .where(and(gte(batchRows.createdAt, startOfTodayUtc), lt(batchRows.createdAt, endOfToday)));
    return {
      generated: Number(genRow?.n ?? 0),
      titleFallback: Number((genRow as { fb?: string } | undefined)?.fb ?? 0),
      target,
      batchTotal: Number(brRow?.total ?? 0),
      batchFailed: Number(brRow?.failed ?? 0),
    };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "生成结果采集失败, 本次不判定");
    return { generated: -1, titleFallback: 0, target, batchTotal: 0, batchFailed: 0 };
  }
}

export interface OutcomeVerdict {
  kind: "zero_output" | "low_output" | "generation_pipeline_unhealthy" | "title_fallback";
  severity: "error" | "warn";
  message: string;
  detail: Record<string, unknown>;
}

/**
 * 纯函数: 结果 → 判定。无 IO, 直接单测。
 * generated < 0 表示采集失败 → 一条都不判(宁可不报, 不可乱报)。
 */
export function judgeGenerationOutcome(o: GenerationOutcome): OutcomeVerdict[] {
  const out: OutcomeVerdict[] = [];
  if (o.generated < 0) return out;

  const failRatio = o.batchTotal > 0 ? o.batchFailed / o.batchTotal : 0;

  // ① 零产出 —— 看的是**实际生成条数**, 不再是入队数
  if (o.generated === 0) {
    out.push({
      kind: "zero_output", severity: "error",
      message:
        `今天一篇内容都没生成出来(目标 ${o.target} 篇)。` +
        (o.batchTotal > 0
          ? `当天有 ${o.batchTotal} 行进了生成队列、其中 ${o.batchFailed} 行失败 —— 说明排产是正常的, 卡在生成环节。`
          : `当天连生成队列都没进过行 —— 说明卡在排产环节(选不出刊/选不出题/定时任务没跑)。`),
      detail: { ...o, failRatio },
    });
  } else if (o.target > 0 && o.generated < o.target * OUTCOME_LOW_RATIO) {
    // ② 产出不足 —— 同样看结果
    out.push({
      kind: "low_output", severity: "warn",
      message:
        `今天实际只生成 ${o.generated} 篇, 目标 ${o.target} 篇(不足 ${Math.round(OUTCOME_LOW_RATIO * 100)}%)。` +
        (o.batchTotal > 0 ? `生成队列 ${o.batchTotal} 行中失败 ${o.batchFailed} 行。` : ""),
      detail: { ...o, failRatio },
    });
  }

  // ③b 8-07 降级标题兜底 —— 内容"生成成功"了, 但标题是代码拼的、深度章节与视频脚本全缺。
  //   它不是链路故障(batch_rows 看不出), 也不是产量问题(generated 照常计数) ——
  //   正因为哪个既有指标都照不到它, 才需要单独一条。实测曾连续三天 100% 无人知晓。
  if (o.generated > 0 && o.titleFallback > 0) {
    const ratio = o.titleFallback / o.generated;
    out.push({
      kind: "title_fallback",
      severity: ratio >= 0.3 ? "error" : "warn",
      message:
        `今天 ${o.titleFallback}/${o.generated} 篇(${Math.round(ratio * 100)}%)用了降级标题 —— ` +
        `这些内容的标题是代码拼的, 深度章节与视频脚本缺失。` +
        `根因看服务器日志「期刊推荐 JSON 抽取失败」那条(带原始返回/finishReason/模型名)。`,
      detail: { ...o, ratio },
    });
  }

  // ③ 生成链路异常 —— batch_rows **自比**(分子分母同一集合)。
  //    这条是 08-01 那个洞的直接守卫: 入队 617 行只出 219 篇, 以后会自己喊出来。
  if (o.batchTotal >= PIPELINE_MIN_ROWS && failRatio > PIPELINE_FAIL_RATIO) {
    out.push({
      kind: "generation_pipeline_unhealthy", severity: "error",
      message:
        `生成链路异常: 今天进队列 ${o.batchTotal} 行, 失败 ${o.batchFailed} 行(${Math.round(failRatio * 100)}%)。` +
        `正常应接近 0% —— 先看 AI 额度/日调用上限, 再看服务器日志里的生成报错。`,
      detail: { ...o, failRatio },
    });
  }
  return out;
}
