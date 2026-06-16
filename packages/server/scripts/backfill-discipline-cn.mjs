/**
 * 一次性回填中文期刊的 discipline —— 从中文刊名推断学科代码。
 * 背景: 原 backfill-discipline 从 JCR/英文名推断, 中文核心刊推断不出 → discipline 大面积为空,
 *       导致"国内核心+学科"的每日生成几乎选不到刊。本脚本补这块。
 * 用法(服务器, 部署后): cd /home/projects/bossmate/packages/server && node scripts/backfill-discipline-cn.mjs
 */
import { db } from "../dist/models/db.js";
import { sql } from "drizzle-orm";

// 中文刊名关键词 → 学科代码 (按顺序匹配, 命中即止; 把区分度高的放前面)
const RULES = [
  ["medicine",   /医(?!药卫生管理)|临床|外科|内科|肿瘤|癌症?|护理|中医|中药|药学|药理|口腔|儿科|妇产|骨科|眼科|皮肤|心血管|消化|呼吸|泌尿|肝胆|血液|免疫|检验医学|影像|放射|超声|麻醉|康复|精神病|卫生|健康|流行病|疾病|医院|医师|防治|护士/],
  ["law",        /法学|法律|政法|司法|检察|审判|律师|刑事|民商|宪法|行政法/],
  ["psychology", /心理/],
  ["agriculture",/农业|农学|作物|园艺|林业|林学|畜牧|兽医|水产|渔业|食品|土壤|植物保护|种业|农机|蔬菜|果树|茶叶|烟草|蚕业|饲料|养殖/],
  ["education",  /教育|教学|课程|高教|职教|学前|德育|教师|考试|招生|学校|高校/],
  ["economics",  /经济|金融|财经|会计|管理|商业|贸易|投资|证券|保险|财政|审计|营销|企业管理|产业|统计研究/],
  ["chemistry",  /化学|化工|催化|有机化学|无机化学|高分子|分析化学|电化学|应用化学|精细化工/],
  ["physics",    /物理|光学|声学|量子|半导体|核物理|光电|激光|光子/],
  ["computer",   /计算机|软件|信息技术|信息系统|通信|网络安全|大数据|人工智能|微电子|集成电路|物联网/],
  ["engineering",/工程|机械|材料(?!化学)|建筑|土木|冶金|矿业|矿山|电气|电力|仪器|制造|焊接|铸造|液压|纺织|包装|动力|船舶|航空|汽车|能源/],
  ["environment",/环境|生态|污染|气象|气候|资源科学|节能|环保|地质|地球|海洋|大气|水文/],
  ["biology",    /生物|遗传|微生物|细胞|分子生物|动物|昆虫|病毒|基因|生命科学/],
];

function infer(name) {
  const s = name || "";
  for (const [disc, re] of RULES) if (re.test(s)) return disc;
  return null;
}

const res = await db.execute(sql`SELECT id, name, name_en FROM journals WHERE (discipline IS NULL OR discipline='' OR discipline='multidisciplinary')`);
const rows = res.rows ?? res ?? [];
let updated = 0;
const counts = {};
for (const r of rows) {
  const d = infer(r.name) || infer(r.name_en);
  if (d) { await db.execute(sql`UPDATE journals SET discipline = ${d} WHERE id = ${r.id}`); updated++; counts[d] = (counts[d] || 0) + 1; }
}
console.log(`中文刊学科回填: ${updated}/${rows.length} 条更新`);
console.log("各学科新增:", JSON.stringify(counts));
process.exit(0);
