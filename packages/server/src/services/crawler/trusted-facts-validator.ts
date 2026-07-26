/**
 * 7-25 事故后加固: enrichment 回写前的**确定性合理性校验**(纯函数, 零 IO, 零依赖)。
 *
 * ══ 为什么要有这个文件 ══
 * 7-25 试启用 backlog-C 的回写(persistTrustedJournalFacts)时发现: 上游 LetPub 的页面结构
 * 已经变了, journal_scraper.py 的选择器全部错位 —— 抓回来的是
 *     impactFactor = 2026            (抓到了页面上的年份)
 *     name         = "按研究方向查看:" (抓到了侧边导航文案)
 * 而回写会把这些值**永久钉进 journals 表**。一旦入库, 三道防编造闸(findBodyFabrication /
 * checkTitleDataConsistency / quality-check-v2 的 journalFacts)全部失效 —— 因为它们都以 DB
 * 为唯一真相源, DB 和喂给 LLM 的提示词"一致地错", 校验器反而给假数据背书。结果就是那篇
 * 《2026 逆天影响因子》。污染已回滚。
 *
 * 教训: **回写把"一次抓取失败"升级成了"永久数据污染"**。抓取失败是常态(上游随时改版), 所以
 * 写入侧必须有一道**不依赖上游、不依赖 LLM、不依赖任何网络**的确定性闸门。就是本文件。
 *
 * ══ 两条设计铁律 ══
 * ① **整条拒写, 绝不部分写入**。解析漂移是"整页错位", 不是"某一格脏"。若 IF 抓成年份, 同一次
 *    抓取里的分区/录用率极可能也来自错误的单元格 —— 只是恰好长得像合法值。部分写入 = 把看起来
 *    合法的错值放进 DB, 比整条拒写危险得多。
 * ② **宁可拒真, 不可放假**。拒写的代价 = 这一轮生成的校验器少一份数据(回到 backlog-C 之前的
 *    状态, 已知可承受); 放假的代价 = 永久污染 + 三道闸失效(已实际发生过)。两者不对等。
 */

// ============ 判据常量(集中在此, 便于日后调参与审计) ============

/**
 * 影响因子的合理上界。
 *
 * 定值 300 的理由(这是本文件最需要解释的一条判据):
 *   - **真实世界的天花板**: JCR 里 IF 长期高于 300 的只有 CA-A Cancer Journal for Clinicians
 *     一本(历史峰值 500+)。而回写是"只填空"的 —— 这种顶刊在 journals 表里不可能是空值, 也不
 *     可能是 backlog-C 要救的"骑墙刊", 所以为它误拒的代价是 0。
 *   - **一刀切死年份区间**: 上界压到 300, 就把整个 1900-2100 的年份取值区间挡在门外。事故里的
 *     2026 首先在这里就被拒。选 300 而不是 2000 出头的宽松值, 正是为了让"年份型污染"物理上
 *     进不来, 而不是靠模式识别去猜。
 *   - **与既有口径同源**: routes/journals.ts 的 admin 编辑白名单 zod 是 max(200), ifHistory
 *     也是 max(200)。300 留一档余量但仍在同一量级, 不制造第二套标准。
 */
export const IF_MAX = 300;

/** 年份型数值探针区间。落在这里且为整数 = 高度可疑(见 isYearLike)。 */
export const YEAR_LIKE_MIN = 1900;
export const YEAR_LIKE_MAX = 2100;

/** 审稿周期换算成天以后的合理区间(不含端点)。0 天 = 没解析出东西; ≥1000 天(≈2.7 年)不是审稿周期。 */
export const REVIEW_CYCLE_MIN_DAYS = 0;
export const REVIEW_CYCLE_MAX_DAYS = 1000;

/** DB 列宽约束(schema.ts): partition varchar(20) / cas_partition varchar(50) / review_cycle varchar(50)。 */
const MAX_LEN = { partition: 20, casPartition: 50, reviewCycle: 50, sourceName: 120 } as const;

// ============ 导航文案 / 解析漂移的文本特征 ============

/**
 * "抓到的不是数据, 是页面结构本身"的文本特征。
 * 事故实例 "按研究方向查看:" 同时命中 NAV_PHRASES 第 1 条和 TRAILING_COLON 两条。
 */
