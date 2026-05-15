/**
 * 5-16 PR: 成本/工时对比 dashboard — 5-22 demo "老板一眼懂" 演示页。
 *
 * 输入区 3 个可编辑参数 (localStorage 持久化, 不 hardcode)。
 * 计算逻辑在 utils/cost-comparison.ts (纯函数, 已 vitest 覆盖)。
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { computeMetrics, DEFAULTS, type CostInputs } from "../utils/cost-comparison";

const STORAGE_KEY = "bossmate.costInputs.v1";

function loadInputs(): CostInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

function saveInputs(v: CostInputs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

const yuan = (n: number) => `¥${Math.round(n).toLocaleString("zh-CN")}`;

export default function CostComparisonPage() {
  const user = useAuthStore((s) => s.user);
  const [inputs, setInputs] = useState<CostInputs>(loadInputs);
  useEffect(() => saveInputs(inputs), [inputs]);
  const m = computeMetrics(inputs);

  // Bar 长度比例 (运营固定 100%, BossMate 等比缩；clamp 1% 让小条仍可见)
  const opBarPct = 100;
  const bmBarPct = m.operatorCostPerArticle > 0 ? Math.max(1, (m.bossmateCostPerArticle / m.operatorCostPerArticle) * 100) : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-blue-600 hover:underline">← 返回首页</Link>
          <h1 className="text-lg font-bold text-gray-900">💰 BossMate 价值对比</h1>
        </div>
        <span className="text-sm text-gray-500">{user?.name}</span>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* 输入区 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">假设参数（可编辑，自动保存）</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <NumberInput label="BossMate 月度定价 (¥)" value={inputs.bossmatePriceMonthly} onChange={(v) => setInputs({ ...inputs, bossmatePriceMonthly: v })} step={500} />
            <NumberInput label="目标客户运营月薪 (¥)" value={inputs.operatorSalaryMonthly} onChange={(v) => setInputs({ ...inputs, operatorSalaryMonthly: v })} step={1000} />
            <NumberInput label="1 运营日产出篇数" value={inputs.operatorOutputDaily} onChange={(v) => setInputs({ ...inputs, operatorOutputDaily: v })} step={1} min={0} />
          </div>
        </section>

        {/* 单篇成本对比 + bar */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-bold text-gray-900 mb-4">📊 单篇成本对比</h2>
          <div className="space-y-4">
            <BarRow label="目标客户运营" cost={m.operatorCostPerArticle} pct={opBarPct} color="bg-red-400" />
            <BarRow label="BossMate" cost={m.bossmateCostPerArticle} pct={bmBarPct} color="bg-green-500" />
          </div>
          <div className="mt-6 pt-6 border-t border-gray-100 text-center">
            <p className="text-sm text-gray-500">ROI 倍数（运营单篇成本 ÷ BossMate 单篇成本）</p>
            <p className="text-6xl font-bold text-green-600 mt-1">
              {m.roiMultiple.toFixed(1)}<span className="text-3xl">x</span>
            </p>
            <p className="text-sm text-gray-500 mt-1">BossMate 单篇成本仅为运营的 1/{m.roiMultiple.toFixed(1)}</p>
          </div>
        </section>

        {/* 月省 / 年省 */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <BigStat label="替代 1 名运营，月省" value={yuan(m.savePerMonth)} color="text-blue-600" />
          <BigStat label="年化节省" value={yuan(m.savePerYear)} color="text-indigo-600" />
        </section>

        {/* 工时对比 */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-bold text-gray-900 mb-4">⏱️ 工时对比</h2>
          <div className="grid grid-cols-2 gap-6 text-center">
            <div>
              <p className="text-sm text-gray-500">1 运营 8 小时产</p>
              <p className="text-4xl font-bold text-gray-800 mt-2">
                {inputs.operatorOutputDaily}<span className="text-base font-normal text-gray-500"> 篇</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">单篇约 {m.operatorMinutesPerArticle.toFixed(0)} 分钟</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">BossMate 5 分钟产</p>
              <p className="text-4xl font-bold text-green-600 mt-2">
                10<span className="text-base font-normal text-gray-500"> 篇</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">单篇约 {m.bossmateMinutesPerArticle.toFixed(1)} 分钟</p>
            </div>
          </div>
          <div className="mt-6 pt-6 border-t border-gray-100 text-center">
            <p className="text-sm text-gray-500">工时压缩倍数</p>
            <p className="text-6xl font-bold text-purple-600 mt-1">
              {m.hourSaveMultiple.toFixed(0)}<span className="text-3xl">x</span>
            </p>
          </div>
        </section>

        <p className="text-xs text-gray-400 text-center">
          假设运营每月工作 22 天；BossMate daily-cron 每天自动 10 篇 = 月 300 篇
        </p>
      </main>
    </div>
  );
}

function NumberInput({ label, value, onChange, step = 100, min = 0 }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-blue-200"
      />
    </label>
  );
}

function BarRow({ label, cost, pct, color }: { label: string; cost: number; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <span className="text-2xl font-bold text-gray-900">
          ¥{cost.toFixed(0)}<span className="text-xs font-normal text-gray-500">/篇</span>
        </span>
      </div>
      <div className="h-6 bg-gray-100 rounded overflow-hidden">
        <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BigStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
      <p className="text-sm text-gray-500 mb-2">{label}</p>
      <p className={`text-4xl font-bold ${color}`}>{value}</p>
    </div>
  );
}
