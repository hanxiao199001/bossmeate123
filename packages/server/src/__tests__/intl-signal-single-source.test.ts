import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import {
  INTL_SIGNAL_FIELDS,
  INTL_SIGNAL_COLUMNS,
  hasIntlSignal,
  buildIntlSignalSql,
  jcrFullHasWosEvidence,
} from "../services/journals/intl-signal.js";
import { PARTITION_FACT_KEYS } from "../services/compliance/fabrication-criteria.js";

/**
 * 「国际指标信号读哪些列」单一真相源守卫 (7-29)。
 *
 * ## 为什么要这道扫描
 *
 * 同一个坑踩了两次:
 *   · 7-20 content-check.ts 判编造时发现 cas_partition **整列为空(0 行)**, 真正有数据的是
 *     cas_partition_new 和 jcr_full, 并把这条写进了注释。
 *   · 7-28 journal-kind.ts 新写 hasIntlSignal, **又原样挑了 impact_factor / partition /
 *     cas_partition** —— 注释在另一个文件里, 没人会去读。后果: 704 本一线国际刊判 unknown。
 *
 * 注释拦不住第三次, 所以改成测试拦。规则很简单:
 *   **除白名单外, 任何地方不许再裸读 partition / cas_partition 去回答"有没有分区"。**
 *   要判就 import intl-signal 的判据, 或从 INTL_SIGNAL_FIELDS 派生子集。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/**
 * 白名单 —— 允许出现"裸读分区列做有无判断"的地方, 每条都要写清为什么。
 * 加白名单前先问一句: 你是不是在造第四套判据?
 */
const ALLOWED = new Map<string, string>([
  ["services/journals/intl-signal.ts", "判据本身的定义处"],
  ["services/journals/journal-kind.ts", "委派给 intl-signal, 注释里提到列名属历史说明"],
  ["services/compliance/fabrication-criteria.ts", "PARTITION_FACT_KEYS 从 intl-signal 派生"],
  [
    "services/publisher/adapters/shunshi-style-template.ts",
    "hasWosData 是刻意的窄子集: 回答'够不够渲染 WoS 版块'而非'是不是国际刊'(见该函数注释)",
  ],
  ["services/crawler/trusted-facts-validator.ts", "写入侧校验值本身合不合理, 不判有无"],
]);

/** "拿分区列做有无判断"的形态: truthiness / != null / !== '' / IS NOT NULL 等 */
const BARE_PRESENCE_PATTERNS: RegExp[] = [
  // j.casPartition ? / || / && —— truthiness 判有无
  /\b(?:casPartition|partition)\b\s*(?:\?\?|\|\||&&|\?)/,
  // != null / !== null / == null 这类显式空判
  /\b(?:casPartition|partition)\b\s*[!=]==?\s*(?:null|undefined|"")/,
  // SQL 侧: cas_partition IS NOT NULL / <> ''
  /\bcas_partition\b\s*(?:IS\s+(?:NOT\s+)?NULL|<>|!=)/i,
  /\bcoalesce\(\s*(?:\w+\.)?cas_partition\b/i,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("国际指标信号: 单一真相源", () => {
  it("列清单包含四类分区证据 + IF, 且 cas_partition 不是唯一分区来源", () => {
    expect([...INTL_SIGNAL_FIELDS]).toEqual([
      "impactFactor",
      "partition",
      "casPartition",
      "casPartitionNew",
      "jcrFull",
    ]);
    // 7-28 事故的核心: 只靠这两列 = 三个信号只有一个在工作
    expect(INTL_SIGNAL_COLUMNS.casPartition.coverage2607).toBe(0);
    expect(INTL_SIGNAL_COLUMNS.casPartitionNew.coverage2607).toBeGreaterThan(1000);
    expect(INTL_SIGNAL_COLUMNS.jcrFull.coverage2607).toBeGreaterThan(1000);
  });

  it("TS 判据认得 cas_partition_new(7-28 漏的那 166 本靠它救回)", () => {
    expect(hasIntlSignal({ casPartitionNew: "3区医学" })).toBe(true);
    expect(hasIntlSignal({ casPartition: "1区" })).toBe(true);
    expect(hasIntlSignal({ impactFactor: 0 })).toBe(true); // IF=0 也算有指标(不加 >0, 那是减法)
    expect(hasIntlSignal({})).toBe(false);
    expect(hasIntlSignal({ partition: "  " })).toBe(false); // 空白串不算
  });

  it("jcr_full 要有真 WoS 证据才算, 只有 isTopJournal 不算", () => {
    // 生产实测: 4229 行非空里 123 行只带这类布尔标记(例 JAMA 那行)
    expect(jcrFullHasWosEvidence({ isTopJournal: true, isReviewJournal: false })).toBe(false);
    expect(jcrFullHasWosEvidence({ wosLevel: "SCIE" })).toBe(true);
    expect(jcrFullHasWosEvidence({ jifSubjects: [{ subject: "ONCOLOGY", zone: "Q1" }] })).toBe(true);
    expect(jcrFullHasWosEvidence({ jifSubjects: [] })).toBe(false);
    expect(jcrFullHasWosEvidence(null)).toBe(false);
    expect(hasIntlSignal({ jcrFull: { isTopJournal: true } })).toBe(false);
  });

  it("SQL 孪生体与 TS 判据读同一批列", () => {
    const sql = buildIntlSignalSql();
    for (const f of INTL_SIGNAL_FIELDS) {
      expect(sql).toContain(INTL_SIGNAL_COLUMNS[f].column);
    }
    // 生成列表达式不能带表限定; "partition" 是关键字必须加引号
    expect(sql).toContain(`"partition"`);
    // jsonb_array_length 前必须有 jsonb_typeof 守卫, 否则脏数据让整列建不出来
    expect(sql).toMatch(/jsonb_typeof\([^)]*jifSubjects'\)\s*=\s*'array'\s*AND\s*jsonb_array_length/);
  });

  it("编造判据的分区列表从同一份清单派生(少的那个是 impactFactor, 归 IF_FACT_KEYS)", () => {
    expect([...PARTITION_FACT_KEYS].sort()).toEqual(
      INTL_SIGNAL_FIELDS.filter((k) => k !== "impactFactor").slice().sort(),
    );
  });
});

describe("扫描: 不许再有第四套分区判据", () => {
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      const t = text.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (BARE_PRESENCE_PATTERNS.some((re) => re.test(text))) {
        offenders.push({ file: rel, line: i + 1, text: t.slice(0, 110) });
      }
    });
  }

  it("非白名单处不许裸读 partition / cas_partition 判'有无分区'", () => {
    expect(
      offenders,
      "发现新的分区判据(请改用 journals/intl-signal.ts 的判据, 或从 INTL_SIGNAL_FIELDS 派生子集;\n" +
        "确有正当理由取窄子集的, 加进本测试的 ALLOWED 并写明为什么):\n" +
        offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
    ).toEqual([]);
  });

  it("白名单每条都有理由(防止有人只加路径不写为什么)", () => {
    for (const [path, reason] of ALLOWED) {
      expect(reason.length, `${path} 的白名单理由太短`).toBeGreaterThan(8);
    }
  });
});
