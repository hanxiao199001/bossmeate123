/**
 * 国内核心期刊种子数据
 *
 * 数据来源：
 * - 北大核心（2023版）：《中文核心期刊要目总览》，北京大学出版社
 * - CSSCI（2025-2026版）：南京大学中国社会科学研究评价中心
 * - 科技核心（2025版）：中国科学技术信息研究所
 *
 * 先收录 4 个重点学科（教育、经济、医学、法学），后续逐步补全
 * 每个期刊标注所属目录类型 + 学科分类，用于与 SCI 期刊统一管理
 */

export type DomesticCatalogType =
  | "pku-core"     // 北大核心（中文核心期刊要目总览）
  | "cssci"        // CSSCI 来源期刊
  | "cssci-ext"    // CSSCI 扩展版
  | "sci-core"     // 中国科技核心期刊（统计源）
  | "cscd"         // 中国科学引文数据库
  | "ami-core";    // AMI 综合评价核心期刊

export interface DomesticJournal {
  name: string;                      // 期刊名称
  issn?: string;                     // ISSN
  cn?: string;                       // 国内统一刊号
  discipline: string;                // 学科分类
  subdiscipline?: string;            // 子学科
  catalogs: DomesticCatalogType[];   // 所属目录（可能同时在多个目录中）
  catalogYear: string;               // 目录版本
  frequency?: string;                // 刊期：月刊/双月刊/季刊
  publisher?: string;                // 主办单位
  isTop?: boolean;                   // 是否顶刊
}

// ============ 教育学 ============

