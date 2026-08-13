/**
 * 修正 `pku-core-2023.json` 的刊名转录错字（8-11）。幂等，可重复运行。
 *
 * ## 为什么是"打补丁"而不是"整表重建"
 *
 * 北大核心与 CSSCI 不同：**它没有官方机器可读版**——《中文核心期刊要目总览》(2023年版,
 * 第十版) 是 2024 年 3 月北大出版社出的**纸质书**，网上流通的全部是"根据图书内容整理完成"
 * 的第三方转录。既然不存在唯一权威源，就不能像 CSSCI 那样照着一份重建
 * （那只会把那一份自己的错字也搬进来）。
 *
 * 改用**三份独立转录互校**，只修「≥2 份独立来源一致反对快照」的条目：
 *
 *   A. 本仓库快照         src/data/pku-core-2023.json（源: zzqklm.com 转载页）
 *   B. chinagp.net PDF    带「总序号 + 分类 + 刊名 + 分类内序号」四列
 *   C. 华南师大图书馆 PDF   https://statics.scnu.edu.cn/pics/lib/2025/1031/1761900005705688.pdf
 *
 * ## 互校结果（8-11）
 *
 * **学科归属零差异**：A 与 B 逐条同序对齐 1987 条，148 个分类块**块大小全部相等**。
 * 「学科定位」体裁用到的正是这一层，它是干净的。
 *
 * **刊名拼写两边都有错**，且是不同的错——这正是互校的价值。C 作裁判后：
 * 快照 7 处错字（下表），chinagp 1 处（「介人放射学」，快照的「介入」才对）。
 *
 * ## 🔴 其中一条是实质错误，不是错别字
 *
 * `内蒙古大学学报.自然科学版` → `内蒙古农业大学学报.自然科学版`：**两所不同的学校**。
 * 改之前，快照等于对《内蒙古大学学报》宣称"入选北大核心"——
 * 成员资格层面的假阳性，性质同台刊同名碰撞。其余 6 条是错别字，
 * 后果是该刊匹配不上（不出稿，安全方向）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "../src/data/pku-core-2023.json");

/** [错, 对, 证据] —— 每条都经 chinagp + 华南师大两份独立转录确认 */
const FIXES = [
  ["福建师范大学学报.自热科学版", "福建师范大学学报.自然科学版", "自热→自然"],
  ["内蒙古大学学报.自然科学版", "内蒙古农业大学学报.自然科学版", "🔴 实质错误：两所不同的学校"],
  ["中国医学前言杂志（电子版）", "中国医学前沿杂志（电子版）", "前言→前沿"],
  ["神经解刨学杂志", "神经解剖学杂志", "解刨→解剖"],
  ["中国临床医学影响杂志", "中国临床医学影像杂志", "影响→影像"],
  ["西南林业大学学报.自然学", "西南林业大学学报.自然科学", "自然学→自然科学"],
  ["精密成型工程", "精密成形工程", "成型→成形"],
];

const rows = JSON.parse(readFileSync(FILE, "utf-8"));
const before = rows.length;
let applied = 0;
let already = 0;

for (const [bad, good, why] of FIXES) {
  const hitBad = rows.filter((r) => r.name === bad);
  const hitGood = rows.filter((r) => r.name === good);
  if (hitBad.length === 0 && hitGood.length === 1) {
    already++;
    continue; // 幂等：已修过
  }
  if (hitBad.length !== 1) {
    console.error(`❌ 「${bad}」命中 ${hitBad.length} 条（应为 1）——数据变了，先核对再改`);
    process.exit(1);
  }
  if (hitGood.length !== 0) {
    console.error(`❌ 「${good}」已存在，改名会造成重复条目`);
    process.exit(1);
  }
  hitBad[0].name = good;
  applied++;
  console.log(`  ✔ ${bad} → ${good}   (${why})`);
}

// 自检：条数不变、无重名
if (rows.length !== before) {
  console.error(`❌ 条数从 ${before} 变成 ${rows.length}`);
  process.exit(1);
}
const names = rows.map((r) => r.name);
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length > 0) {
  console.error(`❌ 出现重名: ${dup.slice(0, 5).join(", ")}`);
  process.exit(1);
}

if (applied > 0) writeFileSync(FILE, `${JSON.stringify(rows, null, 1)}\n`, "utf-8");
console.log(`\n共 ${FIXES.length} 条：本次修正 ${applied} 条，已是正确值 ${already} 条。总条数 ${rows.length}。`);
