import { Link } from "react-router-dom";

/**
 * 内容管理页面
 *
 * TODO: 第二阶段完善
 * - 内容列表（图文、视频脚本）
 * - 状态管理（草稿、审核中、已发布）
 * - 人工二次编辑
 * - 一键发布到多平台
 */

export default function ContentPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <Link to="/" className="text-blue-600 hover:text-blue-700">← 返回</Link>
        <span className="font-bold text-gray-900">内容管理</span>
      </nav>

      <div className="max-w-4xl mx-auto py-12 px-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-900">我的内容</h1>
          <Link
            to="/chat?skill=article"
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            + 新建内容
          </Link>
        </div>

        {/* 空状态 */}
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-4">📄</p>
          <p className="text-gray-500">还没有内容</p>
          <p className="text-sm text-gray-400 mt-1">
            去对话页面创作你的第一篇内容吧
          </p>
        </div>
      </div>
    </div>
  );
}