const EDUCATION_JOURNALS: DomesticJournal[] = [
  // --- CSSCI + 北大核心 双核心 ---
  { name: "教育研究", issn: "1002-5731", cn: "11-1281/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国教育科学研究院", isTop: true },
  { name: "高等教育研究", issn: "1000-4203", cn: "42-1024/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "华中科技大学", isTop: true },
  { name: "教育发展研究", issn: "1008-3855", cn: "31-1772/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "上海市教育科学研究院" },
  { name: "北京大学教育评论", issn: "1671-9468", cn: "11-4848/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京大学", isTop: true },
  { name: "清华大学教育研究", issn: "1001-4519", cn: "11-1610/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "清华大学" },
  { name: "华东师范大学学报(教育科学版)", issn: "1000-5560", cn: "31-1007/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "华东师范大学", isTop: true },
  { name: "课程·教材·教法", issn: "1000-0186", cn: "11-1278/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "人民教育出版社" },
  { name: "比较教育研究", issn: "1003-7667", cn: "11-2878/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京师范大学" },
  { name: "教师教育研究", issn: "1672-5905", cn: "11-5147/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京师范大学" },
  { name: "中国高教研究", issn: "1004-3667", cn: "11-2962/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国高等教育学会" },
  { name: "学位与研究生教育", issn: "1001-960X", cn: "11-1736/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "国务院学位委员会" },
  { name: "中国教育学刊", issn: "1002-4808", cn: "11-2606/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国教育学会" },
  { name: "教育学报", issn: "1673-1298", cn: "11-5306/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京师范大学" },
  { name: "全球教育展望", issn: "1009-9670", cn: "31-1842/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "华东师范大学" },
  { name: "教育与经济", issn: "1003-4870", cn: "42-1268/G4", discipline: "教育学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "华中师范大学" },
  { name: "中国远程教育", issn: "1009-458X", cn: "11-4089/G4", discipline: "教育学", subdiscipline: "远程教育", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中央广播电视大学" },
  { name: "开放教育研究", issn: "1007-2179", cn: "31-1724/G4", discipline: "教育学", subdiscipline: "远程教育", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "上海远程教育集团" },
  { name: "电化教育研究", issn: "1003-1553", cn: "62-1022/G4", discipline: "教育学", subdiscipline: "教育技术", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "西北师范大学" },
  { name: "现代远程教育研究", issn: "1009-5195", cn: "51-1580/G4", discipline: "教育学", subdiscipline: "远程教育", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "四川广播电视大学" },
  { name: "中国特殊教育", issn: "1007-3728", cn: "11-3826/G4", discipline: "教育学", subdiscipline: "特殊教育", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中央教育科学研究所" },

  // --- 北大核心（非 CSSCI）---
  { name: "教育科学", issn: "1002-8064", cn: "21-1066/G4", discipline: "教育学", catalogs: ["pku-core"], catalogYear: "2023", publisher: "辽宁师范大学" },
  { name: "教育理论与实践", issn: "1004-633X", cn: "14-1027/G4", discipline: "教育学", catalogs: ["pku-core"], catalogYear: "2023", publisher: "山西省教育科学研究院" },
  { name: "教育学术月刊", issn: "1674-2311", cn: "36-1301/G4", discipline: "教育学", catalogs: ["pku-core"], catalogYear: "2023", publisher: "江西省教育科学研究所" },
  { name: "现代教育技术", issn: "1009-8097", cn: "11-4525/N", discipline: "教育学", subdiscipline: "教育技术", catalogs: ["pku-core", "cssci"], catalogYear: "2025", publisher: "清华大学" },
  { name: "思想理论教育导刊", issn: "1009-2528", cn: "11-4062/G4", discipline: "教育学", subdiscipline: "思政教育", catalogs: ["pku-core", "cssci"], catalogYear: "2025", publisher: "教育部" },
];

// ============ 经济学/管理学 ============

const ECONOMICS_JOURNALS: DomesticJournal[] = [
  // --- 顶级期刊 ---
  { name: "经济研究", issn: "0577-9154", cn: "11-1081/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院经济研究所", isTop: true },
  { name: "管理世界", issn: "1002-5502", cn: "11-1235/F", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "国务院发展研究中心", isTop: true },
  { name: "中国工业经济", issn: "1006-480X", cn: "11-3536/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院工业经济研究所", isTop: true },
  { name: "会计研究", issn: "1003-2886", cn: "11-1078/F", discipline: "管理学", subdiscipline: "会计学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国会计学会", isTop: true },
  { name: "金融研究", issn: "1002-7246", cn: "11-1268/F", discipline: "经济学", subdiscipline: "金融学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国金融学会", isTop: true },
  { name: "经济学(季刊)", issn: "2095-1086", cn: "10-1028/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京大学", isTop: true },
  { name: "南开管理评论", issn: "1008-3448", cn: "12-1288/F", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "南开大学", isTop: true },
  { name: "管理科学学报", issn: "1007-9807", cn: "12-1275/G3", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "国家自然科学基金委员会", isTop: true },

  // --- 重要期刊 ---
  { name: "世界经济", issn: "1002-9621", cn: "11-1138/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院世界经济与政治研究所" },
  { name: "经济科学", issn: "1002-5839", cn: "11-1564/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京大学" },
  { name: "财经研究", issn: "1001-9952", cn: "31-1012/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "上海财经大学" },
  { name: "财贸经济", issn: "1002-8102", cn: "11-1166/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院财经战略研究院" },
  { name: "中国农村经济", issn: "1002-8870", cn: "11-1262/F", discipline: "经济学", subdiscipline: "农业经济", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院农村发展研究所" },
  { name: "数量经济技术经济研究", issn: "1000-3894", cn: "11-1087/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院数量经济与技术经济研究所" },
  { name: "国际经济评论", issn: "1007-0974", cn: "11-3799/F", discipline: "经济学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院世界经济与政治研究所" },
  { name: "经济管理", issn: "1002-5766", cn: "11-1047/F", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院工业经济研究所" },
  { name: "中国管理科学", issn: "1003-207X", cn: "11-2835/G3", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国优选法统筹法与经济数学研究会" },
  { name: "管理评论", issn: "1003-1952", cn: "11-5057/F", discipline: "管理学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国科学院大学" },
  { name: "科研管理", issn: "1000-2995", cn: "11-1567/G3", discipline: "管理学", subdiscipline: "科技管理", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国科学院科技战略咨询研究院" },
  { name: "科学学研究", issn: "1003-2053", cn: "11-1805/G3", discipline: "管理学", subdiscipline: "科学学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国科学学与科技政策研究会" },
];

// ============ 医学 ============

const MEDICINE_JOURNALS: DomesticJournal[] = [
  // --- 中华系列（顶级）---
  { name: "中华医学杂志", issn: "0376-2491", cn: "11-2137/R", discipline: "医学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会", isTop: true },
  { name: "中华内科杂志", issn: "0578-1426", cn: "11-2138/R", discipline: "医学", subdiscipline: "内科学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会", isTop: true },
  { name: "中华外科杂志", issn: "0529-5815", cn: "11-2139/R", discipline: "医学", subdiscipline: "外科学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会", isTop: true },
  { name: "中华肿瘤杂志", issn: "0253-3766", cn: "11-2152/R", discipline: "医学", subdiscipline: "肿瘤学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中华心血管病杂志", issn: "0253-3758", cn: "11-2148/R", discipline: "医学", subdiscipline: "心血管", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中华神经科杂志", issn: "1006-7876", cn: "11-3694/R", discipline: "医学", subdiscipline: "神经科", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中华儿科杂志", issn: "0578-1310", cn: "11-2140/R", discipline: "医学", subdiscipline: "儿科学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中华护理杂志", issn: "0254-1769", cn: "11-2234/R", discipline: "医学", subdiscipline: "护理学", catalogs: ["pku-core", "sci-core"], catalogYear: "2025", publisher: "中华护理学会", isTop: true },

  // --- 药学/中医药 ---
  { name: "药学学报", issn: "0513-4870", cn: "11-2163/R", discipline: "医学", subdiscipline: "药学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中国药学会", isTop: true },
  { name: "中国药学杂志", issn: "1001-2494", cn: "11-2162/R", discipline: "医学", subdiscipline: "药学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中国药学会" },
  { name: "中国中药杂志", issn: "1001-5302", cn: "11-2272/R", discipline: "医学", subdiscipline: "中药学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中国药学会" },
  { name: "中华中医药杂志", issn: "1673-1727", cn: "11-5334/R", discipline: "医学", subdiscipline: "中医学", catalogs: ["pku-core", "sci-core"], catalogYear: "2025", publisher: "中华中医药学会" },

  // --- 公共卫生/预防医学 ---
  { name: "中华预防医学杂志", issn: "0253-9624", cn: "11-2150/R", discipline: "医学", subdiscipline: "预防医学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中华流行病学杂志", issn: "0254-6450", cn: "11-2338/R", discipline: "医学", subdiscipline: "流行病学", catalogs: ["pku-core", "sci-core", "cscd"], catalogYear: "2025", publisher: "中华医学会" },
  { name: "中国公共卫生", issn: "1001-0580", cn: "21-1234/R", discipline: "医学", subdiscipline: "公共卫生", catalogs: ["pku-core", "sci-core"], catalogYear: "2025", publisher: "中华预防医学会" },

  // --- 医学综合/其他 ---
  { name: "中国循证医学杂志", issn: "1672-2531", cn: "51-1656/R", discipline: "医学", subdiscipline: "循证医学", catalogs: ["pku-core", "sci-core"], catalogYear: "2025", publisher: "四川大学" },
  { name: "中国全科医学", issn: "1007-9572", cn: "13-1222/R", discipline: "医学", subdiscipline: "全科医学", catalogs: ["pku-core", "sci-core"], catalogYear: "2025", publisher: "中国全科医学杂志社" },
  { name: "医学与哲学", issn: "1002-0772", cn: "21-1093/R", discipline: "医学", subdiscipline: "医学人文", catalogs: ["pku-core"], catalogYear: "2023", publisher: "中国自然辩证法研究会" },
];

// ============ 法学 ============

const LAW_JOURNALS: DomesticJournal[] = [
  { name: "中国法学", issn: "1003-1707", cn: "11-1030/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国法学会", isTop: true },
  { name: "法学研究", issn: "1002-896X", cn: "11-1162/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院法学研究所", isTop: true },
  { name: "中外法学", issn: "1002-4875", cn: "11-2447/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "北京大学", isTop: true },
  { name: "法学家", issn: "1005-0221", cn: "11-3212/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国人民大学" },
  { name: "法学", issn: "1000-4238", cn: "31-1050/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "华东政法大学" },
  { name: "法商研究", issn: "1672-0393", cn: "42-1664/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中南财经政法大学" },
  { name: "政法论坛", issn: "1000-0208", cn: "11-1314/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国政法大学" },
  { name: "现代法学", issn: "1001-2397", cn: "50-1020/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "西南政法大学" },
  { name: "法律科学", issn: "1674-5205", cn: "61-1470/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "西北政法大学" },
  { name: "法制与社会发展", issn: "1006-6128", cn: "22-1243/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "吉林大学" },
  { name: "比较法研究", issn: "1004-8561", cn: "11-3171/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国政法大学" },
  { name: "环球法律评论", issn: "1009-6728", cn: "11-4560/D", discipline: "法学", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国社会科学院法学研究所" },
  { name: "知识产权", issn: "1003-0476", cn: "11-2760/N", discipline: "法学", subdiscipline: "知识产权", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "知识产权出版社" },
  { name: "行政法学研究", issn: "1005-0078", cn: "11-3110/D", discipline: "法学", subdiscipline: "行政法", catalogs: ["cssci", "pku-core"], catalogYear: "2025", publisher: "中国政法大学" },
];

// ============ 导出汇总 ============

export const DOMESTIC_JOURNAL_SEEDS: DomesticJournal[] = [
  ...EDUCATION_JOURNALS,
  ...ECONOMICS_JOURNALS,
  ...MEDICINE_JOURNALS,
  ...LAW_JOURNALS,
];

/** 按学科分类获取 */
export function getDomesticJournalsByDiscipline(discipline: string): DomesticJournal[] {
  return DOMESTIC_JOURNAL_SEEDS.filter(j => j.discipline === discipline);
}

/** 按目录类型获取 */
export function getDomesticJournalsByCatalog(catalog: DomesticCatalogType): DomesticJournal[] {
  return DOMESTIC_JOURNAL_SEEDS.filter(j => j.catalogs.includes(catalog));
}

/** 获取顶刊列表 */
export function getTopDomesticJournals(): DomesticJournal[] {
  return DOMESTIC_JOURNAL_SEEDS.filter(j => j.isTop);
}

/** 统计信息 */
export function getDomesticCatalogStats() {
  const stats = {
    total: DOMESTIC_JOURNAL_SEEDS.length,
    byDiscipline: {} as Record<string, number>,
    byCatalog: {} as Record<string, number>,
    topCount: 0,
  };

  for (const j of DOMESTIC_JOURNAL_SEEDS) {
    stats.byDiscipline[j.discipline] = (stats.byDiscipline[j.discipline] || 0) + 1;
    for (const c of j.catalogs) {
      stats.byCatalog[c] = (stats.byCatalog[c] || 0) + 1;
    }
    if (j.isTop) stats.topCount++;
  }

  return stats;
}
