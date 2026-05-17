/**
 * 5-17 P0 — 24h pipeline 状态条。
 * 4 段: 系统抓词 → 系统生成 → 你发布 → 你阅读
 * 前 2 段是 system tenant / 全 tenant 求和；后 2 段是 caller tenant (5-17 决策 3 user 拍板归属标签)。
 */
export interface Pipeline24hStripProps {
  keywordsCrawled: number;
  articlesGenerated: number;
  articlesPublished: number;
  totalReadsToday: number;
}

interface Step {
  label: string;
  value: number;
  scope: "系统" | "你";
  format?: (n: number) => string;
}

function compact(n: number): string {
  if (n >= 10000) return (n / 1000).toFixed(1) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

export default function Pipeline24hStrip({ keywordsCrawled, articlesGenerated, articlesPublished, totalReadsToday }: Pipeline24hStripProps) {
  const steps: Step[] = [
    { label: "抓词", value: keywordsCrawled, scope: "系统" },
    { label: "生成", value: articlesGenerated, scope: "系统" },
    { label: "发布", value: articlesPublished, scope: "你" },
    { label: "阅读", value: totalReadsToday, scope: "你", format: compact },
  ];

  return (
    <section className="bg-white rounded-2xl border border-gray-200 px-5 py-4 mb-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-2 flex-1 min-w-0">
            <div className="flex-1 text-center">
              <div className="flex items-baseline justify-center gap-1.5">
                <span className="text-xs text-gray-400">{s.scope}{s.label}</span>
                <span className="text-2xl font-bold text-gray-900">{s.format ? s.format(s.value) : s.value}</span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">24h</div>
            </div>
            {i < steps.length - 1 && <span className="text-gray-300 text-lg shrink-0">→</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
