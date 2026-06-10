/**
 * 5-21 P0 — 推荐内容预览面板 (top 3)。
 */
import { Link } from "react-router-dom";
import { platformShortLabel } from "../../utils/i18n";

export interface RecommendationPreview {
  id: string;
  title: string;
  platform?: string | null;
  coverUrl?: string | null;
}

export interface RecommendationPanelProps {
  items: RecommendationPreview[];
  totalCount: number;
  loading?: boolean;
}

export default function RecommendationPanel({ items, totalCount, loading }: RecommendationPanelProps) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">📰 待你采用的推荐</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">系统已写好，你点一下就发</p>
        </div>
        {totalCount > 0 && (
          <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs font-bold rounded-md">{totalCount}</span>
        )}
      </div>

      {loading ? (
        <div className="flex-1 space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-gray-100 rounded-lg animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <div className="text-4xl mb-2">📭</div>
          <p className="text-sm text-gray-500 mb-3">暂无新推荐</p>
          <Link to="/workbench" className="text-xs text-blue-600 hover:underline">去内容工坊查看历史 →</Link>
        </div>
      ) : (
        <>
          <ul className="flex-1 space-y-2.5">
            {items.slice(0, 3).map((it) => (
              <li key={it.id}>
                <Link
                  to={`/content/${it.id}`}
                  className="flex items-center gap-3 p-2 -mx-2 rounded-lg hover:bg-gray-50 transition"
                >
                  <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center shrink-0">
                    {it.coverUrl ? (
                      <img src={it.coverUrl} alt="" className="w-full h-full object-cover rounded-lg" loading="lazy" />
                    ) : (
                      <span className="text-xl">📄</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 line-clamp-2 leading-snug">{it.title}</p>
                    {it.platform && (
                      <p className="text-[11px] text-gray-400 mt-0.5">{platformShortLabel(it.platform)}</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Link
            to="/workbench"
            className="mt-3 text-center text-sm text-blue-600 hover:underline py-2 border-t border-gray-100"
          >
            进内容工坊采用 →
          </Link>
        </>
      )}
    </section>
  );
}
