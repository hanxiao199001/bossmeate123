/**
 * 「学科定位」生成器（A2 第 7 步，8-10）—— 薄编排层。
 *
 * 顺序固定：准入 → prompt → LLM → 抽 JSON → 渲染 → 四道校验。
 * 每一步的判据都在别的文件里，这里只负责串起来和记录失败原因。
 *
 * ## 🔴 失败一律返回 null，不做「像样但假」的降级
 *
 * 隔壁 `roundup-generator` 有个 `ruleFallback()`，LLM 挂了就拼一篇
 * 「审稿周期以官网为准…核心原因：它们更看研究本身」——**产物与真稿在下游完全无法区分**，
 * 这正是红线 #14 说的那类东西。本体裁不重复这个错：
 *   · 准入不过 → 不生成，记原因码
 *   · JSON 抽不出 → `logger.error` 打 rawHead / finishReason / outputTokens / model，返回 null
 *     （8-07 那次 82 篇兜底标题的教训：`if (jsonMatch) {...}` 没有 else，
 *       失败被静默吞掉，靠句式指纹才把真实规模挖出来）
 *
 * ## 四道校验都跑，但**样例阶段不拦**
 *
 * 校验结果原样返回给调用方。样例脚本要的是「命中了几条」这个数（拍板材料之一），
 * 而不是一个干净的产物 —— 把违规的悄悄丢掉，就永远不知道这个体裁真实的编造率。
 * 若将来上线，拦不拦、拦哪几条，是那时候的决定，不在这里预设。
 *
 * ## 🔴 别关 deepseek-v4-pro 的推理预算（8-14 实测记录）
 *
 * **推理预算与正文丰富度正相关，不是纯开销。** 10 刊同刊 A/B 实测：
 *
 * ```
 * 推理开   均 tok 1746(推理 609)   均字数 889   章节 1.8/4   口播 10/10
 * 推理关   均 tok  831(推理   0)   均字数 585   章节 1.9/4   口播 10/10
 * ```
 *
 * 字数 **-34%**，直接跌出 800-1200 目标区间；章节/口播/健康问题/JSON 成功率全部持平。
 * 换句话说：关掉它是拿三分之一的正文长度去换 900 token。
 *
 * 会有人（包括我）再想关一次 —— 动机很充分：百炼的 `reasoning_tokens` **算在
 * completion_tokens 里**，与正文共用 `maxTokens` 预算，日志里 3 条
 * `outputTokens=6001 / rawLength=0` 就是预算被推理吃光、正文一个字都没轮上。
 * 但"烧了钱"不等于"没用"。**想省它之前，先跑
 * `scripts/compare-thinking.ts` 复现这组数字。**
 *
 * 开关本身留着（`env.LLM_DISABLE_THINKING`，默认 false）—— 留的是复现实验的能力，
 * 不是留一个"随时可以打开省钱"的口子。
 *
 * **8-15 追加：`reasoning_effort=low` 也试过了，同样不采用。**
 * 18 次同刊 A/B（含日志里真撞过顶的 2 本各 5 次）：实验组在字数、章节、
 * 健康问题上都**略好或持平**，但推理量峰值只从 3599 压到 3115 ——
 * **这个参数对长尾几乎没有约束力**，而"压住撞顶"正是做它的唯一动机。
 * 现状臂 10 次一次都没复现撞顶（生产频率 0.17%），判据③ 无法裁决。
 * 结论：不改参数。撞顶已由 `empty_output` 守卫兜住（→ deferred → 自动重跑），
 * 代价是 0.17% 的文章多一次调用，没有废稿流到下游。降级为观察项。

 */
import { logger } from "../../config/logger.js";
import { getProviders } from "../ai/provider-factory.js";
import { extractJsonObject } from "./llm-json.js";
import { generateDisciplinePositionHtml } from "../publisher/adapters/discipline-position-template.js";
import {
  findCohortNumberViolations,
  findMembershipClaimViolations,
  type CohortNumberViolation,
} from "./cohort-fact-check.js";
import { computeFactDensity, type FactDensity } from "./fact-density.js";
import { checkOutputHealth, type OutputHealthResult } from "../publisher/output-health.js";
import { findBodyFabrication } from "../compliance/content-check.js";
import { classifyDataSupply, hasNoMetricFacts } from "../journals/journal-data-supply.js";
import {
  cohortEligible,
  cohortMetadata,
  type CohortJournalRow,
  type CohortSkipReason,
  type DisciplineCohort,
} from "../journals/discipline-cohort.js";
import { buildCohortFromRow } from "../journals/discipline-cohort.js";
import {
  buildDisciplinePositionPrompt,
  DISCIPLINE_POSITION_JSON_KEYS,
  type DisciplinePositionContent,
} from "./discipline-position-prompt.js";

