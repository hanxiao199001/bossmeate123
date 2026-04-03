import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import SmartInput from "../components/SmartInput";

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
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto py-10 px-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">
          你好，{user?.name}
        </h1>
        <p className="text-gray-400 text-sm mb-8">选择工作流开始内容生产，或使用下方工具</p>

        {/* ====== 核心：三个主入口并列 ====== */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
          {/* 图文创作 */}
          <Link
            to="/chat?skill=article"
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
                <p className="text-xs text-gray-400">8步流水线 · 从选题到发布</p>
              </div>
            </div>
            <div className="space-y-1.5">
              {[
                "关键词搜索", "关键词聚类", "标题生成", "找期刊文章",
                "匹配模版", "AI + 知识库RAG", "核对准确度", "一键发布",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="w-5 h-5 rounded-full bg-blue-50 text-blue-600 text-xs flex items-center justify-center font-medium shrink-0">
                    {i + 1}
                  </span>
                  {item}
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-blue-600 font-medium group-hover:underline">
                开始图文创作 &#x2192;
              </span>
            </div>
          </Link>

          {/* 视频制作 */}
          <Link
            to="/chat?skill=video"
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
                <p className="text-xs text-gray-400">8步流水线 · 从选题到发布</p>
              </div>
            </div>
            <div className="space-y-1.5">
              {[
                "关键词搜索", "关键词聚类", "标题生成", "找期刊文章",
                "视频脚本", "数字人/AI配音", "核对准确度", "一键发布",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="w-5 h-5 rounded-full bg-purple-50 text-purple-600 text-xs flex items-center justify-center font-medium shrink-0">
                    {i + 1}
                  </span>
                  {item}
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-purple-600 font-medium group-hover:underline">
                开始视频制作 &#x2192;
              </span>
            </div>
          </Link>

          {/* AI 助手 */}
          <Link
            to="/chat"
            className="group bg-white rounded-2xl p-6 border-2 border-gray-200 hover:border-emerald-400 hover:shadow-lg transition-all"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center text-2xl">
                &#x1F916;
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900 group-hover:text-emerald-600 transition-colors">
                  AI 助手
                </h3>
                <p className="text-xs text-gray-400">智能问答 · 随时可用</p>
              </div>
            </div>
            <div className="space-y-1.5">
              {[
                "知识问答 — 基于知识库回答",
                "内容总结 — 长文提炼要点",
                "翻译润色 — 中英互译优化",
                "头脑风暴 — 选题灵感发散",
                "数据解读 — 分析报表数据",
                "文案改写 — 调整风格调性",
                "竞品分析 — 拆解对手策略",
                "自由对话 — 任何工作问题",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="w-5 h-5 rounded-full bg-emerald-50 text-emerald-600 text-xs flex items-center justify-center font-medium shrink-0">
                    &#x2713;
                  </span>
                  {item}
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-emerald-600 font-medium group-hover:underline">
                打开 AI 助手 &#x2192;
              </span>
            </div>
          </Link>
        </div>

        {/* ====== 智能输入框 ====== */}
        <SmartInput />

        {/* ====== 工具区：两列对齐 ====== */}
        <div className="grid grid-cols-2 gap-5">
          {/* 左列：内容工具 */}
          <div>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">内容工具</h2>
            <div className="space-y-2">
              <ToolLink to="/keywords"  icon="&#x1F4CA;" label="关键词数据库" desc="热词抓取、趋势分析、选题参考" />
              <ToolLink to="/content"   icon="&#x1F4C2;" label="内容管理"     desc="草稿、审核、发布状态流转" />
              <ToolLink to="/knowledge" icon="&#x1F4D6;" label="知识库引擎"   desc="16子库管理、语义搜索、冷启动" />
            </div>
          </div>

          {/* 右列：后台管理 */}
          <div>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">后台管理</h2>
            <div className="space-y-2">
              <ToolLink to="/dashboard" icon="&#x1F4C8;" label="数据看板" desc="Token消耗、生产统计、知识库健康" />
              <ToolLink to="/accounts"  icon="&#x1F4F1;" label="账号管理" desc="多平台账号绑定和分组" />
              <ToolLink to="/settings"  icon="&#x2699;&#xFE0F;" label="系统设置" desc="模型配置、租户管理" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolLink({ to, icon, label, desc }: { to: string; icon: string; label: string; desc: string }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 px-4 py-3 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:shadow-sm transition-all group"
    >
      <span className="text-xl w-8 text-center shrink-0" dangerouslySetInnerHTML={{ __html: icon }} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-gray-700 group-hover:text-blue-600 transition-colors">{label}</div>
        <div className="text-xs text-gray-400 truncate">{desc}</div>
      </div>
    </Link>
  );
}
