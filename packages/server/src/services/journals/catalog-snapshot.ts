/**
 * 国内核心目录快照 —— 集合数据的单一真相源（8-10）。
 *
 * ## 为什么是它，而不是查 journals 表
 *
 * 「学科定位」体裁的主料是**刊库集合数据**（某目录某学科分类下共几本、同类刊有哪些）。
 * 这些数字有两个可能的来源，差别不是精度问题而是**可查证性**问题：
 *
 *   · 查 `journals` 表 → 只能说「本库收录的教育学 CSSCI 有 86 本」。读者无从核对，
 *     而且这个数会随抓取进度漂移 —— 今天写 86，下个月富化一批就变了。
 *   · 读 `src/data/*.json` 快照 → 「CSSCI（2023-2024 版）教育学分类下共 43 本」，
 *     读者拿官方目录能逐条数出来。数字是**冻结的、可复核的**。
 *
 * 这批 JSON 正是 `scripts/ingest-domestic-core.ts` 的入库源头，所以与 DB 同源。
 *
 * ## ⚠️ 必须用目录自带的 discipline，不要用 journals.discipline_code
 *
 * 8-10 实测，同一批刊在两套口径下的分类差别很大：
 *
 *   《武汉体育学院学报》  discipline_code=education   ← 偏宽，会被写进「教育学」
 *                        目录自带 = 体育学            ← 正确
 *   《档案学通讯》        discipline_code=education
 *                        目录自带 = 信息资源管理
 *   《中国教育学刊》      两者都是教育学               ← 一致
 *
 * 文案里出现「同为教育学 CSSCI 的还有《武汉体育学院学报》」，读者一眼看出不对。
 * 所以本模块**只暴露目录自带的分类名**，`discipline_code` 一律不参与集合统计。
 *
 * （附带：`discipline-mapping.RULES` 的 `教学` 模式命中了「宗**教学**」子串，
 *   导致宗教学刊被归成 education。本模块天然不依赖 RULES，不受该 bug 影响。）
 *
 * ## 🔴 来源链见 `src/data/CATALOG-PROVENANCE.md`
 *
 * 「每个数字可查证」这个卖点，底座是快照自己的来源链。当前状态：
 *   · `cssci-2023.json`   ✅ 8-11 对官方 PDF 全量校准（改了 23 条学科 + 3 条刊名）
 *   · 其余四份          ❌ **来源不明，未经官方校准**
 * CSSCI 校准前有 3.5% 的学科错配，没有任何理由认为其余四份更干净 ——
 * 尤其 `pku-core` 的 148 个细分类是本体裁防同质化的主要依赖，却从未与官方核对过。
 *
 * ## 数据边界（8-10 实测，写死在测试里）
 *
 *   cssci 660 / cssci-ext 249 / pku-core 1987 —— 均带 discipline，零重名、零空分类
 *   cscd     1339 —— **没有 discipline 字段**（只有 issn + cscdLevel 核心库/扩展库）
 *   sci-core 2161 —— discipline **整列为空**
 *
 * → 这两个**绝不能进任何学科统计**，只能当徽章（`BADGE_ONLY_CATALOGS`）。
 *   混进去会算出「分类=undefined 共 N 本」。
 *   8-10 实测：不加载 sci-core 的后果不是"少一个徽章"，而是 700 本 SCI 核心刊被报成
 *   `snapshot_mismatch`（"匹配不上"），让准入率这个拍板数字失真 —— 它们其实匹配得上，
 *   只是所在目录没有学科维度。诊断错了，拍板依据就错了。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normName } from "./journal-name-normalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 快照 JSON 所在目录（与 ingest-domestic-core.ts 指向同一处） */
const DATA_DIR = resolve(__dirname, "../../data");

/** 带学科分类的三个目录 —— CSCD 不在内，见文件头 */
export const DISCIPLINED_CATALOGS = ["cssci", "cssci-ext", "pku-core"] as const;
export type DisciplinedCatalog = (typeof DISCIPLINED_CATALOGS)[number];
/**
 * 无学科分类的目录 —— 只能当徽章，绝不进任何学科统计。
 * CSCD 与 SCI 核心都是这一类（8-10 实测：cscd 1339 条、sci-core 2161 条，
 * discipline 字段**全为空**）。
 */
