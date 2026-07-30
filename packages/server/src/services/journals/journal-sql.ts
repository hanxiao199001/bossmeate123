/**
 * journals 表的 SQL 条件**单一真相源** (7-28)。
 *
 * 五类条件都放这里, 谁也别再在调用点手写:
 *   ① 定位过滤   `journalScopeCondition(scope)`  —— 读生成列 journal_kind(见 journal-kind.ts)
 *   ② 分体系可信 `verifiedJournalCondition()`    —— 国内刊按目录成员资格, 国际刊按 conf>=70
 *   ③ 租户口径   `journalVisibleTo` / `journalOwnedBy`
 *   ④ 学科口径   `journalDisciplineIs` / `journalDisciplineMatches` —— 读生成列 discipline_code
 *   ⑤ 候选池组   `journalPoolCriteria()`         —— 选刊器分层与"还剩几本"盘点的同一份 WHERE(7-30)
 *
 * ## ④ 为什么单独抽 helper(同一个病已经犯了 11 次)
 * `journals.discipline` 是**原始列**: 国内刊存北大核心/CSCD 的中文分类名("临床医学"),
 * 国际刊存英文码("medicine")。`discipline ILIKE '%medicine%'` / `discipline = 'medicine'`
 * 对 2242 本国内刊**永远匹配不上** —— 不报错, 只是这些刊在学科槽位里彻底消失。
 * `journals.discipline_code` 是**生成列**(migration 026, 表达式由 discipline-mapping.ts 的
 * RULES 生成, DB 保证不漂), 两种原始值都归一到同一套 13 码 + generic。
 * **热路径一律读生成列**; 原始中文分类名只许用于「展示给人看」。
 * 回归锁: `__tests__/journals-discipline-code-scan.test.ts` 全量扫 src/**\/*.ts。
 *
 * ## ③ 为什么单独抽 helper(同一个病已经犯了 13 次)
 * 线上 8743 本期刊的 `tenant_id` 是 **NULL** —— 它们是全局共享参考数据, 只有租户自建刊才带
 * tenant_id。SQL 里 `NULL = 'uuid'` 求值为 NULL(既不真也不假), 所以 `eq(journals.tenantId, x)`
 * 会把**整个共享池排除**, 端点/服务对任何租户都静默返回 0 条 —— 不报错、不告警, 只是"什么都没有"。
 * 7-25 修了 routes/journals.ts 的 4 处, 但同一个病在另外 9 处读路径还活着(选题工坊恒 404、
 * 视频 skill 静默不产、热点匹配恒空、封面预取恒空 …)。
 *
 * **铁律: 读放宽(共享池 + 自有刊), 写严格(只认自己的刊)。**
 * 回归锁: `__tests__/journals-tenant-scope-scan.test.ts` 全量扫 src/**\/*.ts, 白名单外出现裸
 * `eq(journals.tenantId, …)` 即红。
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { journals } from "../../models/schema.js";
import {
  DOMESTIC_KINDS,
  INTERNATIONAL_KINDS,
  buildVerifiedJournalSql,
  type JournalKind,
} from "./journal-kind.js";
import {
  GENERIC_DISCIPLINE_CODE,
  resolveDisciplineCode,
  toDisciplineCode,
} from "../recommendation/discipline-mapping.js";

/** join 查询里 journals 的列必须带表名消歧(journal_usage 也有 tenant_id 等同名列) */
const P = "journals.";

export type JournalScope = "domestic" | "international" | "both";

/**
 * 定位过滤条件; both/未知 → null(不过滤)。
 *
 * 7-28 改读生成列 `journal_kind`(原先是"catalogs 非空 / catalogs 空且有 IF"两条互斥启发式,
 * 中间夹着一条**定义裂缝**: 只有 cscd_level/pku_core_level 的刊两边都不算, 对任何 scope 不可见)。
 * 语义变化只有一处、且只是加法: 裂缝刊(kind='cn')现在国内槽位能看见了。
 * 骑墙刊(kind='both')仍**只**进国内槽位, 不进国外槽位 —— 中华医学杂志不许被当成国外刊。
 */
export function journalScopeCondition(scope?: string | null): SQL | null {
  if (scope === "domestic") return inArray(journals.journalKind, DOMESTIC_KINDS as JournalKind[]);
  if (scope === "international") return inArray(journals.journalKind, INTERNATIONAL_KINDS as JournalKind[]);
  return null;
}

