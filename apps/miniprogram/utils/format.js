// 展示用的小工具

// 学科：英文 → 中文（与后端 disciplineMap 对应）
const DISCIPLINE_CN = {
  medicine: "医学",
  education: "教育",
  engineering: "工程技术",
  economics: "经济管理",
  law: "法学",
  psychology: "心理学",
  biology: "生物",
  chemistry: "化学",
  physics: "物理",
  energy: "能源",
  environment: "环境科学",
  agriculture: "农林",
  materials: "材料科学",
  math: "数学",
};

// 检索/匹配下拉用的学科列表（中文 label + 英文 value）
const DISCIPLINE_OPTIONS = [
  { label: "不限", value: "" },
  { label: "医学", value: "medicine" },
  { label: "教育", value: "education" },
  { label: "工程技术", value: "engineering" },
  { label: "经济管理", value: "economics" },
  { label: "法学", value: "law" },
  { label: "心理学", value: "psychology" },
  { label: "生物", value: "biology" },
  { label: "化学", value: "chemistry" },
  { label: "物理", value: "physics" },
  { label: "环境科学", value: "environment" },
  { label: "材料科学", value: "materials" },
  { label: "数学", value: "math" },
];

const PARTITION_OPTIONS = ["不限", "Q1", "Q2", "Q3", "Q4"];

const SORT_OPTIONS = [
  { label: "按热度", value: "views" },
  { label: "按影响因子", value: "if" },
  { label: "按录用率", value: "acceptance" },
];

function disciplineCn(en) {
  if (!en) return "";
  return DISCIPLINE_CN[en] || en;
}

// 影响因子展示
function ifText(v) {
  if (v === null || v === undefined || v === 0) return "—";
  return Number(v).toFixed(1);
}

// 录用率 0-1 → 百分比
function rateText(v) {
  if (v === null || v === undefined) return "—";
  return Math.round(v * 100) + "%";
}

module.exports = {
  DISCIPLINE_CN,
  DISCIPLINE_OPTIONS,
  PARTITION_OPTIONS,
  SORT_OPTIONS,
  disciplineCn,
  ifText,
  rateText,
};