export const BADGE_ONLY_CATALOGS = ["cscd", "sci-core"] as const;
export type BadgeOnlyCatalog = (typeof BADGE_ONLY_CATALOGS)[number];
export type CatalogTag = DisciplinedCatalog | BadgeOnlyCatalog;

export function isBadgeOnly(c: CatalogTag): c is BadgeOnlyCatalog {
  return (BADGE_ONLY_CATALOGS as readonly string[]).includes(c);
}

export interface CatalogEntry {
  /** 目录里的原始刊名 */
  name: string;
  /** 归一后的刊名（匹配用；与入库同一个 normName） */
  normName: string;
  catalog: CatalogTag;
  /** 目录版本年，如 "2023-2024"。文案里必须带它 */
  catalogYear: string;
  /** **目录自己的**学科分类名。CSCD 恒为 null */
  discipline: string | null;
  /** 仅 CSCD 有：核心库 / 扩展库 */
  cscdLevel?: string | null;
  /** 仅 CSCD 有。归一为大写去连字符，见 normIssn */
  issn?: string | null;
}

export interface CatalogSnapshot {
  /** 归一刊名 → 它命中的全部目录条目。刊名为空的条目**不进**此表 */
  entriesByNorm: Map<string, CatalogEntry[]>;
  /** 归一 ISSN → 条目（目前只有 CSCD 带 issn） */
  entriesByIssn: Map<string, CatalogEntry[]>;
  byCatalog: Map<CatalogTag, CatalogEntry[]>;
  /** `${catalog}|${discipline}` → 本数。CSCD 不参与 */
  countsByCatalogDiscipline: Map<string, number>;
  /**
   * 读取失败的目录文件。**非空 = 集合数据不完整, 调用方必须拒绝生成**,
   * 不许拿残缺的数字写文章(见 snapshotHealthy)。
   */
  loadErrors: string[];
  /**
   * 刊名与 ISSN **都**为空、无法被任何方式查到的行数。
   * 与 loadErrors 分开：这是数据瑕疵，不该拦住整篇生成（8-10 实测为 0）。
   */
  droppedRows: number;
  loadedAt: string;
}

interface RawRow {
  name?: string;
  discipline?: string | null;
  catalog?: string;
  catalogYear?: string;
  issn?: string | null;
  cscdLevel?: string | null;
}

const FILES: Record<CatalogTag, string> = {
  cssci: "cssci-2023.json",
  "cssci-ext": "cssci-ext-2023.json",
  "pku-core": "pku-core-2023.json",
  cscd: "cscd-2023.json",
  "sci-core": "sci-core-2023.json",
};

/**
 * 懒加载 + 进程内缓存。
 * ⚠️ 刻意**不在模块顶层** `const SNAPSHOT = load()` —— 顶层加载会让任何 import 本模块的
 *   脚本都先读 2.5MB JSON（同 backlog-A 的急切实例化教训）。
 */
let cache: CatalogSnapshot | null = null;

/** 仅供单测重置（线上没有调用方） */
export function __resetCatalogSnapshot(): void {
  cache = null;
}

