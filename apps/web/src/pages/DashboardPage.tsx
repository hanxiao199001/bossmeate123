import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-blue-600">BossMate</span>
          <span className="text-xs text-gray-400">AI超级员工</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button
            onClick={logout}
            className="text-sm text-gray-500 hover:text-red-500"
          >
            退出
          </button>
        </div>
      </nav>

      {/* 主内容 */}
      <div className="max-w-4xl mx-auto py-12 px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          你好，{user?.name}
        </h1>
        <p className="text-gray-500 mb-8">选择你需要的AI助手功能</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* 关键词中心（新增） */}
          <Link
            to="/keywords"
            className="bg-white rounded-xl p-6 border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all"
          >
            <div className="text-3xl mb-3">🔍</div>
            <h3 className="font-bold text-gray-900 mb-1">关键词中心</h3>
            <p className="text-sm text-gray-500">
              8大平台热点实时抓取，每日关键词智能推荐
            </p>
          </Link>

          {/* 图文线 */}
          <Link
            to="/chat?skill=article"
            className="bg-white rounded-xl p-6 border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all"
          >
            <div className="text-3xl mb-3">📝</div>
            <h3 className="font-bold text-gray-900 mb-1">图文创作</h3>
            <p className="text-sm text-gray-500">
              一句话生成专业文章，一键发布到多个平台
            </p>
          </Link>

          {/* 视频线（待开发）*/}
          <div className="bg-white rounded-xl p-6 border border-gray-200 opacity-50">
            <div className="text-3xl mb-3">🎬</div>
            <h3 className="font-bold text-gray-900 mb-1">视频创作</h3>
            <p className="text-sm text-gray-500">
              竞品分析 → 脚本撰写 → 视频生成
            </p>
            <span className="text-xs text-orange-500 font-medium">即将上线</span>
          </div>
        </div>

        {/* 快捷入口 */}
        <div className="mt-8 flex gap-4">
          <Link
            to="/keywords"
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
          >
            🔍 关键词中心 →
          </Link>
          <Link
            to="/content"
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
          >
            📂 内容管理 →
          </Link>
        </div>
      </div>
    </div>
  );
}