const NAV_PHRASES: RegExp[] = [
  /按[^，,。;；]{0,10}?(查看|检索|搜索|浏览|分类|筛选|排序)/, // 按研究方向查看 / 按学科分类浏览
  /更多|点击|详见|详情/,
  /登录|注册|收藏|分享/,
  /首页|上一页|下一页|末页|返回(顶部)?|导航/,
  /查看全部|全部期刊|期刊(导航|检索|大全)|排行榜/,
  /^(请选择|请输入|全部|不限|暂无|加载中|null|undefined|N\/?A)$/i,
  /<[a-z/!]/i,        // 残留 HTML 标签
  /&(nbsp|amp|lt|gt|quot);/i, // 残留 HTML 实体
];

/** 以冒号/箭头结尾 = 这是个"标签", 不是"值"。 */
const TRAILING_LABEL = /[:：>》»、|]\s*$/;

/** 竖线/换行/制表 = 一整块页面文本被当成单字段抓下来了。 */
const BLOCK_TEXT = /[\n\r\t]|(\|.*\|)/;

/**
 * 判定一个字符串是否"看起来是页面文案而不是字段值"。
 * 独立导出便于其它抓取链路复用(letpub-detail-scraper / 列表爬同样有漂移风险)。
 */
export function looksLikeNavText(raw: string, maxLen = 120): boolean {
  const s = String(raw).trim();
  if (!s) return true;
  if (s.length > maxLen) return true;      // 异常长 = 抓到整段说明文字
  if (TRAILING_LABEL.test(s)) return true;
  if (BLOCK_TEXT.test(s)) return true;
  return NAV_PHRASES.some((re) => re.test(s));
}

/**
 * 年份型数值探针。
 *
 * 判据 = **整数** 且落在 [1900, 2100]。两个条件缺一不可, 关键在"整数"这一半:
 *   - 真实 IF 几乎总是带小数(JCR 公布到 1-3 位): 2.026 / 4.3 / 12.5 → Number.isInteger 为 false,
 *     一律不会被误判。用户担心的 "IF 可能是 2.026 这类"正是靠这一条区分开的。
 *   - 极少数期刊 IF 恰好是整数(如 32.0), 但整数 IF 要落进 [1900,2100] 才会被这条拦, 而那早就
 *     被 IF_MAX=300 拒掉了 —— 两条判据的误伤区为空集。
 *
 * 所以本探针对 IF 而言是**冗余的第二道锁**: 它的价值不在多拦一个值, 而在于
 *   ① 报错信息能直接说"疑似抓到了年份"(运维一眼定位到选择器错位, 而不是"数值超范围");
 *   ② 将来若有人调高 IF_MAX(或把它用到别的数值字段上), 年份仍然拦得住。
 */
export function isYearLike(v: number): boolean {
  return Number.isInteger(v) && v >= YEAR_LIKE_MIN && v <= YEAR_LIKE_MAX;
}

/**
 * 把 "3个月" / "4-8周" / "平均 3.0 个月" / "30 days" 折算成天数(取区间上界, 保守)。
 * 返回 null = **没找到任何带时间单位的数字**(比如抓到了裸的 "2026")。
 */
export function parseReviewCycleDays(raw: string): number | null {
  const s = String(raw).trim();
  const re = /(\d+(?:\.\d+)?)\s*(?:个)?\s*(天|日|周|月|年|days?|weeks?|wks?|months?|mos?|years?|yrs?)/gi;
  const FACTOR: Array<[RegExp, number]> = [
    [/^(天|日|days?)$/i, 1],
    [/^(周|weeks?|wks?)$/i, 7],
    [/^(月|months?|mos?)$/i, 30],
    [/^(年|years?|yrs?)$/i, 365],
  ];
  let best: number | null = null;
  for (const m of s.matchAll(re)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    const unit = m[2];
    const hit = FACTOR.find(([re2]) => re2.test(unit));
    if (!hit) continue;
    const days = n * hit[1];
    best = best === null ? days : Math.max(best, days);
  }
  return best;
}

// ============ 校验结果类型 ============