export function getCatalogSnapshot(): CatalogSnapshot {
  if (cache) return cache;

  const entriesByNorm = new Map<string, CatalogEntry[]>();
  const byCatalog = new Map<CatalogTag, CatalogEntry[]>();
  const countsByCatalogDiscipline = new Map<string, number>();
  const entriesByIssn = new Map<string, CatalogEntry[]>();
  const loadErrors: string[] = [];
  let droppedRows = 0;
  const missingYear = new Set<CatalogTag>();

  for (const [tag, file] of Object.entries(FILES) as Array<[CatalogTag, string]>) {
    let rows: RawRow[] = [];
    try {
      rows = JSON.parse(readFileSync(resolve(DATA_DIR, file), "utf-8")) as RawRow[];
    } catch (err) {
      // 🔴 **不静默**。"读不到目录文件"与"这本刊不在目录里"在下游是同一个表现
      //   (都是 lookupByName 返回空), 于是会产出「该刊无任何核心收录」这个**错误结论** ——
      //   而它看起来和真结论一模一样。这正是红线 #14 那类"降级产物不可区分"。
      //   已知的触发场景: dist 里没有 JSON(build 漏拷)。copy-assets 已把这四个文件列进
      //   REQUIRED_ASSETS 让 build 期就炸, 这里是运行期的第二道。
      loadErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      rows = [];
    }
    const list: CatalogEntry[] = [];
    for (const r of rows) {
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const issn = normIssn(r.issn);
      // 🔴 刊名空但有 ISSN 的行**必须留下**。8-10 实测 CSCD 有 14 条这样的记录
      //   (另外三个目录零空名)。丢掉它们 = 对这 14 本刊断言「未被 CSCD 收录」——
      //   又一个与真结论无法区分的假结论。留下来按 ISSN 可查, 只是进不了刊名索引。
      if (!name && !issn) {
        droppedRows++;
        continue;
      }
      const e: CatalogEntry = {
        name,
        normName: normName(name),
        catalog: tag,
        // 🔴 不设默认值。版本年是文案里那句「截至 XX 版目录」的唯一来源,
        //   猜一个 = 写出假限定语。实测四个文件全都带此字段(cssci/ext/cscd=2023-2024,
        //   pku-core=**2023**, 三个目录版本年并不相同, 所以更不能写死一个常量)。
        //   缺字段 → 记进 loadErrors 让 snapshotHealthy 拦住整篇生成。
        catalogYear: typeof r.catalogYear === "string" && r.catalogYear ? r.catalogYear : "",
        // CSCD 无 discipline 字段 → 恒 null, 由下面的统计判断跳过
        // 徽章目录恒 null —— 不依赖"数据恰好是空的"，而是显式排除
        discipline: isBadgeOnly(tag) ? null : (typeof r.discipline === "string" && r.discipline ? r.discipline : null),
        ...(isBadgeOnly(tag) ? { cscdLevel: r.cscdLevel ?? null, issn } : {}),
      };
      if (!e.catalogYear) missingYear.add(tag);
      list.push(e);
      // 空刊名绝不进刊名索引 —— 否则 lookupByName("") 会命中一堆无关条目
      if (e.normName) {
        const arr = entriesByNorm.get(e.normName);
        if (arr) arr.push(e);
        else entriesByNorm.set(e.normName, [e]);
      }
      if (issn) {
        const arr = entriesByIssn.get(issn);
        if (arr) arr.push(e);
        else entriesByIssn.set(issn, [e]);
      }
      // 只有带分类的目录才进学科统计
      if (e.discipline) {
        const k = `${tag}|${e.discipline}`;
        countsByCatalogDiscipline.set(k, (countsByCatalogDiscipline.get(k) ?? 0) + 1);
      }
    }
    byCatalog.set(tag, list);
    // 空目录 ≠ "这本刊不在目录里", 是文件坏了。不记就变成静默 fail-open
    if (rows.length > 0 && list.length === 0) loadErrors.push(`${file}: 解析出 0 条有效记录`);
  }
  for (const tag of missingYear) loadErrors.push(`${FILES[tag]}: 存在缺 catalogYear 的记录`);

  cache = {
    entriesByNorm, entriesByIssn, byCatalog, countsByCatalogDiscipline,
    loadErrors, droppedRows, loadedAt: new Date().toISOString(),
  };
  return cache;
}

/** ISSN 归一：去连字符/空格 + 大写（末位可能是 X） */
function normIssn(v: unknown): string {
  return typeof v === "string" ? v.replace(/[-\s]/g, "").toUpperCase() : "";
}

