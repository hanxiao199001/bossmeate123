/**
 * 刊名归一 —— 单一真相源（8-10 从 scripts/ingest-domestic-core.ts 搬来）。
 *
 * ## 为什么要搬到 service 层
 *
 * 原实现在 `scripts/ingest-domestic-core.ts:23`。别处想用就得 `import` 那个脚本，
 * 而脚本模块级带 `import { db }` —— 一 import 就连 DB（本项目 backlog-A 记过的
 * 「急切实例化」反模式，enrich-wanfang-batch 曾因同类问题卡死）。
 *
 * 更要紧的是**口径必须只有一份**：入库时用 A 规则归一、查询时用 B 规则归一，
 * 就会出现「目录快照里明明有这本刊，代码却匹配不上」。而下游文案会写
 * 「本刊是 CSSCI 教育学分类下的 43 本之一」—— 匹配漂移 = 直接写出假断言。
 *
 * ## 规则出处
 *
 * 逐条来自入库脚本，一字未改（改了就意味着入库与查询两套口径）：
 *   ① 去掉「（改名为：XX）」「[改名为 XX]」尾注
 *   ② 全角括号/逗号/间隔号 → 半角
 *   ③ 去所有空白
 *   ④ 去首尾书名号
 *   ⑤ PR-C3：统一 `.XX版` → `(XX版)` —— 北大核心用括号、CSSCI 用点号，
 *      不统一会让同一本刊在两个目录里对不上（如「西南师范大学学报.自然科学版」）
 */

/** 刊名归一。入库与查询必须用同一个函数，别在调用方自己 trim/replace。 */
export function normName(name: string): string {
  if (!name) return "";
  let s = name;
  s = s.replace(/[（(]\s*改名为[：:][^)）]*[)）]/g, "");
  s = s.replace(/\[\s*改名为[^\]]*\]/g, "");
  s = s.replace(/（/g, "(").replace(/）/g, ")").replace(/，/g, ",").replace(/•/g, "·");
  s = s.replace(/\s+/g, "");
  s = s.replace(/^[《\s]+|[》\s]+$/g, "");
  // PR-C3: 统一 ".XX版" → "(XX版)" — 北大核心用括号、CSSCI 用点号, 防同刊重复入库
  s = s.replace(/\.([一-龥A-Za-z0-9]+版)\)?$/, "($1)");
  return s;
}
