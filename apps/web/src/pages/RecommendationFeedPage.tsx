/**
 * PR #134 V2.5 PHASE 4 Day 2 (5-13) — 主页推荐 feed 瀑布流.
 *
 * 新主入口 "/" — admin 进 BossMate 第一眼看 10 张推荐卡片.
 * 流程: 看 → 挑 → 一键发. 砍掉 4 入口干扰 (PR #128 已折叠).
 *
 * 数据来源: GET /content/recommendations (PR #133 backend).
 * 跳过: POST /content/:id/skip + 本会话即时 hide.
 * 发布: navigate /content/:id?action=publish (复用 ContentDetailPage publish panel).
 */
import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";
import RecommendationCard, { type RecommendationItem } from "../components/RecommendationCard";
import UnifiedVideoModal from "../components/video/UnifiedVideoModal";

interface FeedResponse {
  items: RecommendationItem[];
  total: number;
}

export default function RecommendationFeedPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [items, setItems] = useState<RecommendationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [skippingId, setSkippingId] = useState<string | null>(null);
  // 6-11 施工包C1-b: 卡片"生成数字人视频"改弹统一 UnifiedVideoModal (卡片上已选模板透传为默认主播)
  const [videoCtx, setVideoCtx] = useState<{ articleId: string; templateId: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    api.get<FeedResponse>("/content/recommendations?limit=10")
      .then((r) => setItems(((r as any).data ?? r).items ?? []))
      .catch((e) => setErr((e as Error).message || "加载推荐失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const handleSkip = async (id: string) => {
    if (skippingId) return;
    setSkippingId(id);
    setItems((prev) => prev.filter((x) => x.id !== id)); // optimistic
    try {
      await api.post(`/content/${id}/skip`, {});
    } catch (e) {
      console.error("skip failed", e); // 反正已隐藏，silent retry 由下次 load 自然清
    } finally {
      setSkippingId(null);
    }
  };

  // 6-11 施工包C1-b (审计 1.2): 原直接 POST /articles/:id/generate-dvh-video, 改为弹统一弹窗(弹窗内走同一接口)
  const handleGenerateDvh = (id: string, templateId: string) => {
    setVideoCtx({ articleId: id, templateId });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold text-gray-900">📅 BossMate 今日推荐</h1>
          <span className="text-xs text-gray-500">每日 03:00 自动生成 10 篇</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link to="/content" className="text-gray-600 hover:text-gray-900">📝 内容库</Link>
          <Link to="/home" className="text-gray-600 hover:text-gray-900">🛠️ 工作台</Link>
          {(user?.role === "owner" || user?.role === "admin") && (
            <Link to="/admin/journals/audit" className="text-gray-600 hover:text-gray-900">📊 后台</Link>
          )}
          <span className="text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-gray-500 hover:text-red-500">退出</button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Banner */}
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-900 mb-5 flex items-center gap-2">
          <span className="text-lg">📅</span>
          <span><strong>BossMate 每天自动生成内容</strong>。挑喜欢的，一键发布到公众号。手动创作 → <Link to="/content" className="underline text-blue-700">内容库</Link>「⚙️ 高级模式」</span>
        </div>

        {/* Loading / Error */}
        {loading && <div className="text-center py-16 text-gray-400">⏳ 加载推荐...</div>}
        {err && <div className="text-center py-12 text-red-600 text-sm">❌ {err} <button onClick={load} className="ml-2 underline">重试</button></div>}
        {!loading && !err && items.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <p className="text-3xl mb-3">🌙</p>
            <p>今日推荐已全部 skip 或暂无新推荐</p>
            <p className="text-xs mt-2">每日 03:00 BJ cron 自动生成 10 篇 — 或手动 trigger</p>
          </div>
        )}

        {/* 瀑布流 */}
        {!loading && !err && items.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {items.map((item) => (
              <RecommendationCard
                key={item.id}
                item={item}
                onView={() => navigate(`/content/${item.id}`)}
                onPublish={() => navigate(`/content/${item.id}?action=publish`)}
                onSkip={() => handleSkip(item.id)}
                onGenerateDvh={(templateId) => handleGenerateDvh(item.id, templateId)}
              />
            ))}
          </div>
        )}
      </main>

      {/* 6-11 施工包C1-b: 统一生成视频弹窗 */}
      <UnifiedVideoModal
        open={!!videoCtx}
        onClose={() => setVideoCtx(null)}
        articleId={videoCtx?.articleId}
        defaultAvatar={videoCtx?.templateId}
        defaultTab="article"
      />
    </div>
  );
}
