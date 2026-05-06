/**
 * PR Q.2：内容模板管理（admin UI list + select）。
 *
 * D1 简化版：列出全局 + 自定义模板，每行显示风格 / css 主题；
 * "应用到账号" 弹窗 → 选 platform_account → PATCH /accounts/:id { templateId }。
 * D2 后会加预览 iframe + DB-driven template-registry。
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { toast } from "../components/Toast";

interface ContentTemplate {
  id: string;
  tenantId: string | null;
  name: string;
  displayName: string;
  styleTag: string;
  sectionCount: number;
  structureJson: { sections?: string[]; hook_style?: string; cta_style?: string };
  promptOverrides: { tone?: string; sentence_length?: string; emoji_use?: string; number_emphasis?: string };
  chartConfig: { types?: string[]; count?: number; colors?: string; size?: string };
  cssTheme: { font_family?: string; palette?: { primary?: string; accent?: string; bg?: string }; spacing?: string };
  imageStrategy: { hero_source?: string; section_icons?: string; ai_generation?: boolean };
  isDefault: boolean;
  createdAt: string;
}

interface PlatformAccount {
  id: string;
  platform: string;
  accountName: string;
  templateId: string | null;
}

const STYLE_LABELS: Record<string, { label: string; color: string }> = {
  academic: { label: "学术权威", color: "bg-blue-100 text-blue-700" },
  marketing: { label: "营销转化", color: "bg-orange-100 text-orange-700" },
  popular: { label: "科普轻松", color: "bg-cyan-100 text-cyan-700" },
  vertical: { label: "行业垂直", color: "bg-purple-100 text-purple-700" },
};

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [accounts, setAccounts] = useState<PlatformAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [bindingTemplate, setBindingTemplate] = useState<ContentTemplate | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<ContentTemplate[]>("/content-templates"),
      api.get<PlatformAccount[]>("/accounts"),
    ])
      .then(([tplRes, accRes]) => {
        setTemplates(tplRes.data || []);
        setAccounts(accRes.data || []);
      })
      .catch((err) => toast.error("加载失败：" + (err instanceof Error ? err.message : "未知")))
      .finally(() => setLoading(false));
  }, []);

  const applyToAccount = async (accountId: string) => {
    if (!bindingTemplate) return;
    try {
      await api.patch(`/accounts/${accountId}`, { templateId: bindingTemplate.id });
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, templateId: bindingTemplate.id } : a)),
      );
      toast.success(`已绑定模板 ${bindingTemplate.displayName}`);
      setBindingTemplate(null);
    } catch (err) {
      toast.error("绑定失败：" + (err instanceof Error ? err.message : "未知"));
    }
  };

  if (loading) return <div className="p-6 text-gray-500">加载中…</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/dashboard" className="text-blue-600 hover:text-blue-700 text-sm">← Dashboard</Link>
          <h1 className="text-lg font-bold">内容模板</h1>
          <span className="text-xs text-gray-400">PR Q.2 · D1 list + select</span>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6">
        <p className="text-sm text-gray-600 mb-4">
          全局内置模板（tenant_id NULL）所有租户共享。"应用到账号" 把该模板绑到平台账号 → 该账号发布的图文走该模板。
          预览 + 自定义模板编辑器在 D2 sprint 完成。
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => {
            const style = STYLE_LABELS[t.styleTag] || { label: t.styleTag, color: "bg-gray-100 text-gray-700" };
            const isGlobal = t.tenantId === null;
            const boundCount = accounts.filter((a) => a.templateId === t.id).length;
            const primary = t.cssTheme?.palette?.primary || "#9CA3AF";
            return (
              <div key={t.id} className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-2"
                style={{ borderLeft: `4px solid ${primary}` }}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-base">{t.displayName}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${style.color}`}>{style.label}</span>
                </div>
                <div className="text-xs text-gray-500 flex flex-wrap gap-2">
                  <span>📑 {t.sectionCount} 区块</span>
                  <span>📊 {t.chartConfig?.count ?? "?"} 图表</span>
                  {t.promptOverrides?.emoji_use && <span>😀 {t.promptOverrides.emoji_use}</span>}
                  {isGlobal && <span className="text-blue-600">🌐 系统</span>}
                  {t.isDefault && <span className="text-green-600 font-medium">⭐ 默认</span>}
                  {boundCount > 0 && <span className="text-green-600">已绑 {boundCount}</span>}
                </div>
                <div className="text-xs text-gray-400">
                  <code className="bg-gray-100 px-1 rounded">{t.name}</code>
                </div>
                {/* PR Q.2 D1：缩略图占位（D3 渲染真预览）*/}
                <div className="h-16 rounded bg-gray-50 flex items-center justify-center text-xs text-gray-400">
                  预览缩略图（D3 渲染）
                </div>
                <button
                  onClick={() => setBindingTemplate(t)}
                  className="mt-1 px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                >
                  应用到账号
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 绑定弹窗 */}
      {bindingTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setBindingTemplate(null)}>
          <div className="bg-white rounded-lg p-6 max-w-md w-full m-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-3">绑定到 {bindingTemplate.displayName}</h3>
            {accounts.length === 0 ? (
              <p className="text-sm text-gray-500">没有平台账号。先去 <Link to="/accounts" className="text-blue-600">账号管理</Link> 添加。</p>
            ) : (
              <ul className="space-y-2 max-h-80 overflow-y-auto">
                {accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded">
                    <span>
                      <span className="text-xs text-gray-500">{a.platform}</span>
                      <span className="ml-2">{a.accountName}</span>
                      {a.templateId === bindingTemplate.id && <span className="ml-2 text-xs text-green-600">已绑</span>}
                    </span>
                    <button
                      onClick={() => applyToAccount(a.id)}
                      disabled={a.templateId === bindingTemplate.id}
                      className="px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
                    >
                      {a.templateId === bindingTemplate.id ? "已绑" : "绑定"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => setBindingTemplate(null)}
              className="mt-4 px-4 py-2 text-sm rounded bg-gray-100 text-gray-700 w-full"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