/** 拒写规则码 —— 进日志/ops_incidents 的 detail, 便于按码聚合看是哪类漂移。 */
export type RejectRule =
  | "not_a_number"      // 该是数字却不是有限数
  | "out_of_range"      // 数值越界
  | "year_like"         // 疑似抓到年份
  | "bad_format"        // 字符串不符合预期格式(分区等)
  | "nav_text"          // 抓到了页面导航文案 / 整块文本
  | "too_long";         // 超过 DB 列宽

export interface TrustedFactRejection {
  field: string;
  value: unknown;
  rule: RejectRule;
  /** 中文说明, 直接进 logger.error / 简报 */
  detail: string;
}

export interface TrustedFactsValidation {
  /** true = 全部候选字段合理, 允许整条写入 */
  ok: boolean;
  /** 本次实际参与校验的字段(未抓到的字段不算) */
  checked: string[];
  rejected: TrustedFactRejection[];
  /**
   * 解析漂移信号(比"单条脏数据"严重得多, 说明上游改版/选择器错位):
   *   - 同一批里 ≥2 个字段异常, 或
   *   - 任一字段命中 year_like / nav_text(这两类是结构性错位的直接指纹)
   * 命中时应升级告警(ops_incidents severity=error + 简报置顶), 而不是当噪音吞掉。
   */
  drift: boolean;
  /** 人话摘要, ok 时为空串 */
  reason: string;
}

/** 入参: 只取会被回写/会暴露解析健康度的字段, 其余一律忽略。 */
export interface TrustedFactsInput {
  impactFactor?: number | null;
  partition?: string | null;
  casPartition?: string | null;
  acceptanceRate?: number | null;
  reviewCycle?: string | null;
  /**
   * **探针字段, 永不入库**。抓取源给出的刊名(ScraplingResult.name)。
   * 它本身不在回写白名单里, 但它是解析是否错位最灵敏的指示器 —— 7-25 事故里
   * name="按研究方向查看:" 比 IF=2026 更早、更明确地说明"整页选择器全废了"。
   */
  sourceName?: string | null;
}

// ============ 主函数 ============

const isPresent = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

/**
 * 回写前的确定性合理性校验。**任何一个字段不合理 → ok=false → 调用方整条拒写**。
 *
 * 不做的事(刻意):
 *   - 不查库、不联网、不问 LLM。校验器一旦依赖外部, 上游挂了它也跟着挂, 就守不住门。
 *   - 不做"修正"/"归一化"。抓错了就是抓错了, 猜着改只会制造更难查的脏数据。
 */
