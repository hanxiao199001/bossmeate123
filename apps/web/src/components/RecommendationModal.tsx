/**
 * P3 AI 推荐 modal（5-11 frontend Day 2）。
 *
 * 显示两 section:
 * - 🤖 推荐期刊 (top 5 + 1 句理由 + 点击跳 /journals/:id 详情)
 * - 💡 推荐主题 (top 5 + 1 句理由 + 点击复制到剪贴板)
 *
 * 接 PR #114 backend:
 * - GET /api/v1/recommend/journals?topic=&limit=5
 * - GET /api/v1/recommend/topics?journalId=&limit=5
 *
 * cache 30 min in-backend，前端反复打开不重 LLM。
 */
import { useEffect, useState } from "react";
// PR #117 fix Bug 1：去掉 Link import（无 /journals/:id 路由）
import { api } from "../utils/api";

interface JournalRec {
  id: string;
  name: string;
  nameEn: string | null;
  issn: string | null;
  impactFactor: number | null;
  partition: string | null;
  confidence: number | null;
  reason: string;
}

interface TopicRec {
  topic: string;
  reason: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 可选：已选 journalId 时只显主题推荐；缺 journalId 时只显期刊推荐 */
  initialJournalId?: string;
  /** 可选：用户在主输入框已写的 topic 串，传入用于期刊推荐 */
  initialTopic?: string;
}

export default function RecommendationModal({ open, onClose, initialJournalId, initialTopic }: Props) {
  const [tab, setTab] = useState<"journals" | "topics">(initialJournalId ? "topics" : "journals");
  const [journals, setJournals] = useState<JournalRec[] | null>(null);
  const [topics, setTopics] = useState<TopicRec[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [topic, setTopic] = useState(initialTopic ?? "");
  const [journalId, setJournalId] = useState(initialJournalId ?? "");

  useEffect(() => {
    if (!open) return;
    setErr(null);
    if (tab === "journals") {
      setLoading(true);
      const q = topic.trim() ? `?topic=${encodeURIComponent(topic.trim())}&limit=5` : "?limit=5";
      api
        .get<{ items: JournalRec[] }>(`/recommend/journals${q}`)
        .then((r) => setJournals(r.data?.items ?? []))
        .catch((e) => setErr((e as Error).message || "加载失败"))
        .finally(() => setLoading(false));
    } else {
      setLoading(true);
      const q = journalId.trim() ? `?journalId=${encodeURIComponent(journalId.trim())}&limit=5` : "?limit=5";
      api
        .get<{ items: TopicRec[] }>(`/recommend/topics${q}`)
        .then((r) => setTopics(r.data?.items ?? []))
        .catch((e) => setErr((e as Error).message || "加载失败"))
        .finally(() => setLoading(false));
    }
  }, [open, tab, topic, journalId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">🤖 AI 智能推荐</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        {/* Tabs */}
        <div className="px-6 pt-3 border-b">
          <div className="flex gap-1">
            <button
              onClick={() => setTab("journals")}
              className={`px-3 py-1.5 text-sm rounded-t font-medium ${
                tab === "journals" ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600" : "text-gray-500 hover:text-gray-700"
              }`}
            >🤖 推荐期刊</button>
            <button
              onClick={() => setTab("topics")}
              className={`px-3 py-1.5 text-sm rounded-t font-medium ${
                tab === "topics" ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600" : "text-gray-500 hover:text-gray-700"
              }`}
            >💡 推荐主题</button>
          </div>
        </div>

        {/* 输入参数 */}
        <div className="px-6 py-3 border-b bg-gray-50">
          {tab === "journals" ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 shrink-0">主题（可选）:</span>
              <input
                type="text" value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如: AI 在医学诊断中的应用"
                className="flex-1 text-sm px-3 py-1.5 border rounded"
              />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 shrink-0">期刊 ID（可选）:</span>
              <input
                type="text" value={journalId}
                onChange={(e) => setJournalId(e.target.value)}
                placeholder="UUID（缺则按用户历史推主题）"
                className="flex-1 text-sm px-3 py-1.5 border rounded"
              />
            </div>
          )}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-center py-12 text-gray-400">⏳ AI 推荐中...（可能 5-15s）</div>}
          {err && <div className="text-center py-8 text-red-600 text-sm">❌ {err}</div>}
          {!loading && !err && tab === "journals" && (journals?.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">无候选期刊（DB confidence 全 &lt; 70）</div>
          ) : (
            <ul className="space-y-3">
              {(journals ?? []).map((j) => (
                <li key={j.id} className="border rounded-lg p-3 hover:bg-blue-50/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="font-medium">
                        {/* PR #117 fix Bug 1：项目无 /journals/:id 路由，去 link 防跳首页（reason + IF 给 user 决策足够）*/}
                        <span className="text-gray-900">{j.name}</span>
                        {j.nameEn && <span className="text-xs text-gray-400 ml-2">{j.nameEn}</span>}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {j.partition && <span className="mr-2">{j.partition}</span>}
                        {j.impactFactor !== null && <span className="mr-2">IF {j.impactFactor}</span>}
                        {j.issn && <span className="mr-2">ISSN {j.issn}</span>}
                        {j.confidence !== null && <span className="text-green-700">conf {j.confidence}</span>}
                      </div>
                      <div className="text-sm text-gray-700 mt-1">{j.reason}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ))}
          {!loading && !err && tab === "topics" && (topics?.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">无主题推荐</div>
          ) : (
            <ul className="space-y-3">
              {(topics ?? []).map((t, i) => (
                <li key={i} className="border rounded-lg p-3 hover:bg-blue-50/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="font-medium text-gray-900">{t.topic}</div>
                      <div className="text-sm text-gray-500 mt-1">{t.reason}</div>
                    </div>
                    <button
                      onClick={() => navigator.clipboard.writeText(t.topic)}
                      className="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded shrink-0"
                      title="复制主题到剪贴板"
                    >📋 复制</button>
                  </div>
                </li>
              ))}
            </ul>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t bg-gray-50 text-xs text-gray-500">
          backend cache 30 分钟 · 反复打开不重 LLM 调用
        </div>
      </div>
    </div>
  );
}