/**
 * 分体系可信门槛(与 `services/journals/verification.ts` 的 `isVerifiedJournal()` 同一份规则):
 *   - `cn` 刊:      目录成员资格(北大核心/CSCD/CSSCI/CSTPCD) 或 (CN刊号 + 主办方), 排除 ai_fabricated
 *   - 其余(intl/both/unknown): confidence >= 70 且非 legacy_unknown(现状不变)
 */
export function verifiedJournalCondition(): SQL {
  return sql.raw(buildVerifiedJournalSql(P));
}

/** 读口径: 共享池(tenant_id IS NULL) + 本租户自建刊。tenantId 缺失时只给共享池。 */
export function journalVisibleTo(tenantId: string | null | undefined): SQL {
  if (!tenantId) return isNull(journals.tenantId);
  return or(isNull(journals.tenantId), eq(journals.tenantId, tenantId))!;
}

/**
 * 学科口径 · 精确分桶: `discipline_code = toDisciplineCode(raw)`。
 *
 * 用于**筛选器 / 统计分桶**这类"选了 medicine 就只要 medicine"的语义 —— 它与
 * `GET /journals/meta/disciplines` 的 `GROUP BY discipline_code` 是同一口径, 所以下拉框里
 * 写的"medicine 812 本"点进去必然就是 812 本(原先下拉按原始中文名分组、列表按原始名全等过滤,
 * 两边桶都碎成几百个中文分类名, 永远拼不出"medicine 还剩几本")。
 *
 * raw 允许是学科码、中文分类名、或 "generic"(下拉框里综合刊那一桶) —— 一律过 toDisciplineCode
 * 归一, 归不出来的落 generic 桶(与生成列的兜底行为一致)。
 */
export function journalDisciplineIs(raw: string): SQL {
  return eq(journals.disciplineCode, toDisciplineCode(raw));
}

/**
 * 学科口径 · 槽位匹配: `discipline_code = X (OR = generic)`。
 *
 * 用于**选刊/配刊**这类"给我这个学科的刊"的语义。与 daily-cron 的 `pickScopedFreshJournal`
 * (`code = X OR code = generic`)同口径 —— 综合刊/学报在任何学科槽位都算命中, 因为它们本就通吃。
 *
 * **返回 null = 调用方不要加学科条件**(不是"匹配不到"):
 *   raw 是自由文本(用户主题词 / 爬来的热词)时经常归一不出具体学科, 这时若照 toDisciplineCode
 *   的 generic 兜底去查, 就会把全部综合刊捞出来 —— 比不加条件还噪。见 resolveDisciplineCode 的注释。
 *
 * @param includeGeneric 默认 true。传 false 表示"只要对口刊, 综合刊不算"。
 */
export function journalDisciplineMatches(
  raw: string | null | undefined,
  opts: { includeGeneric?: boolean } = {},
): SQL | null {
  const code = resolveDisciplineCode(raw);
  if (!code) return null;
  if (opts.includeGeneric === false) return eq(journals.disciplineCode, code);
  return or(
    eq(journals.disciplineCode, code),
    eq(journals.disciplineCode, GENERIC_DISCIPLINE_CODE),
  )!;
}

/**
 * 写口径: **只认本租户自建刊**。共享池的富化/修改走 `pnpm journals:reenrich` 脚本或
 * PATCH /journals/:id(owner/admin 角色闸在前的显式授权例外), 不许从别的写路径放宽。
 */
export function journalOwnedBy(tenantId: string): SQL {
  return eq(journals.tenantId, tenantId);
}

// ──────────────────────────────────────────────────────────────────────────
// ⑤ 候选池条件组(7-30 期刊池盘点) —— 选刊器与盘点服务的**同一份 WHERE**
// ──────────────────────────────────────────────────────────────────────────
/**
 * ## 为什么要把这几个片段抽出来
 *
 * 7-30 做"哪个学科的刊快用完了"的盘点时, 面前有两条路: 照着选刊器再写一遍 WHERE, 或者共用。
 * 这个项目已经因为选前者犯过 5 次同类错(病史见 `intl-signal.ts` 文件头) —— 而这次的失败模式
 * 尤其阴: 盘点算出来的"余量"若和选刊器实际能选到的不是同一批刊, **报表会说还有 20 本、
 * 选刊器却一本都选不出来**, 比没有盘点更糟(它让人相信了一个假数)。
 *
 * 所以口径只有一份, 在这里。选刊器 `daily-cron.pickScopedFreshJournal` 与
 * `journals/pool-inventory.ts` 都从 `journalPoolCriteria()` 取, 谁也不许自己拼。
 * 回归锁: `__tests__/journal-pool-criteria-single-source.test.ts`。
 *
 * ## 刻意不含的两条
 *   · **不含 tenant 过滤**: 期刊表是全局共享参考数据, 选刊器只拿 tenantId 做冷却/LRU,
 *     不拿它过滤期刊表(见 routes/journals.ts:428 的注释)。盘点若加了 `journalVisibleTo`,
 *     算出来的池子会比选刊器实际的小 —— 又是一个假数。
 *   · **不含 LRU 排序**: 那是"选哪一本"的事, 盘点只问"还有几本"。
 */