/**
 * 按 ISSN 查目录条目。目前只有 CSCD 带 ISSN ——
 * 存在的意义就是兜住那 14 条无刊名记录，别把「查不到」讲成「没收录」。
 */
export function lookupByIssn(issn: string | null | undefined): CatalogEntry[] {
  const k = normIssn(issn);
  if (!k) return [];
  return getCatalogSnapshot().entriesByIssn.get(k) ?? [];
}

/** 按刊名查它命中了哪些目录（走 normName，与入库同口径） */
export function lookupByName(name: string): CatalogEntry[] {
  if (!name) return [];
  return getCatalogSnapshot().entriesByNorm.get(normName(name)) ?? [];
}

/** 某目录下每个学科分类各几本，按本数降序。CSCD 返回空数组（它没有分类） */
export function catalogDisciplineCounts(c: CatalogTag): Array<{ discipline: string; count: number }> {
  if (isBadgeOnly(c)) return [];
  const out: Array<{ discipline: string; count: number }> = [];
  for (const [k, count] of getCatalogSnapshot().countsByCatalogDiscipline) {
    const [cat, discipline] = k.split("|");
    if (cat === c && discipline) out.push({ discipline, count });
  }
  // 本数降序；同数按分类名排序，保证输出稳定（同一本刊两次生成给出同样的横向盘子）
  out.sort((a, b) => b.count - a.count || a.discipline.localeCompare(b.discipline));
  return out;
}

/** 某目录某分类下共几本。CSCD 或分类不存在 → 0 */
export function countInDiscipline(c: CatalogTag, discipline: string | null): number {
  if (isBadgeOnly(c) || !discipline) return 0;
  return getCatalogSnapshot().countsByCatalogDiscipline.get(`${c}|${discipline}`) ?? 0;
}

/** 某目录总本数 */
export function countInCatalog(c: CatalogTag): number {
  return getCatalogSnapshot().byCatalog.get(c)?.length ?? 0;
}

/**
 * 同目录同分类的其他刊名（不含自己）。
 *
 * 稳定排序（按归一名）+ **环形窗口偏移**：不传 offset 就是头 N 本；传了就从该位置起取 N 本。
 * 偏移的用处是让同分类的不同刊给出不同的清单（8-10 实测：都取头 8 本会让两篇文章逐字雷同），
 * 而列出来的每一本仍然真属于该分类 —— 换窗口不换真伪。
 * 不随机：同一本刊两次生成给出同样的清单，便于复核。
 */
export function siblingsInDiscipline(
  c: CatalogTag,
  discipline: string | null,
  selfNormName: string,
  limit = 8,
  offset = 0,
): string[] {
  if (isBadgeOnly(c) || !discipline) return [];
  const list = getCatalogSnapshot().byCatalog.get(c) ?? [];
  const all = list
    .filter((e) => e.discipline === discipline && e.normName !== selfNormName)
    .sort((a, b) => a.normName.localeCompare(b.normName))
    .map((e) => e.name);
  if (all.length === 0) return [];
  // 环形取窗口：同分类的不同刊给出不同的窗口，但每本刊自己的窗口是固定的
  const start = ((offset % all.length) + all.length) % all.length;
  const out: string[] = [];
  for (let i = 0; i < Math.min(limit, all.length); i++) out.push(all[(start + i) % all.length]!);
  return out;
}

/**
 * 快照是否完整可用。**任何一个目录文件读不到就返回 false** ——
 * 宁可整篇不生成, 也不能拿残缺目录算出「本刊未被任何核心目录收录」这种假结论。
 */
export function snapshotHealthy(): { ok: boolean; errors: string[] } {
  const s = getCatalogSnapshot();
  return { ok: s.loadErrors.length === 0, errors: s.loadErrors };
}

/** 目录中文标签。复用 roundup-generator 的口径，别再造第 N 份 */
export const CATALOG_LABEL: Record<CatalogTag, string> = {
  cssci: "CSSCI",
  "cssci-ext": "CSSCI 扩展版",
  "pku-core": "北大核心",
  cscd: "CSCD",
  "sci-core": "SCI 核心",
};