export function validateTrustedFacts(facts: TrustedFactsInput | null | undefined): TrustedFactsValidation {
  const checked: string[] = [];
  const rejected: TrustedFactRejection[] = [];
  const f = facts ?? {};

  const reject = (field: string, value: unknown, rule: RejectRule, detail: string) =>
    rejected.push({ field, value, rule, detail });

  // ── impactFactor: 0 < IF < 300, 且不得是年份型整数 ──────────────────────────
  if (isPresent(f.impactFactor)) {
    checked.push("impactFactor");
    const v = Number(f.impactFactor);
    if (!Number.isFinite(v)) {
      reject("impactFactor", f.impactFactor, "not_a_number", "影响因子不是有限数值");
    } else if (isYearLike(v)) {
      // 顺序重要: 先报"疑似年份"(信息量更大), 再谈越界
      reject("impactFactor", v, "year_like", `影响因子 ${v} 是 ${YEAR_LIKE_MIN}-${YEAR_LIKE_MAX} 的整数, 疑似抓到了页面上的年份而非 IF`);
    } else if (v <= 0 || v >= IF_MAX) {
      reject("impactFactor", v, "out_of_range", `影响因子 ${v} 超出合理区间 (0, ${IF_MAX})`);
    }
  }

  // ── partition: 只认 Q1-Q4 或 1区-4区 ────────────────────────────────────────
  // (带学科前缀的 "医学2区" 属于 casPartition, 出现在 partition 列即为串列)
  if (isPresent(f.partition)) {
    checked.push("partition");
    const s = String(f.partition).trim();
    if (looksLikeNavText(s, MAX_LEN.partition)) {
      reject("partition", f.partition, s.length > MAX_LEN.partition ? "too_long" : "nav_text", `分区值 "${s.slice(0, 40)}" 像页面文案不像分区`);
    } else if (!/^(Q[1-4]|[1-4]\s*区)$/i.test(s)) {
      reject("partition", f.partition, "bad_format", `分区值 "${s}" 不是 Q1-Q4 / 1-4区`);
    }
  }

  // ── casPartition: 中科院大类分区, 形如 "医学2区" / "地球科学2区" / "2区TOP" ───
  if (isPresent(f.casPartition)) {
    checked.push("casPartition");
    const s = String(f.casPartition).trim();
    if (s.length > MAX_LEN.casPartition) {
      reject("casPartition", f.casPartition, "too_long", `中科院分区超长(${s.length} > ${MAX_LEN.casPartition})`);
    } else if (looksLikeNavText(s, MAX_LEN.casPartition)) {
      reject("casPartition", f.casPartition, "nav_text", `中科院分区 "${s.slice(0, 40)}" 像页面文案`);
    } else if (!/^[一-龥A-Za-z·、\s]{0,24}[1-4]\s*区(\s*TOP)?$/i.test(s)) {
      reject("casPartition", f.casPartition, "bad_format", `中科院分区 "${s}" 不符合 "[学科]N区[TOP]" 格式`);
    }
  }

  // ── acceptanceRate: DB 口径是 0-1 比值(schema: real, 注释 "0-1 ratio") ───────
  //    py 侧已做 `rate/100 if rate>1` 归一化, 所以到这里还 >1 的必是解析出错。
  if (isPresent(f.acceptanceRate)) {
    checked.push("acceptanceRate");
    const v = Number(f.acceptanceRate);
    if (!Number.isFinite(v)) {
      reject("acceptanceRate", f.acceptanceRate, "not_a_number", "录用率不是有限数值");
    } else if (isYearLike(v)) {
      reject("acceptanceRate", v, "year_like", `录用率 ${v} 疑似年份`);
    } else if (v < 0 || v > 1) {
      reject("acceptanceRate", v, "out_of_range", `录用率 ${v} 超出 0-1 比值区间(本库存比值不存百分数)`);
    }
  }

  // ── reviewCycle: 字符串, 必须能折算出 (0, 1000) 天 ──────────────────────────
  if (isPresent(f.reviewCycle)) {
    checked.push("reviewCycle");
    const s = String(f.reviewCycle).trim();
    if (s.length > MAX_LEN.reviewCycle) {
      reject("reviewCycle", f.reviewCycle, "too_long", `审稿周期超长(${s.length} > ${MAX_LEN.reviewCycle})`);
    } else if (looksLikeNavText(s, MAX_LEN.reviewCycle)) {
      reject("reviewCycle", f.reviewCycle, "nav_text", `审稿周期 "${s.slice(0, 40)}" 像页面文案`);
    } else {
      const days = parseReviewCycleDays(s);
      if (days === null) {
        reject("reviewCycle", f.reviewCycle, "bad_format", `审稿周期 "${s}" 里没有带时间单位的数字(裸年份 "2026" 会走到这条)`);
      } else if (days <= REVIEW_CYCLE_MIN_DAYS || days >= REVIEW_CYCLE_MAX_DAYS) {
        reject("reviewCycle", f.reviewCycle, "out_of_range", `审稿周期折合 ${days} 天, 超出 (${REVIEW_CYCLE_MIN_DAYS}, ${REVIEW_CYCLE_MAX_DAYS}) 天`);
      }
    }
  }

  // ── sourceName: 探针。它不入库, 但它一脏就说明整页选择器错位 → 整条拒写 ──────
  if (isPresent(f.sourceName)) {
    checked.push("sourceName");
    const s = String(f.sourceName).trim();
    if (looksLikeNavText(s, MAX_LEN.sourceName) || s.length < 2) {
      reject("sourceName", f.sourceName, "nav_text", `抓取源刊名 "${s.slice(0, 40)}" 是页面文案/导航 —— 上游解析已失效, 本批数据全部不可信`);
    }
  }

  const drift =
    rejected.length >= 2 ||
    rejected.some((r) => r.rule === "year_like" || r.rule === "nav_text");

  const reason = rejected.length === 0
    ? ""
    : `${drift ? "疑似上游解析漂移" : "字段值不合理"}: ` +
      rejected.map((r) => `${r.field}=${JSON.stringify(r.value)}(${r.rule})`).join("; ");

  return { ok: rejected.length === 0, checked, rejected, drift, reason };
}