/** 冷却天数**单一真相源**(env JOURNAL_REUSE_COOLDOWN_DAYS, 默认 15)。
 *  7-30 前这个数在 daily-cron / pick-degrade / roundup-generator 各读了一遍 env, 三份默认值。 */
export function journalCooldownDays(): number {
  const n = Number(process.env.JOURNAL_REUSE_COOLDOWN_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
}

/**
 * 在架条件: `status='active'` 且非 ai_fabricated。
 * 6-19 数据质量护栏: ai_fabricated 是 LLM 编造的影子刊(IF/分区/录用率全是假的), 绝不进生成。
 * 只排这一类 —— 正经的低可信/目录刊(国内核心常 confidence 为空)仍保留, 不误杀。
 */
export function journalActiveCondition(): SQL {
  return and(
    eq(journals.status, "active"),
    sql`(${journals.dataSource} IS DISTINCT FROM 'ai_fabricated')`,
  )!;
}

/** 新鲜(未在冷却期内被该租户用过) —— 15 天不重复这条产品承诺的 SQL 形态。 */
export function journalFreshForTenant(tenantId: string, cooldownDays = journalCooldownDays()): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM journal_usage ju WHERE ju.journal_id = ${journals.id} AND ju.tenant_id = ${tenantId} AND ju.used_at > NOW() - make_interval(days => ${cooldownDays}))`;
}

/**
 * 槽位学科口径 · 精确: `discipline_code = code`。
 *
 * ⚠️ 与上面的 `journalDisciplineIs(raw)` 的区别: 这里的入参是**已归一的学科槽位码**
 * (排产配额/ALL_DISC_CODES 给出的 13 码之一), 不再过 toDisciplineCode ——
 * 选刊器一直是这个行为, 盘点必须一模一样, 中间多一次归一就可能两边分桶不同。
 */
export function journalDisciplineSlotIs(code: string): SQL {
  return sql`(${journals.disciplineCode} = ${code})`;
}

/** 槽位学科口径 · 含综合刊: `= code OR = generic`(综合刊/学报在任何学科槽位都算命中)。 */
export function journalDisciplineSlotOrGeneric(code: string): SQL {
  return sql`(${journals.disciplineCode} = ${code} OR ${journals.disciplineCode} = ${GENERIC_DISCIPLINE_CODE})`;
}

/** 选刊器分层用到的全部条件片段(命名与 pickScopedFreshJournal 的局部变量一一对应)。 */
export interface JournalPoolCriteria {
  /** 在架 + 非编造 */
  active: SQL;
  /** 分体系可信门槛 */
  verified: SQL;
  /** 定位过滤; both/未知 → null(不过滤) */
  scope: SQL | null;
  /** 仅目标学科对口刊 */
  discExact: SQL;
  /** 目标学科 + 综合刊 */
  discOrGeneric: SQL;
  /** 冷却期内未被该租户用过 */
  fresh: SQL;
  /** 本次口径用的冷却天数(盘点估算余量时要用同一个数) */
  cooldownDays: number;
}

/**
 * 选刊/盘点共用的候选池条件组。
 *
 * @param tenantId    冷却口径的租户(期刊表本身不按租户过滤, 见上方说明)
 * @param scope       "domestic" | "international" | "both"
 * @param discipline  已归一的学科槽位码
 */
export function journalPoolCriteria(opts: {
  tenantId: string;
  scope?: string | null;
  discipline: string;
  cooldownDays?: number;
}): JournalPoolCriteria {
  const cooldownDays = opts.cooldownDays ?? journalCooldownDays();
  return {
    active: journalActiveCondition(),
    verified: verifiedJournalCondition(),
    scope: journalScopeCondition(opts.scope),
    discExact: journalDisciplineSlotIs(opts.discipline),
    discOrGeneric: journalDisciplineSlotOrGeneric(opts.discipline),
    fresh: journalFreshForTenant(opts.tenantId, cooldownDays),
    cooldownDays,
  };
}