/**
 * ⚠️ 必须与 MAX_TOKENS 同步。8-10 踩过一次：为修截断把 MAX_TOKENS 3000→8000，
 * 却没动这里的 120s —— 结果 10 篇里 3 篇撞超时（修好了一个失败模式，换来另一个）。
 * 推理模型吐 8000 token 的实测耗时在 100~200s，留一倍余量。
 */
const LLM_TIMEOUT_MS = 300_000;
/**
 * 8-10 实测：deepseek-v4-pro 是**推理模型**，会先烧一大段思考再吐内容。
 * maxTokens=3000 时两篇跑到 outputTokens=3001（撞顶），真正吐出的正文只有 206 / 342 字符 ——
 * 而模板把数字都填上了，成品看起来仍是一篇完整文章。截断产物与好产物无法区分，红线 #14。
 * 抬到 8000 给推理留出余量，同时下面对 finishReason==="max_tokens" 直接拒收。
 */
const MAX_TOKENS = 8000;

export type GenerateSkipReason =
  | CohortSkipReason
  | "llm_error"
  | "llm_json_failed"
  | "llm_truncated"
  | "llm_empty_fields";

export interface DisciplinePositionResult {
  ok: true;
  cohort: DisciplineCohort;
  narrative: DisciplinePositionContent;
  title: string;
  html: string;
  /** 本篇选中的变体，落 metadata */
  recipe: { hook: string; structure: string; closing: string };
  metadata: Record<string, unknown>;
  checks: {
    numberViolations: CohortNumberViolation[];
    /**
     * 🔻 **影子检查，不计入违规数**（8-11 降级；台账 37 报 0 中，见 cohort-fact-check 文件头）。
     * 只落 metadata 供事后翻查；升级回闸的条件是连续真阳性 ≥ 2 例。
     */
    membershipShadow: CohortNumberViolation[];
    /** findBodyFabrication 的返回（字段级编造） */
    fabrication: ReturnType<typeof findBodyFabrication>;
    health: OutputHealthResult;
    density: FactDensity;
  };
  llm: { model: string; finishReason: string; outputTokens: number; rawLength: number };
}

export interface DisciplinePositionSkip {
  ok: false;
  reason: GenerateSkipReason;
  detail?: string;
}

export interface GenerateOptions {
  row: CohortJournalRow;
  persona?: string | null;
  styleProfile?: string | null;
  rotationScope?: string;
  variantSeed?: number;
  temperature?: number;
}

/**
 * `CohortJournalRow` 的字段是 `unknown`（它复用 `JournalSupplyInput` 的宽松签名），
 * 而 `findBodyFabrication` 要的是收窄类型。这里显式收窄而不是 `as any` ——
 * 一个类型断言就能让「分区列其实是数字」这种脏数据悄悄穿过编造闸。
 * 收窄规则与 `hasDbFact` 一致：非期望类型一律当作"没有这个事实"。
 */
function toFabricationFields(row: CohortJournalRow) {
  const r = row as unknown as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    reviewCycle: s(r.reviewCycle),
    acceptanceRate: n(r.acceptanceRate),
    impactFactor: n(r.impactFactor),
    compositeImpactFactor: n(r.compositeImpactFactor),
    partition: s(r.partition),
    casPartition: s(r.casPartition),
    casPartitionNew: s(r.casPartitionNew),
    jcrFull: r.jcrFull,
  };
}

/** 模型偶发把字符串字段返成数组/数字，统一压成字符串 */
function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("\n").trim();
  return "";
}

