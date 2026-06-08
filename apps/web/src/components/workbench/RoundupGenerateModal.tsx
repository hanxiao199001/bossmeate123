/**
 * PR-I4 — "多刊盘点" 生成 modal.
 *
 * 学同行 (顾老论文说) 风格的多刊盘点长文: 选学科 + 核心目录 + 数量 + 读者画像,
 * 自动按录用率挑对普通作者友好的刊, 一次性生成整篇盘点。
 *
 * POST /admin/roundup { discipline?, catalog?, count?, audience }  (同步返回)
 *   → { code:"OK", data:{ contentId, title } }
 * 成功后 onComplete(contentId) → 父组件跳 draft tab + 选中。
 */
import { useState } from "react";
import { api } from "../../utils/api";

type Catalog = "" | "pku-core" | "cssci" | "cssci-ext" | "cscd" | "sci-core";

const DISCIPLINE_OPTIONS = [
  { value: "", label: "全部学科" },
  { value: "medicine", label: "医学" },
  { value: "agriculture", label: "农业" },
  { value: "engineering", label: "工程" },
  { value: "education", label: "教育" },
  { value: "biology", label: "生物" },
  { value: "economics", label: "经济" },
  { value: "psychology", label: "心理" },
  { value: "law", label: "法学" },
];

const CATALOG_OPTIONS: { value: Catalog; label: string }[] = [
  { value: "", label: "不限 (全部核心)" },
  { value: "pku-core", label: "北大核心" },
  { value: "cssci", label: "CSSCI" },
  { value: "cssci-ext", label: "CSSCI 扩展" },
  { value: "cscd", label: "CSCD" },
  { value: "sci-core", label: "科技核心" },
];

const COUNT_OPTIONS = [3, 5, 8];

interface RoundupGenerateModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (contentId: string) => void;
}

export default function RoundupGenerateModal({ open, onClose, onComplete }: RoundupGenerateModalProps) {
  const [discipline, setDiscipline] = useState("");
  const [catalog, setCatalog] = useState<Catalog>("");
  const [count, setCount] = useState(5);
  const [audience, setAudience] = useState("普通院校教师");
  const [phase, setPhase] = useState<"idle" | "generating" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;
  const generating = phase === "generating";

  const handleClose = () => {
    if (generating) return; // 生成中不允许关 (同步请求, 很快)
    setPhase("idle");
    setError(null);
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);
    setPhase("generating");
    try {
      const res = await api.post("/admin/roundup", {
        discipline: discipline || undefined,
        catalog: catalog || undefined,
        count,
        audience: audience.trim() || "普通院校教师",
      });
      const data = (res.data as any)?.data ?? res.data;
      const contentId = data?.contentId;
      if (!contentId) throw new Error("无 contentId 返回");
      setPhase("idle");
      onComplete(contentId);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "盘点生成失败");
      setPhase("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-bold text-gray-900">📚 多刊盘点</h2>
          <button onClick={handleClose} disabled={generating}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none disabled:opacity-40">&times;</button>
        </div>
        <p className="text-xs text-gray-400 mb-4">按录用率挑对普通作者友好的刊，生成一篇同行盘点风格长文。</p>

        <div className="space-y-4">
          {/* 学科 + 核心目录 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">学科方向</label>
              <select value={discipline} onChange={(e) => setDiscipline(e.target.value)} disabled={generating}
                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white disabled:opacity-50">
                {DISCIPLINE_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">核心目录</label>
              <select value={catalog} onChange={(e) => setCatalog(e.target.value as Catalog)} disabled={generating}
                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white disabled:opacity-50">
                {CATALOG_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>

          {/* 数量 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">盘点期刊数</label>
            <div className="flex gap-1.5">
              {COUNT_OPTIONS.map((n) => (
                <button key={n} onClick={() => !generating && setCount(n)} disabled={generating}
                  className={`px-4 py-1.5 text-sm rounded-lg border transition-colors ${
                    count === n ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
                  {n} 本
                </button>
              ))}
            </div>
          </div>

          {/* 读者画像 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">读者画像</label>
            <input type="text" value={audience} onChange={(e) => setAudience(e.target.value)} disabled={generating}
              placeholder="如: 普通院校教师 / 研究生 / 评职称作者"
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm disabled:opacity-50" />
          </div>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        {generating && (
          <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
            正在生成盘点长文，约 10-20 秒...
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleClose} disabled={generating}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 disabled:opacity-40">关闭</button>
          <button onClick={handleSubmit} disabled={generating}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              generating ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
            }`}>
            {generating ? "生成中..." : "生成盘点"}
          </button>
        </div>
      </div>
    </div>
  );
}
