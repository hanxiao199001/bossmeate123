/**
 * 从 CSSCI 官方目录 PDF 生成 `src/data/cssci-2023.json`（8-11）。
 *
 * ## 为什么要有这个脚本，而不是手工修数据
 *
 * 8-10「学科定位」体裁的样例里，同类刊清单混进了《甘肃行政学院学报》。
 * 顺藤查下去发现快照的 `discipline` 字段与官方表**有 23 条不一致**（3.5%）。
 * 当时是靠「同类成员像不像」「北大核心怎么标」这类**旁证**逐条裁的 ——
 * 旁证能提供线索，但裁决不了「官方到底怎么分」这个外部事实。
 * 唯一的裁决者是官方表本身。所以流程改成：**下载官方表 → 全量机器 diff → 整表重建**。
 *
 * 这个体裁的卖点是「每个数字读者能拿官方目录逐条数出来」。
 * 那么快照自己必须有一条可追溯的来源链，否则卖点没有底座。
 *
 * ## 完整复现步骤（三步，都在这里，别散落到别处）
 *
 * ```bash
 * # ① 下载官方 PDF（来源见 src/data/CATALOG-PROVENANCE.md）
 * curl -sSL -o /tmp/cssci-official.pdf \
 *   "https://statics.scnu.edu.cn/pics/lib/2025/1031/1761900032548492.pdf"
 *
 * # ② 转纯文本。-layout 必须带，否则三列会粘连
 * pdftotext -layout /tmp/cssci-official.pdf /tmp/cssci-official.txt
 *
 * # ③ 解析成 JSON（本脚本）。--check 只比对不写盘
 * node scripts/parse-cssci-official.mjs /tmp/cssci-official.txt --check
 * node scripts/parse-cssci-official.mjs /tmp/cssci-official.txt
 * ```
 *
 * ## 自检（解析 PDF 最容易静默错，所以下面每一条都会硬失败）
 *
 *   · 行数必须 = 660
 *   · 序号必须是 1..660 的完整连续序列（缺一个就说明有行没被正则吃到）
 *   · 刊名、学科名都不得为空
 *   · 归一后刊名不得重复
 *
 * 任一条不满足就退出并报错 —— 宁可不生成，也不要生成一份"看起来像样"的表。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../src/data/cssci-2023.json");
const EXPECTED_ROWS = 660;
const CATALOG_YEAR = "2023-2024";

/** `序号␠␠期刊名称␠␠学科名称`。列之间是 2 个以上空格，刊名内部可含单空格与括号 */
const ROW = /^\s*(\d{1,3})\s{2,}(\S.*?)\s{2,}(\S+)\s*$/;

const txtPath = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!txtPath) {
  console.error("用法: node scripts/parse-cssci-official.mjs <pdftotext 输出的 .txt> [--check]");
  process.exit(1);
}

const rows = [];
for (const line of readFileSync(txtPath, "utf-8").split("\n")) {
  const m = ROW.exec(line);
  if (!m) continue;
  rows.push({ idx: Number(m[1]), name: m[2].trim(), discipline: m[3].trim() });
}

// ── 自检：任一条不过就退出，绝不写一份残缺的表
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};
if (rows.length !== EXPECTED_ROWS) fail(`解析出 ${rows.length} 行，应为 ${EXPECTED_ROWS} 行（PDF 版式变了？）`);
const seq = rows.map((r) => r.idx);
const missing = [];
for (let i = 1; i <= EXPECTED_ROWS; i++) if (!seq.includes(i)) missing.push(i);
if (missing.length > 0) fail(`序号缺失 ${missing.length} 个: ${missing.slice(0, 20).join(",")}`);
if (rows.some((r) => !r.name || !r.discipline)) fail("存在空刊名或空学科名");

// 归一口径必须与线上一致 —— 这里内联一份最小实现，与 journal-name-normalize.ts 同规则。
// （本脚本是 .mjs 构建期工具，不引 TS 源码；两边若分叉，下面的重名自检会先炸。）
const norm = (name) =>
  name
    .replace(/[（(]\s*改名为[：:][^)）]*[)）]/g, "")
    .replace(/\[\s*改名为[^\]]*\]/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/，/g, ",")
    .replace(/•/g, "·")
    .replace(/\s+/g, "")
    .replace(/^[《\s]+|[》\s]+$/g, "")
    .replace(/\.([一-龥A-Za-z0-9]+版)\)?$/, "($1)")
    .replace(/\.(?=[一-龥])/g, "·");
const seen = new Map();
for (const r of rows) {
  const k = norm(r.name);
  if (seen.has(k)) fail(`归一后重名: 「${r.name}」与「${seen.get(k)}」都归一成「${k}」`);
  seen.set(k, r.name);
}

const out = rows
  .sort((a, b) => a.idx - b.idx)
  .map((r) => ({
    name: r.name,
    discipline: r.discipline,
    disciplineCode: null,
    catalog: "cssci",
    catalogYear: CATALOG_YEAR,
  }));

// ── 与现有快照对比，把差异打出来（改数据这件事必须看得见）
let old = [];
try {
  old = JSON.parse(readFileSync(OUT, "utf-8"));
} catch {
  console.log("（现有快照读不到，视为首次生成）");
}
if (old.length > 0) {
  const O = new Map(out.map((r) => [norm(r.name), r]));
  const S = new Map(old.map((r) => [norm(r.name), r]));
  const onlyOfficial = [...O.keys()].filter((k) => !S.has(k));
  const onlySnapshot = [...S.keys()].filter((k) => !O.has(k));
  const mismatch = [...O.keys()].filter((k) => S.has(k) && S.get(k).discipline !== O.get(k).discipline);
  console.log(`\n与现有快照比对：`);
  console.log(`  官方有、快照无 : ${onlyOfficial.length}`);
  onlyOfficial.forEach((k) => console.log(`      + ${O.get(k).name}  [${O.get(k).discipline}]`));
  console.log(`  快照有、官方无 : ${onlySnapshot.length}`);
  onlySnapshot.forEach((k) => console.log(`      - ${S.get(k).name}  [${S.get(k).discipline}]`));
  console.log(`  学科不一致     : ${mismatch.length}`);
  mismatch.forEach((k) => console.log(`      ~ ${O.get(k).name}  快照=${S.get(k).discipline} → 官方=${O.get(k).discipline}`));
}

if (checkOnly) {
  console.log("\n--check：只比对，未写盘。");
  process.exit(0);
}
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`, "utf-8");
console.log(`\n✅ 已写出 ${out.length} 条 → ${OUT}`);