export async function generateDisciplinePosition(
  opts: GenerateOptions,
): Promise<DisciplinePositionResult | DisciplinePositionSkip> {
  const cohort = buildCohortFromRow(opts.row);
  const gate = cohortEligible(cohort);
  if (!gate.ok) return { ok: false, reason: gate.reason! };

  const supply = classifyDataSupply(opts.row);
  const prompt = buildDisciplinePositionPrompt({
    cohort,
    supply,
    persona: opts.persona,
    styleProfile: opts.styleProfile,
    rotationScope: opts.rotationScope,
    variantSeed: opts.variantSeed,
  });

  const provider = getProviders().expensive[0];
  if (!provider) return { ok: false, reason: "llm_error", detail: "无可用 provider" };

  let resp: Awaited<ReturnType<typeof provider.chat>>;
  try {
    resp = await Promise.race([
      provider.chat({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: opts.temperature ?? 0.7,
        maxTokens: MAX_TOKENS,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("DISCIPLINE_POSITION_LLM_TIMEOUT")), LLM_TIMEOUT_MS)),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ journal: cohort.name, detail }, "discipline_position.llm_error");
    return { ok: false, reason: "llm_error", detail };
  }

  // 🔴 截断即拒收。extractJsonObject 会把被截断的 JSON "修好"，于是短了一半的正文
  //   照样渲染成一篇完整文章 —— 这正是红线 #14 那类无法区分的降级产物。
  if (resp.finishReason === "max_tokens") {
    logger.error(
      { journal: cohort.name, model: resp.model, outputTokens: resp.outputTokens, rawLength: resp.content?.length ?? 0 },
      "discipline_position.truncated",
    );
    return { ok: false, reason: "llm_truncated", detail: `outputTokens=${resp.outputTokens} 撞上限` };
  }

  const extracted = extractJsonObject(resp.content);
  if (!extracted.value || typeof extracted.value !== "object") {
    // 🔴 观测字段一个都不能少 —— 8-07 那次就是因为失败被静默吞掉，
    //   事后只能靠正文句式指纹反推规模（而占位符正则只看得见其中一半）。
    logger.error(
      {
        journal: cohort.name,
        model: resp.model,
        finishReason: resp.finishReason,
        outputTokens: resp.outputTokens,
        rawLength: resp.content?.length ?? 0,
        rawHead: (resp.content ?? "").slice(0, 300),
        repairs: extracted.repairs,
      },
      "discipline_position.json_extract_failed",
    );
    return { ok: false, reason: "llm_json_failed", detail: `finish=${resp.finishReason} len=${resp.content?.length ?? 0}` };
  }

  const raw = extracted.value as Record<string, unknown>;
  const narrative = Object.fromEntries(
    DISCIPLINE_POSITION_JSON_KEYS.map((k) => [k, str(raw[k])]),
  ) as unknown as DisciplinePositionContent;

  // 标题或主叙事整段为空 = 这次生成没产出内容。同样不许拼一个像样的标题顶上
  if (!narrative.title || !narrative.positioning) {
    logger.error(
      { journal: cohort.name, model: resp.model, finishReason: resp.finishReason, keys: Object.keys(raw) },
      "discipline_position.empty_fields",
    );
    return { ok: false, reason: "llm_empty_fields", detail: `keys=${Object.keys(raw).join(",")}` };
  }

  const html = generateDisciplinePositionHtml(cohort, narrative);

  return {
    ok: true,
    cohort,
    narrative,
    title: narrative.title,
    html,
    recipe: prompt.recipe,
    metadata: {
      genre: "discipline-position",
      // 影子检查结果落 metadata（不参与任何判定，供事后翻台账）
      membershipShadowCount: findMembershipClaimViolations(Object.values(narrative).join("\n")).length,
      ...cohortMetadata(cohort),
      dataSupply: supply.level,
      variant: prompt.recipe,
    },
    checks: {
      numberViolations: findCohortNumberViolations(html, cohort),
      // 只查模型写的叙述 —— 模板渲染的每处都带版本年，不必重复检
      membershipShadow: findMembershipClaimViolations(Object.values(narrative).join("\n")),
      fabrication: findBodyFabrication(html, toFabricationFields(opts.row)),
      // noMetricFacts 走单一判据出口，别在这里重写布尔组合（会踩扫描守卫）
      health: checkOutputHealth({
        title: narrative.title,
        body: html,
        type: "article",
        noMetricFacts: hasNoMetricFacts(supply),
      }),
      density: computeFactDensity(html, opts.row),
    },
    llm: {
      model: resp.model,
      finishReason: resp.finishReason,
      outputTokens: resp.outputTokens,
      rawLength: resp.content?.length ?? 0,
    },
  };
}
