/**
 * 5-21 P0 — 4 个 KPI 卡，每卡 = 数字 + 标签 + 副标。
 * 数据来源 ([[bossmate_business]] hero metrics):
 *  1. 今日产出 = /dashboard/overview todayHero.pipeline24h.articlesGenerated
 *  2. 待你采用 = /content/recommendations 总数 (status=recommended)
 *  3. 待跟进  = /sales/stats weekWarm (即活跃热线索)
 *  4. 已转化  = /sales/stats monthConverted
 */
import { Link } from "react-router-dom";

export interface KpiItem {
  key: string;
  value: number | string;
  label: string;
  hint?: string;
  to?: string;
  emphasis?: boolean;
}

export interface KpiStripProps {
  items: KpiItem[];
}

export default function KpiStrip({ items }: KpiStripProps) {
  return (
    <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      {items.map((it) => {
        const inner = (
          <div className={`bg-white rounded-2xl border p-4 transition-all ${
            it.emphasis ? "border-blue-300" : "border-gray-200"
          } ${it.to ? "hover:border-blue-400 hover:shadow-sm cursor-pointer" : ""}`}>
            <div className={`text-3xl font-bold leading-tight ${
              it.emphasis ? "text-blue-600" : "text-gray-900"
            }`}>
              {it.value}
            </div>
            <div className="text-xs font-medium text-gray-600 mt-1">{it.label}</div>
            {it.hint && <div className="text-[11px] text-gray-400 mt-0.5">{it.hint}</div>}
          </div>
        );
        return it.to ? (
          <Link key={it.key} to={it.to} className="block">{inner}</Link>
        ) : (
          <div key={it.key}>{inner}</div>
        );
      })}
    </section>
  );
}
