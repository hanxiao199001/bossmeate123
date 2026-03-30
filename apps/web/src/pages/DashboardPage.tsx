import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";

/**
 * 首页 - 两条工作流入口
 *
 * 图文创作和视频制作共享同一条管线：
 * 关键词搜索 → 聚类 → 标题生成 → 找文章 → 匹配模版 → 创作 → 核对 → 发布
 */
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
      <div className="max-w-5xl mx-auto py-12 px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          你好，{user?.name}
        </h1>
        <p className="text-gray-500 mb-8">选择一条创作流程开始工作</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 图文创作流程 */}
          <Link
            to="/workflow/article"
            className="group bg-white rounded-2xl p-6 border-2 border-gray-200 hover:border-blue-400 hover:shadow-lg transition-all"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center text-2xl">
                &#x1F4DD;
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 group-hover:text-blue-600 transition-colors">
                  图文创作
                </h3>
                <p className="text-xs text-gray-400">8步自动化流程</p>
              </div>
            </div>

            {/* 流程预览 */}
            <div className="space-y-2">
              {[
                "关键词搜索 — 抓取热门关键词",
                "关键词聚类 — AI组合2-3个关联词",
                "标题生成 — 生成SEO引流标题",
                "找期刊文章 — LetPub/知网匹配",
                "匹配模版 — 选择文章结构",
                "创作图文 — AI生成专业文章",
                "核对准确度 — 交叉验证信息",
                "一键发布 — 推送到公众号",
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm text-gray-600"
                >
                  <span className="w-5 h-5 rounded-full bg-blue-50 text-blue-600 text-xs flex items-center justify-center font-medium shrink-0">
                    {i + 1}
                  </span>
                  {item}
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-blue-600 font-medium group-hover:underline">
                开始图文创作 →
              </span>
            </div>
          </Link>

          {/* 视频制作流程 */}
          <Link
            to="/workflow/video"
            className="group bg-white rounded-2xl p-6 border-2 border-gray-200 hover:border-purple-400 hover:shadow-lg transition-all"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center text-2xl">
                &#x1F3AC;
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 group-hover:text-purple-600 transition-colors">
                  视频制作
                </h3>
                <p className="text-xs text-gray-400">8步自动化流程</p>
              </div>
            </div>

            {/* 流程预览 */}
            <div className="space-y-2">
              {[
                "关键词搜索 — 抓取热门关键词",
                "关键词聚类 — AI组合2-3个关联词",
                "标题生成 — 生成SEO引流标题",
                "找期刊文章 — LetPub/知网匹配",
                "视频脚本 — AI生成口播脚本",
                "视频生成 — 数字人/AI配音",
                "核对准确度 — 交叉验证信息",
                "一键发布 — 推送到视频号",
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 text-sm text-gray-600"
                >
                  <span className="w-5 h-5 rounded-full bg-purple-50 text-purple-600 text-xs flex items-center justify-center font-medium shrink-0">
                    {i + 1}
                  </span>
                  {item}
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-purple-600 font-medium group-hover:underline">
                开始视频制作 →
              </span>
            </div>
          </Link>
        </div>

        {/* 底部工具入口 */}
        <div className="mt-8 flex gap-4">
          <Link
            to="/keywords"
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-blue-600"
          >
            &#x1F4CA; 关键词数据库 →
          </Link>
          <Link
            to="/content"
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-blue-600"
          >
            &#x1F4C2; 内容管理 →
          </Link>
          <Link
            to="/chat"
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-blue-600"
          >
            &#x1F4AC; AI对话 →
          </Link>
          <Link
            to="/settings"
            className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-blue-600"
          >
            &#x2699;&#xFE0F; 系统设置 →
          </Link>
        </div>
      </div>
    </div>
  );
}
