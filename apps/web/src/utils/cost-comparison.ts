/**
 * 5-16 PR: 成本/工时对比纯计算 — 抽出便于单测。
 * UI (CostComparisonPage) 消费 computeMetrics。
 *
 * 假设：
 *  - 运营每月工作 22 天
 *  - BossMate daily-cron 自动 10 篇/天 = 月 300 篇
 *  - 1 运营 8h (=480min) 产 N 篇；BossMate 5min 产 10 篇
 */

export interface CostInputs {
  bossmatePriceMonthly: number; // 月度定价 (¥)
  operatorSalaryMonthly: number; // 运营月薪 (¥)
  operatorOutputDaily: number; // 1 运营日产出篇数
}

export interface CostMetrics {
  operatorOutputMonthly: number;
  operatorCostPerArticle: number;
  bossmateOutputMonthly: number;
  bossmateCostPerArticle: number;
  savePerMonth: number;
  savePerYear: number;
  roiMultiple: number;
  operatorMinutesPerArticle: number;
  bossmateMinutesPerArticle: number;
  hourSaveMultiple: number;
}

export const DEFAULTS: CostInputs = {
  bossmatePriceMonthly: 3000,
  operatorSalaryMonthly: 10000,
  operatorOutputDaily: 2,
};

// localStorage 持久化 (CostComparisonPage + HeroSection 共用)
export const STORAGE_KEY = "bossmate.costInputs.v1";

export function loadInputs(): CostInputs {
  try {
    if (typeof localStorage === "undefined") return DEFAULTS;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

export function saveInputs(v: CostInputs): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const WORK_DAYS_PER_MONTH = 22;
const BOSSMATE_DAILY_OUTPUT = 10;
const DAYS_PER_MONTH = 30;
const WORK_MINUTES_PER_DAY = 8 * 60; // 480
const BOSSMATE_BATCH_MINUTES = 5; // 5min 产 10 篇

export function computeMetrics(inputs: CostInputs): CostMetrics {
  const operatorOutputMonthly = inputs.operatorOutputDaily * WORK_DAYS_PER_MONTH;
  const operatorCostPerArticle = operatorOutputMonthly > 0 ? inputs.operatorSalaryMonthly / operatorOutputMonthly : 0;
  const bossmateOutputMonthly = BOSSMATE_DAILY_OUTPUT * DAYS_PER_MONTH; // 300
  const bossmateCostPerArticle = inputs.bossmatePriceMonthly / bossmateOutputMonthly;
  const savePerMonth = inputs.operatorSalaryMonthly - inputs.bossmatePriceMonthly;
  const savePerYear = savePerMonth * 12;
  const roiMultiple = bossmateCostPerArticle > 0 ? operatorCostPerArticle / bossmateCostPerArticle : 0;
  const operatorMinutesPerArticle = inputs.operatorOutputDaily > 0 ? WORK_MINUTES_PER_DAY / inputs.operatorOutputDaily : 0;
  const bossmateMinutesPerArticle = BOSSMATE_BATCH_MINUTES / BOSSMATE_DAILY_OUTPUT; // 0.5
  const hourSaveMultiple = bossmateMinutesPerArticle > 0 ? operatorMinutesPerArticle / bossmateMinutesPerArticle : 0;
  return {
    operatorOutputMonthly,
    operatorCostPerArticle,
    bossmateOutputMonthly,
    bossmateCostPerArticle,
    savePerMonth,
    savePerYear,
    roiMultiple,
    operatorMinutesPerArticle,
    bossmateMinutesPerArticle,
    hourSaveMultiple,
  };
}
