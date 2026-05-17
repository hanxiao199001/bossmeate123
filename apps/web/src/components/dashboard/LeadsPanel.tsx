/**
 * 5-21 P0 — 销售线索预览面板 (top 3 按 intentScore)。
 */
import { Link } from "react-router-dom";

export interface LeadPreview {
  id: string;
  name?: string | null;
  stage: string;
  intentScore?: number | null;
  lastMessageAt?: string | Date | null;
}

export interface LeadsPanelProps {
  items: LeadPreview[];
  totalCount: number;
  loading?: boolean;
}

const STAGE_LABEL: Record<string, string> = {
  new: "冷", qualified: "温", negotiating: "热", won: "已转化", lost: "已流失",
};
const STAGE_COLOR: Record<string, string> = {
  new: "bg-gray-100 text-gray-600",
  qualified: "bg-amber-100 text-amber-700",
  negotiating: "bg-rose-100 text-rose-700",
  won: "bg-green-100 text-green-700",
  lost: "bg-gray-100 text-gray-400",
};

function relTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export default function LeadsPanel({ items, totalCount, loading }: LeadsPanelProps) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">📡 待跟进的客户</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">意向分高 → 优先回</p>
        </div>
        {totalCount > 0 && (
          <span className="px-2 py-0.5 bg-rose-50 text-rose-700 text-xs font-bold rounded-md">{totalCount}</span>
        )}
      </div>

      {loading ? (
        <div className="flex-1 space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-gray-100 rounded-lg animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <div className="text-4xl mb-2">🎯</div>
          <p className="text-sm text-gray-500 mb-3">还没有线索来咨询</p>
          <Link to="/sales-radar" className="text-xs text-blue-600 hover:underline">进销售雷达看历史 →</Link>
        </div>
      ) : (
        <>
          <ul className="flex-1 space-y-2.5">
            {items.slice(0, 3).map((it) => (
              <li key={it.id}>
                <Link
                  to="/sales-radar"
                  className="flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-gray-50 transition"
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-rose-50 to-pink-100 flex items-center justify-center shrink-0 text-sm font-medium text-rose-600">
                    {(it.name || "?").slice(0, 1)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-gray-900 truncate">{it.name || "匿名线索"}</p>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${STAGE_COLOR[it.stage] || "bg-gray-100 text-gray-500"}`}>
                        {STAGE_LABEL[it.stage] || it.stage}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {it.intentScore != null ? <>意向 {it.intentScore} · </> : null}
                      {relTime(it.lastMessageAt)}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            to="/sales-radar"
            className="mt-3 text-center text-sm text-rose-600 hover:underline py-2 border-t border-gray-100"
          >
            进销售雷达 →
          </Link>
        </>
      )}
    </section>
  );
}
