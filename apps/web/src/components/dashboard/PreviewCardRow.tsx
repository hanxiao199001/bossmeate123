/**
 * 5-17 P0 — Hero 下方 3 列预览卡：今日最新 / 本月 ROI / 近期发布。
 * coverUrl null → emoji fallback (RecommendationCard 同模式, 5-17 决策 2)。
 */
import { Link } from "react-router-dom";

export interface LatestArticle {
  id: string;
  title: string;
  coverUrl: string | null;
  createdAt: string | Date;
}

export interface RecentPublished {
  id: string;
  title: string;
  platform: string;
  publishedAt: string | Date;
}

export interface PreviewCardRowProps {
  latestArticle: LatestArticle | null;
  recentPublished: RecentPublished[];
  monthlySavings: number;
  roiMultiple: number;
}

const yuan = (n: number) => `¥${Math.round(n).toLocaleString("zh-CN")}`;

const PLATFORM_LABEL: Record<string, string> = {
  wechat: "公众号", wechat_video: "视频号", baijiahao: "百家号",
  toutiao: "头条号", zhihu: "知乎", xiaohongshu: "小红书", douyin: "抖音", multi: "多平台",
};

function relativeTime(d: string | Date): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diff = Date.now() - t.getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "刚刚";
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  return `${days} 天前`;
}

export default function PreviewCardRow({ latestArticle, recentPublished, monthlySavings, roiMultiple }: PreviewCardRowProps) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
      {/* 卡 1: 今日最新 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">📰 今日最新</div>
        <div className="flex-1 flex items-center justify-center h-20 bg-gradient-to-br from-blue-50 to-indigo-100 rounded-lg mb-3">
          {latestArticle?.coverUrl ? (
            <img src={latestArticle.coverUrl} alt="" className="h-full object-cover rounded-lg" loading="lazy" />
          ) : (
            <span className="text-4xl">📄</span>
          )}
        </div>
        <p className="text-sm text-gray-900 line-clamp-1 mb-2" title={latestArticle?.title ?? ""}>
          {latestArticle?.title || "暂无推荐内容"}
        </p>
        {latestArticle && (
          <Link to={`/content/${latestArticle.id}`} className="text-xs text-blue-600 hover:underline self-start">查看 →</Link>
        )}
      </div>

      {/* 卡 2: 本月 ROI */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col text-center">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3 text-left">💰 本月 ROI</div>
        <div className="flex-1 flex flex-col justify-center">
          <p className="text-4xl font-bold text-emerald-600">{roiMultiple.toFixed(1)}<span className="text-lg">x</span></p>
          <p className="text-sm text-gray-600 mt-2">月省 <span className="font-semibold text-gray-900">{yuan(monthlySavings)}</span></p>
        </div>
        <Link to="/cost-comparison" className="text-xs text-blue-600 hover:underline self-start mt-2">详情 →</Link>
      </div>

      {/* 卡 3: 近期发布 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-col">
        <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">📈 近期发布</div>
        <div className="flex-1 space-y-2">
          {recentPublished.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">暂无发布记录</p>
          ) : (
            recentPublished.slice(0, 3).map((r) => (
              <Link key={r.id} to={`/content/${r.id}`} className="block hover:bg-gray-50 rounded -mx-1 px-1 py-1">
                <p className="text-sm text-gray-900 line-clamp-1" title={r.title}>{r.title}</p>
                <p className="text-xs text-gray-400 mt-0.5">{PLATFORM_LABEL[r.platform] || r.platform} · {relativeTime(r.publishedAt)}</p>
              </Link>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
