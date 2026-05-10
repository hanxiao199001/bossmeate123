/**
 * PR #125 V2 期刊详情页（5-16）— 修 audit 页 [👁️ 查看] 跳首页 bug。
 *
 * 复用:
 * - GET /journals/:id (PR #115 修支持 user 读全局共享 row)
 * - POST /admin/journals/:id/reverify (PR #107)
 * - dataSourceLabel (PR #124 i18n)
 * - PR #117 website 仅在合法 URL 时显示模式
 *
 * chart 走 C 路径（数据表格无 SVG）— cap 紧；可视化在 ContentDetailPage 里。
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";
import { dataSourceLabel } from "../utils/i18n";

interface JournalDetail {
  id: string;
  name: string;
  nameEn: string | null;
  issn: string | null;
  publisher: string | null;
  discipline: string | null;
  partition: string | null;
  casPartition: string | null;
  impactFactor: number | null;
  foundingYear: number | null;
  country: string | null;
  website: string | null;
  dataSource: string | null;
  sourceUrl: string | null;
  confidence: number | null;
  lastVerifiedAt: string | null;
  ifHistory: { data?: Array<{ year: number; if: number }> } | null;
  carIndexHistory: { data?: Array<{ year: number; carIndex: number }> } | null;
  publicationStats: { annualVolumeHistory?: Array<{ year: number; count: number }> } | null;
  citingJournalsTop10: { topJournals?: Array<{ name: string; percent: number; count?: number }> } | null;
}

export default function JournalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuthStore();
  const [j, setJ] = useState<JournalDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reverifying, setReverifying] = useState(false);

  const load = () => {
    if (!id) return;
    setErr(null);
    api.get<JournalDetail>(`/journals/${id}`)
      .then((r) => setJ((r as any).data ?? r))
      .catch((e) => setErr((e as Error).message || "加载失败"));
  };
  useEffect(load, [id]);

  const reverify = async () => {
    if (!id || reverifying) return;
    setReverifying(true);
    try { await api.post(`/admin/journals/${id}/reverify`, {}); load(); }
    catch (e) { setErr((e as Error).message || "重新验证失败"); }
    finally { setReverifying(false); }
  };

  const exportCsv = () => {
    if (!j) return;
    const fields: Array<[string, string | number | null]> = [
      ["name", j.name], ["name_en", j.nameEn], ["issn", j.issn], ["publisher", j.publisher],
      ["discipline", j.discipline], ["partition", j.partition], ["cas_partition", j.casPartition],
      ["impact_factor", j.impactFactor], ["founding_year", j.foundingYear], ["country", j.country],
      ["website", j.website], ["data_source", j.dataSource], ["source_url", j.sourceUrl],
      ["confidence", j.confidence], ["last_verified_at", j.lastVerifiedAt],
    ];
    const csv = fields.map(([k, v]) => `${k},"${(v ?? "").toString().replace(/"/g, '""')}"`).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${j.name}-元数据.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  if (err) return <div className="p-6 text-red-600">❌ {err} <Link to="/admin/journals/audit" className="text-blue-600 underline ml-2">返回</Link></div>;
  if (!j) return <div className="p-6 text-gray-400">⏳ 加载中...</div>;

  const dsBadge = j.dataSource ? (dataSourceLabel[j.dataSource] ?? j.dataSource) : "❓ —";
  const showWebsite = j.website && /^https?:\/\//i.test(j.website);
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <Link to="/admin/journals/audit" className="text-sm text-blue-600 hover:underline">← 返回审计页</Link>
        <div className="flex gap-2">
          {isAdmin && (
            <button onClick={reverify} disabled={reverifying} className="px-3 py-1.5 text-sm rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50">
              {reverifying ? "⏳ 验证中..." : "🔄 重新验证"}
            </button>
          )}
          <button onClick={exportCsv} className="px-3 py-1.5 text-sm rounded bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100">📥 导出元数据 CSV</button>
        </div>
      </div>

      <section className="border rounded-lg p-5 bg-white">
        <h1 className="text-2xl font-bold text-gray-900">{j.name}</h1>
        {j.nameEn && <div className="text-sm text-gray-500 mt-1">{j.nameEn}</div>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-sm">
          <Field label="影响因子" value={j.impactFactor && j.impactFactor > 0 ? j.impactFactor : null} />
          <Field label="JCR 分区" value={j.partition} />
          <Field label="中科院分区" value={j.casPartition} />
          <Field label="ISSN" value={j.issn} />
          <Field label="出版社" value={j.publisher} />
          <Field label="学科" value={j.discipline} />
          <Field label="创刊年" value={j.foundingYear} />
          <Field label="国家" value={j.country} />
        </div>
        <div className="mt-4 pt-4 border-t flex flex-wrap items-center gap-3 text-sm">
          <span className="px-2 py-1 rounded bg-gray-50 border">{dsBadge}</span>
          {j.confidence !== null && <span className="text-gray-600">可信度 <strong>{j.confidence}</strong></span>}
          {j.lastVerifiedAt && <span className="text-gray-500">最后验证 {new Date(j.lastVerifiedAt).toLocaleString("zh-CN")}</span>}
        </div>
        <div className="mt-3 flex flex-col gap-1 text-sm">
          {j.sourceUrl && <a href={j.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate">🔗 数据源验证: {j.sourceUrl}</a>}
          {showWebsite && <a href={j.website!} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate">🌐 期刊官网: {j.website}</a>}
        </div>
      </section>

      {(() => {
        const ifRows = (j.ifHistory?.data ?? []).map((d) => [d.year, d.if] as Array<string | number>);
        const carRows = (j.carIndexHistory?.data ?? []).map((d) => [d.year, d.carIndex] as Array<string | number>);
        const pubRows = (j.publicationStats?.annualVolumeHistory ?? []).map((d) => [d.year, d.count] as Array<string | number>);
        const citingRows = (j.citingJournalsTop10?.topJournals ?? []).map((d) => [d.name, `${d.percent}%`, d.count ?? "—"] as Array<string | number>);
        const hasAnyChartData = ifRows.length + carRows.length + pubRows.length + citingRows.length > 0;
        if (!hasAnyChartData) {
          return (
            <div className="border-l-4 border-amber-400 bg-amber-50 p-4 rounded text-sm text-amber-900">
              🟠 该期刊历史 chart 数据扩展中（中文期刊 LetPub/OpenAlex 覆盖率有限，CNKI/万方接入计划中）。基本元数据已多源核验，可放心引用。
            </div>
          );
        }
        return <>
          {ifRows.length > 0 && <DataTable title="📈 近 10 年 IF 历史" rows={ifRows} cols={["年份", "IF"]} />}
          {carRows.length > 0 && <DataTable title="📊 中国作者占比 (CAR)" rows={carRows} cols={["年份", "CAR 指数"]} />}
          {pubRows.length > 0 && <DataTable title="📰 年发文量历史" rows={pubRows} cols={["年份", "发文量"]} />}
          {citingRows.length > 0 && <DataTable title="🔗 引用 Top 10 期刊" rows={citingRows} cols={["期刊", "占比", "次数"]} />}
        </>;
      })()}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div><div className="text-xs text-gray-500">{label}</div><div className="text-gray-900 font-medium">{value ?? "—"}</div></div>
  );
}

function DataTable({ title, rows, cols }: { title: string; rows: Array<Array<string | number>>; cols: string[] }) {
  return (
    <section className="border rounded-lg bg-white">
      <header className="px-4 py-2 border-b text-sm font-semibold text-gray-700">{title}</header>
      <table className="w-full text-sm"><thead><tr className="bg-gray-50">{cols.map((c) => <th key={c} className="text-left px-4 py-2 font-medium text-gray-600">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t">{r.map((v, j) => <td key={j} className="px-4 py-2 text-gray-700">{v}</td>)}</tr>)}</tbody></table>
    </section>
  );
}
