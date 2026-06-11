/**
 * PR 2（5-9 早）：/admin/journals/audit 期刊数据可信度审计页（只读 v1）。
 *
 * - 顶部 6 卡片：总数 / 高(≥80) / 中(50-79) / 低(<50) / AI 编造 / 从未验证
 * - 列表 confidence ASC NULLS FIRST（NULL 排队首，user 一眼看出未验证 row）
 * - filter：data_source 多选 / confidence range / 验证时间 / 期刊名搜索
 * - CSV 导出：当前筛选结果转 CSV download（client-side join）
 * - 操作列 [👁️ 查看] (跳 journal detail) / [🔄 重新验证]（PR 3 enricher 接入后真实现）
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { dataSourceLabel, journalAuditFieldLabel } from "../utils/i18n";
import PageHeader from "../components/ui/PageHeader";

interface AuditStats {
  total: number;
  highConfidence: number;
  midConfidence: number;
  lowConfidence: number;
  aiFabricated: number;
  neverVerified: number;
}

interface AuditItem {
  id: string;
  name: string;
  nameEn: string | null;
  issn: string | null;
  dataSource: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  lastVerifiedAt: string | null;
  updatedAt: string;
}

const DATA_SOURCE_COLOR: Record<string, string> = {
  manual_seed_2024: "bg-blue-100 text-blue-700",
  multi_source_verified: "bg-green-100 text-green-700",
  letpub_only: "bg-sky-100 text-sky-700",
  token_fuzzy: "bg-yellow-100 text-yellow-700",
  ai_fabricated: "bg-red-100 text-red-700",
  legacy_unknown: "bg-gray-100 text-gray-600",
};

const DATA_SOURCE_OPTIONS = Object.keys(DATA_SOURCE_COLOR).map((value) => ({
  value,
  label: dataSourceLabel[value] ?? value,
  color: DATA_SOURCE_COLOR[value],
}));

function dataSourceBadge(ds: string | null): { label: string; color: string } {
  if (!ds) return { label: "❓ —", color: "bg-gray-100 text-gray-500" };
  return {
    label: dataSourceLabel[ds] ?? ds,
    color: DATA_SOURCE_COLOR[ds] ?? "bg-gray-100 text-gray-600",
  };
}

function confidenceBadge(c: number | null): { color: string; text: string } {
  if (c === null) return { color: "bg-gray-100 text-gray-500", text: "❓" };
  if (c < 50) return { color: "bg-red-100 text-red-700", text: String(c) };
  if (c < 80) return { color: "bg-yellow-100 text-yellow-700", text: String(c) };
  return { color: "bg-green-100 text-green-700", text: String(c) };
}

function formatTime(s: string | null): string {
  if (!s) return "从未";
  const d = new Date(s);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "今天";
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export default function AdminJournalsAuditPage() {
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // filter state
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [confidenceMin, setConfidenceMin] = useState<string>("");
  const [confidenceMax, setConfidenceMax] = useState<string>("");
  const [verified, setVerified] = useState<string>("");
  const [q, setQ] = useState<string>("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", "100");
    if (selectedSources.size > 0) p.set("dataSources", Array.from(selectedSources).join(","));
    if (confidenceMin) p.set("confidenceMin", confidenceMin);
    if (confidenceMax) p.set("confidenceMax", confidenceMax);
    if (verified) p.set("verified", verified);
    if (q.trim()) p.set("q", q.trim());
    return p.toString();
  }, [page, selectedSources, confidenceMin, confidenceMax, verified, q]);

  useEffect(() => {
    api
      .get<AuditStats>("/admin/journals/audit/stats")
      .then((r) => r.data && setStats(r.data))
      .catch((err) => console.error("audit stats 加载失败", err));
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .get<{ items: AuditItem[]; total: number }>(`/admin/journals/audit?${queryString}`)
      .then((r) => {
        if (r.data) {
          setItems(r.data.items);
          setTotal(r.data.total);
        }
      })
      .catch((err) => console.error("audit list 加载失败", err))
      .finally(() => setLoading(false));
  }, [queryString]);

  const totalPages = Math.ceil(total / 100);

  const toggleSource = (v: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
    setPage(1);
  };

  const exportCsv = () => {
    const headers = ["期刊名", "ISSN", "data_source", "confidence", "last_verified_at", "source_url"];
    const rows = items.map((it) =>
      [
        `"${(it.name || "").replace(/"/g, '""')}"`,
        it.issn || "",
        it.dataSource || "",
        it.confidence ?? "",
        it.lastVerifiedAt || "",
        it.sourceUrl || "",
      ].join(","),
    );
    const csv = "﻿" + [headers.join(","), ...rows].join("\n"); // BOM 让 Excel 识别 UTF-8
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `journals-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-[#F6F7F9]">
      {/* 6-11 施工包C2-a (审计2.5): 手写顶栏已删, 导航走 MainLayout 侧边栏; 标题+导出按钮迁到内容区顶部 */}
      <div className="max-w-7xl mx-auto py-6 px-6">
        <PageHeader
          title="期刊数据审计"
          actions={
            <button
              onClick={exportCsv}
              className="px-3 py-1.5 text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:border-slate-300 rounded-lg transition-colors"
              title="导出当前筛选结果为 CSV"
            >
              导出 CSV
            </button>
          }
        />
        {/* 6 个统计卡片 */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
            <Card label="总期刊数" value={stats.total} color="text-gray-900" />
            <Card label="🟢 高可信 (≥80)" value={stats.highConfidence} color="text-green-700" />
            <Card label="🟡 中可信 (50~79)" value={stats.midConfidence} color="text-yellow-700" />
            <Card label="🔴 低可信 (<50)" value={stats.lowConfidence} color="text-red-700" />
            <Card label="⚠️ AI 编造" value={stats.aiFabricated} color="text-red-700" />
            <Card label="❓ 从未验证" value={stats.neverVerified} color="text-gray-500" />
          </div>
        )}

        {/* PR #111：全局横幅（高/中可信 ≥1 时不显示，提示 user enricher 状态） */}
        {stats && stats.total > 0 && stats.highConfidence + stats.midConfidence === 0 && (
          <div className="mb-4 rounded-xl border-2 border-yellow-300 bg-yellow-50 px-4 py-3">
            <div className="flex items-start gap-2 text-sm text-yellow-900">
              <span className="text-lg shrink-0">⚠️</span>
              <span>
                <strong>当前 {stats.total} 期刊均未经 enricher 验证</strong>（可信度 = NULL）。
                等明早 03:00 cron 自动跑，或点单行 <kbd className="px-1 rounded bg-yellow-100 border border-yellow-200 font-mono text-xs">🔄 重新验证</kbd> 立即触发 4 源验证。
              </span>
            </div>
          </div>
        )}

        {/* Filter */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-1.5">
              {DATA_SOURCE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => toggleSource(o.value)}
                  className={`text-xs px-2 py-1 rounded ${
                    selectedSources.has(o.value)
                      ? `${o.color} ring-2 ring-offset-1`
                      : "bg-gray-50 text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">可信度:</span>
              <input
                type="number" min="0" max="100" placeholder="min"
                value={confidenceMin}
                onChange={(e) => { setConfidenceMin(e.target.value); setPage(1); }}
                className="w-16 px-2 py-1 border rounded"
              />
              <span>—</span>
              <input
                type="number" min="0" max="100" placeholder="max"
                value={confidenceMax}
                onChange={(e) => { setConfidenceMax(e.target.value); setPage(1); }}
                className="w-16 px-2 py-1 border rounded"
              />
            </div>
            <select
              value={verified}
              onChange={(e) => { setVerified(e.target.value); setPage(1); }}
              className="text-xs px-2 py-1 border rounded"
            >
              <option value="">验证时间不限</option>
              <option value="never">从未验证</option>
              <option value="older_than_30d">30 天前</option>
              <option value="within_30d">30 天内</option>
            </select>
            <input
              type="text" placeholder="期刊名搜索"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
              className="text-xs px-2 py-1 border rounded flex-1 min-w-[180px]"
            />
          </div>
        </div>

        {/* 列表 */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="hidden md:grid grid-cols-12 gap-3 px-4 py-2.5 bg-gray-50 border-b text-xs font-medium text-gray-500">
            <div className="col-span-3">期刊名</div>
            <div className="col-span-2">{journalAuditFieldLabel.data_source}</div>
            <div className="col-span-1 text-center">{journalAuditFieldLabel.confidence}</div>
            <div className="col-span-2 text-center">{journalAuditFieldLabel.last_verified}</div>
            <div className="col-span-2">{journalAuditFieldLabel.source_url}</div>
            <div className="col-span-2 text-center">操作</div>
          </div>
          {loading ? (
            <div className="text-center py-12 text-gray-400">加载中...</div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-gray-400">无匹配期刊</div>
          ) : (
            items.map((it) => {
              const ds = dataSourceBadge(it.dataSource);
              const cf = confidenceBadge(it.confidence);
              return (
                <div
                  key={it.id}
                  className="grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-3 px-4 py-3 border-b border-gray-100 items-center hover:bg-blue-50/30"
                >
                  <div className="col-span-3 text-sm">
                    <div className="font-medium text-gray-900 truncate" title={it.name}>{it.name}</div>
                    {it.nameEn && <div className="text-xs text-gray-400 truncate">{it.nameEn}</div>}
                  </div>
                  <div className="col-span-2">
                    <span className={`inline-block text-[11px] px-2 py-0.5 rounded ${ds.color}`}>{ds.label}</span>
                  </div>
                  <div className="col-span-1 text-center">
                    <span className={`inline-block text-xs px-2 py-0.5 rounded font-medium ${cf.color}`}>{cf.text}</span>
                  </div>
                  <div className="col-span-2 text-center text-xs text-gray-600">{formatTime(it.lastVerifiedAt)}</div>
                  <div className="col-span-2 text-xs">
                    {it.sourceUrl ? (
                      <a href={it.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate block">
                        {it.sourceUrl.slice(0, 40)}
                      </a>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </div>
                  <div className="col-span-2 flex items-center justify-center gap-2">
                    <Link
                      to={`/journals/${it.id}`}
                      className="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded"
                    >
                      👁️ 查看
                    </Link>
                    <ReverifyButton id={it.id} onDone={() => {
                      // 重新拉列表 + stats
                      api.get<{ items: AuditItem[]; total: number }>(`/admin/journals/audit?${queryString}`)
                        .then((r) => r.data && (setItems(r.data.items), setTotal(r.data.total)));
                      api.get<AuditStats>("/admin/journals/audit/stats")
                        .then((r) => r.data && setStats(r.data));
                    }} />
                  </div>
                </div>
              );
            })
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t text-sm">
              <span className="text-gray-500">第 {page}/{totalPages} 页 · 共 {total} 条</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                        className="px-2.5 py-1 border rounded disabled:opacity-50 hover:bg-gray-50">上一页</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                        className="px-2.5 py-1 border rounded disabled:opacity-50 hover:bg-gray-50">下一页</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

/** PR #107（5-9 治理 PR 3）：单期刊重新验证按钮（接 POST /admin/journals/:id/reverify）。 */
function ReverifyButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const handler = async () => {
    setLoading(true); setErr(null);
    try {
      const r = await api.post<{ confidence: number | null; dataSource: string | null }>(
        `/admin/journals/${id}/reverify`, {},
      );
      if (r.data) onDone();
    } catch (e) {
      setErr((e as Error).message || "失败");
    } finally {
      setLoading(false);
    }
  };
  return (
    <button
      onClick={handler}
      disabled={loading}
      className={`text-xs px-2 py-1 rounded ${loading ? "text-gray-400" : "text-blue-600 hover:bg-blue-50"}`}
      title={err || "4 源 enricher 重新验证（同步，可能 30s）"}
    >
      {loading ? "⏳ 验证中..." : "🔄 重新验证"}
    </button>
  );
}
