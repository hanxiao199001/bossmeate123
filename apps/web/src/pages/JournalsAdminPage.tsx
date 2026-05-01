/**
 * Day 2 PR B: 期刊 admin 管理页 v1（/admin/journals）。
 *
 * v1 范围：
 *   - 列表 + 筛选（discipline / keyword / NULL-only enrichment 覆盖率）
 *   - 8 个 jsonb 字段以彩色 dot 显示覆盖率（灰=NULL / 绿=已 enrich）
 *   - 行点击 inline expand → 9 字段白名单 edit form
 *   - 每行 [🔄 重新 enrich] → POST /journals/:id/enrich → toast jobId
 *
 * v2 计划：批量 select + 批量 enrich，jsonb 字段编辑器（v1 readonly）
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useJournalsAdmin, type AdminJournal, type PatchPayload } from "../hooks/useJournalsAdmin";

// 8 个 enrichment 产生的 jsonb 字段，admin 页用来观察覆盖率
const COVERAGE_FIELDS = [
  { key: "ifHistory", label: "IF 历史" },
  { key: "carIndexHistory", label: "CAR" },
  { key: "publicationStats", label: "发文" },
  { key: "jcrFull", label: "JCR" },
  { key: "citingJournalsTop10", label: "引用 Top10" },
  { key: "scopeDetails", label: "收稿范围" },
  { key: "publicationCosts", label: "版面费" },
  { key: "topInstitutions", label: "活跃机构" },
] as const;

function isFilled(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function coverageRate(j: AdminJournal): number {
  const filled = COVERAGE_FIELDS.filter((f) => isFilled((j as any)[f.key])).length;
  return filled / COVERAGE_FIELDS.length;
}

export default function JournalsAdminPage() {
  const { items, total, loading, filters, setFilters, patchJournal, reEnrich } = useJournalsAdmin();
  const [openId, setOpenId] = useState<string | null>(null);
  const [nullOnly, setNullOnly] = useState(false);

  // discipline 选项 — 从当前 items 派生（避免再发一次 /journals/meta/disciplines）
  const disciplines = useMemo(() => {
    const s = new Set<string>();
    items.forEach((j) => j.discipline && s.add(j.discipline));
    return Array.from(s).sort();
  }, [items]);

  const filtered = useMemo(() => {
    if (!nullOnly) return items;
    return items.filter((j) => coverageRate(j) < 1);
  }, [items, nullOnly]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-gray-500 hover:text-gray-700 text-sm">← 返回</Link>
            <h1 className="text-xl font-bold text-gray-900">期刊管理</h1>
            <span className="text-sm text-gray-500">共 {total} 条</span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-wrap gap-3 items-center">
          <select
            value={filters.discipline ?? ""}
            onChange={(e) => setFilters({ ...filters, discipline: e.target.value || undefined })}
            className="border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="">全部学科</option>
            {disciplines.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <input
            type="text"
            value={filters.keyword ?? ""}
            onChange={(e) => setFilters({ ...filters, keyword: e.target.value || undefined })}
            placeholder="期刊名 / ISSN 关键词"
            className="border border-gray-300 rounded px-3 py-2 text-sm flex-1 min-w-[200px]"
          />
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={nullOnly} onChange={(e) => setNullOnly(e.target.checked)} />
            仅看 enrich 不全
          </label>
          <span className="text-xs text-gray-400 ml-auto">
            {loading ? "加载中..." : `显示 ${filtered.length} / ${items.length}`}
          </span>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-600">
                <th className="px-4 py-3 w-1/3">期刊</th>
                <th className="px-4 py-3">学科 / 分区</th>
                <th className="px-4 py-3">IF</th>
                <th className="px-4 py-3">enrich 覆盖率</th>
                <th className="px-4 py-3 w-32">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => (
                <RowGroup
                  key={j.id}
                  j={j}
                  open={openId === j.id}
                  onToggle={() => setOpenId(openId === j.id ? null : j.id)}
                  onSave={(p) => patchJournal(j.id, p)}
                  onReEnrich={() => reEnrich(j.id)}
                />
              ))}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function RowGroup({ j, open, onToggle, onSave, onReEnrich }: {
  j: AdminJournal;
  open: boolean;
  onToggle: () => void;
  onSave: (p: PatchPayload) => Promise<boolean>;
  onReEnrich: () => void;
}) {
  return (
    <>
      <tr className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-3">
          <div className="font-medium text-gray-900">{j.name}</div>
          {j.nameEn && <div className="text-xs text-gray-500">{j.nameEn}</div>}
          {j.issn && <div className="text-xs text-gray-400">ISSN {j.issn}</div>}
        </td>
        <td className="px-4 py-3">
          <div className="text-gray-700">{j.discipline ?? "—"}</div>
          <div className="text-xs text-gray-500">{j.partition ?? "—"}</div>
        </td>
        <td className="px-4 py-3 text-gray-700">{j.impactFactor?.toFixed(2) ?? "—"}</td>
        <td className="px-4 py-3"><CoverageDots j={j} /></td>
        <td className="px-4 py-3">
          <button
            onClick={(e) => { e.stopPropagation(); onReEnrich(); }}
            className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
            title="推送 enrich 任务"
          >
            🔄 重新 enrich
          </button>
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50 border-b border-gray-200">
          <td colSpan={5} className="px-6 py-4">
            <EditForm j={j} onSave={onSave} />
          </td>
        </tr>
      )}
    </>
  );
}

function CoverageDots({ j }: { j: AdminJournal }) {
  return (
    <div className="flex gap-1">
      {COVERAGE_FIELDS.map((f) => {
        const filled = isFilled((j as any)[f.key]);
        return (
          <span
            key={f.key}
            title={`${f.label}: ${filled ? "已 enrich" : "NULL"}`}
            className={`w-2.5 h-2.5 rounded-full inline-block ${filled ? "bg-green-500" : "bg-gray-300"}`}
          />
        );
      })}
    </div>
  );
}

function EditForm({ j, onSave }: { j: AdminJournal; onSave: (p: PatchPayload) => Promise<boolean> }) {
  const [form, setForm] = useState<PatchPayload>({
    discipline: j.discipline ?? "",
    partition: j.partition ?? "",
    impactFactor: j.impactFactor ?? null,
    acceptanceRate: j.acceptanceRate ?? null,
    reviewCycle: j.reviewCycle ?? "",
    publisher: j.publisher ?? "",
    website: j.website ?? "",
    annualVolume: j.annualVolume ?? null,
    apcFee: j.apcFee ?? null,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    // 空字符串清回 null（zod nullable 允许）
    const payload: PatchPayload = {};
    (Object.keys(form) as (keyof PatchPayload)[]).forEach((k) => {
      const v = form[k];
      if (v === "" || v === undefined) (payload as any)[k] = null;
      else (payload as any)[k] = v;
    });
    await onSave(payload);
    setSaving(false);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <Field label="学科" value={form.discipline ?? ""} onChange={(v) => setForm({ ...form, discipline: v })} />
      <SelectField
        label="分区"
        value={form.partition ?? ""}
        onChange={(v) => setForm({ ...form, partition: v as PatchPayload["partition"] })}
        options={["", "Q1", "Q2", "Q3", "Q4"]}
      />
      <NumberField label="影响因子" value={form.impactFactor ?? null} onChange={(v) => setForm({ ...form, impactFactor: v })} step={0.1} />
      <NumberField label="录用率（0-1）" value={form.acceptanceRate ?? null} onChange={(v) => setForm({ ...form, acceptanceRate: v })} step={0.01} />
      <Field label="审稿周期" value={form.reviewCycle ?? ""} onChange={(v) => setForm({ ...form, reviewCycle: v })} placeholder="如 4-8周" />
      <Field label="出版社" value={form.publisher ?? ""} onChange={(v) => setForm({ ...form, publisher: v })} />
      <Field label="官网 URL" value={form.website ?? ""} onChange={(v) => setForm({ ...form, website: v })} placeholder="https://..." />
      <NumberField label="年发文量" value={form.annualVolume ?? null} onChange={(v) => setForm({ ...form, annualVolume: v })} step={1} />
      <NumberField label="版面费（USD）" value={form.apcFee ?? null} onChange={(v) => setForm({ ...form, apcFee: v })} step={50} />
      <div className="md:col-span-3 flex justify-end mt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className={`px-4 py-2 text-sm font-medium rounded-lg ${saving ? "bg-gray-200 text-gray-400" : "bg-blue-600 text-white hover:bg-blue-700"}`}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
    </label>
  );
}

function NumberField({ label, value, onChange, step }: {
  label: string; value: number | null; onChange: (v: number | null) => void; step?: number;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      >
        {options.map((o) => <option key={o} value={o}>{o || "（不限）"}</option>)}
      </select>
    </label>
  );
}
