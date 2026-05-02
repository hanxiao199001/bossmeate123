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
import { useJournalsAdmin, type AdminJournal, type PatchPayload, type JsonbEditableField } from "../hooks/useJournalsAdmin";
import { JsonbTableEditor } from "../components/admin/JsonbTableEditor";
import { JsonbObjectEditor, type JsonbObjectField } from "../components/admin/JsonbObjectEditor";
import { JsonbDiffPreview } from "../components/admin/JsonbDiffPreview";

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
      <div className="md:col-span-3 mt-4 space-y-3">
        <JsonbPanel title="IF 历史" jsonbKey="ifHistory" original={(j as any).ifHistory ?? null} onSave={onSave}>
          {(value, setValue) => <IfHistoryForm value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="版面费" jsonbKey="publicationCosts" original={(j as any).publicationCosts ?? null} onSave={onSave}>
          {(value, setValue) => <PublicationCostsForm value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="收稿范围" jsonbKey="scopeDetails" original={(j as any).scopeDetails ?? null} onSave={onSave}>
          {(value, setValue) => <ScopeDetailsForm value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="JCR 完整分区" jsonbKey="jcrFull" original={(j as any).jcrFull ?? null} onSave={onSave}>
          {(value, setValue) => <JcrFullForm value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="发文统计" jsonbKey="publicationStats" original={(j as any).publicationStats ?? null} onSave={onSave}>
          {(value, setValue) => <PublicationStatsForm value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="引用 Top10" jsonbKey="citingJournalsTop10" original={(j as any).citingJournalsTop10 ?? null} onSave={onSave}>
          {(value, setValue) => <CitingJournalsTop10Form value={value} onChange={setValue} />}
        </JsonbPanel>
        <JsonbPanel title="CAR 指数" jsonbKey="carIndexHistory" original={(j as any).carIndexHistory ?? null} onSave={onSave}>
          {(value, setValue) => <CarIndexHistoryForm value={value} onChange={setValue} />}
        </JsonbPanel>
      </div>
    </div>
  );
}

// ============ Day 4 PR-1: 3 jsonb form 实例 ============

const IF_HISTORY_COLUMNS = [
  { key: "year", label: "年份", type: "number" as const, step: 1, min: 1900, max: 2100, width: "30%" },
  { key: "if", label: "影响因子", type: "number" as const, step: 0.01, min: 0, max: 200, width: "30%" },
];

const PUB_COSTS_SCHEMA: ReadonlyArray<JsonbObjectField> = [
  { key: "apc", label: "APC（金额）", type: "number", step: 50, min: 0 },
  { key: "currency", label: "币种", type: "enum", options: ["USD", "CNY", "EUR", "GBP", "JPY"] },
  { key: "openAccess", label: "开放获取（OA）", type: "bool" },
  { key: "fastTrack", label: "快速通道", type: "bool" },
  { key: "source", label: "来源", type: "enum", options: ["doaj", "openalex", "journal_apc_field", "journal_website_llm"] },
];

const SCOPE_DETAILS_SCALAR: ReadonlyArray<JsonbObjectField> = [
  { key: "submissionNote", label: "投稿说明", type: "string", placeholder: "如：仅接受英文综述" },
  { key: "source", label: "来源", type: "enum", options: ["journal_website_llm", "openalex"] },
];

const SCOPE_CATEGORY_COLUMNS = [
  { key: "title", label: "分类", type: "string" as const, width: "30%", placeholder: "如：临床研究" },
  { key: "description", label: "描述", type: "string" as const, placeholder: "可选" },
];

const SUBJECT_DIST_COLUMNS = [
  { key: "subject", label: "学科", type: "string" as const, width: "60%" },
  { key: "percent", label: "占比 %", type: "number" as const, step: 0.1, min: 0, max: 100, width: "30%" },
];

function nowIso() { return new Date().toISOString(); }

function ensureLastUpdated<T extends Record<string, unknown> | null>(v: T): T {
  if (v && typeof v === "object") return { ...v, lastUpdatedAt: nowIso() } as T;
  return v;
}

function IfHistoryForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  // predicted 子对象由 B.4-1 enricher 写入，admin 不手填（保留原值，diff 预览可见）
  const v = value ?? { data: [], lastUpdatedAt: nowIso() };
  return (
    <JsonbTableEditor
      columns={IF_HISTORY_COLUMNS}
      rows={v.data ?? []}
      onChange={(next) => onChange(ensureLastUpdated({ ...v, data: next }))}
      newRowDefaults={{ year: new Date().getFullYear(), if: null }}
    />
  );
}

function PublicationCostsForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { lastUpdatedAt: nowIso() };
  return (
    <JsonbObjectEditor
      schema={PUB_COSTS_SCHEMA}
      value={v}
      onChange={(next) => onChange(ensureLastUpdated(next))}
    />
  );
}

function ScopeDetailsForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { lastUpdatedAt: nowIso() };
  const setField = (next: any) => onChange(ensureLastUpdated(next));
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">分类</div>
        <JsonbTableEditor
          columns={SCOPE_CATEGORY_COLUMNS}
          rows={v.categories ?? []}
          onChange={(next) => setField({ ...v, categories: next })}
          newRowDefaults={{ title: "", description: "" }}
        />
      </div>
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">学科分布（%）</div>
        <JsonbTableEditor
          columns={SUBJECT_DIST_COLUMNS}
          rows={v.subjectDistribution ?? []}
          onChange={(next) => setField({ ...v, subjectDistribution: next })}
          newRowDefaults={{ subject: "", percent: null }}
        />
      </div>
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">文章类型（逗号分隔）</div>
        <input
          type="text"
          value={Array.isArray(v.articleTypes) ? v.articleTypes.join(", ") : ""}
          onChange={(e) => setField({
            ...v,
            articleTypes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
          })}
          placeholder="如：综述, 原始研究, 病例报告"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        />
      </div>
      <JsonbObjectEditor schema={SCOPE_DETAILS_SCALAR} value={v} onChange={setField} />
    </div>
  );
}

/**
 * 通用 jsonb 编辑面板：折叠 + 编辑 + diff 预览 + 单独保存。
 * 单独保存（不混入 simple 9 字段）—— 结构化字段独立提交，错误回滚不影响 simple 字段。
 */
function JsonbPanel({
  title,
  jsonbKey,
  original,
  onSave,
  children,
}: {
  title: string;
  jsonbKey: JsonbEditableField;
  original: any;
  onSave: (p: PatchPayload) => Promise<boolean>;
  children: (value: any, setValue: (v: any) => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(original);
  const [saving, setSaving] = useState(false);
  const handleSave = async () => {
    setSaving(true);
    const ok = await onSave({ [jsonbKey]: draft } as PatchPayload);
    setSaving(false);
    if (ok) setOpen(false);
  };
  const handleClear = async () => {
    if (!confirm(`清空 ${title}？此操作不可逆`)) return;
    setSaving(true);
    const ok = await onSave({ [jsonbKey]: null } as PatchPayload);
    setSaving(false);
    if (ok) { setDraft(null); setOpen(false); }
  };
  const filled = original != null && (Array.isArray(original) ? original.length > 0 : Object.keys(original).length > 0);
  return (
    <div className="border border-gray-200 rounded bg-white">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-gray-50"
      >
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${filled ? "bg-green-500" : "bg-gray-300"}`} />
          <span className="font-medium text-gray-700">{title}</span>
          <span className="text-xs text-gray-400">{filled ? "已填" : "空"}</span>
        </span>
        <span className="text-xs text-gray-400">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="border-t border-gray-200 p-4 space-y-3 bg-gray-50">
          {children(draft, setDraft)}
          <div>
            <div className="text-xs font-medium text-gray-600 mb-1">变更预览</div>
            <JsonbDiffPreview before={original} after={draft} />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClear}
              disabled={saving || !filled}
              className={`px-3 py-1.5 text-xs rounded ${saving || !filled ? "bg-gray-100 text-gray-400" : "bg-red-50 text-red-700 hover:bg-red-100"}`}
            >
              清空字段
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className={`px-3 py-1.5 text-xs rounded ${saving ? "bg-gray-200 text-gray-400" : "bg-blue-600 text-white hover:bg-blue-700"}`}
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}
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

// ============ Day 4 PR-2: 4 复杂 jsonb form 实例 ============

const JCR_SUBJECT_COLUMNS = [
  { key: "subject", label: "学科", type: "string" as const, width: "40%" },
  { key: "zone", label: "分区", type: "string" as const, width: "15%", placeholder: "Q1" },
  { key: "rank", label: "Rank", type: "string" as const, width: "20%", placeholder: "6/98" },
  { key: "database", label: "DB", type: "string" as const, width: "15%", placeholder: "SCIE" },
];

const JCR_FULL_SCALAR: ReadonlyArray<JsonbObjectField> = [
  { key: "wosLevel", label: "WOS 等级", type: "enum", options: ["SCIE", "SSCI", "SCI", "ESCI"] },
  { key: "isTopJournal", label: "顶级期刊", type: "bool" },
  { key: "isReviewJournal", label: "综述期刊", type: "bool" },
];

const ANNUAL_VOLUME_COLUMNS = [
  { key: "year", label: "年份", type: "number" as const, step: 1, min: 1900, max: 2100, width: "30%" },
  { key: "count", label: "发文量", type: "number" as const, step: 1, min: 0, width: "30%" },
];

const TOP_INSTITUTIONS_COLUMNS = [
  { key: "name", label: "机构", type: "string" as const, width: "40%" },
  { key: "paperCount", label: "发文", type: "number" as const, step: 1, min: 0, width: "15%" },
  { key: "percentile", label: "百分位", type: "number" as const, step: 0.1, min: 0, max: 100, width: "15%" },
  { key: "country", label: "国家", type: "string" as const, width: "20%", placeholder: "CN" },
];

const PUB_STATS_SCALAR: ReadonlyArray<JsonbObjectField> = [
  { key: "frequency", label: "刊期", type: "enum", options: ["月刊", "双月刊", "季刊", "半年刊", "年刊", "周刊", "旬刊"] },
];

const CITING_JOURNALS_COLUMNS = [
  { key: "name", label: "引用方期刊", type: "string" as const, width: "45%" },
  { key: "count", label: "引用次数", type: "number" as const, step: 1, min: 0, width: "15%" },
  { key: "percent", label: "占比 %", type: "number" as const, step: 0.1, min: 0, max: 100, width: "15%" },
  { key: "openAlexId", label: "OpenAlex ID", type: "string" as const, width: "20%" },
];

const CITING_SCALAR: ReadonlyArray<JsonbObjectField> = [
  { key: "selfCitationRate", label: "自引率（0-1）", type: "number", step: 0.01, min: 0, max: 1 },
  { key: "selfCitationConfidence", label: "置信度", type: "enum", options: ["low", "medium", "high"] },
  { key: "totalCitations", label: "总引用数", type: "number", step: 1, min: 0 },
];

const CAR_DATA_COLUMNS = [
  { key: "year", label: "年份", type: "number" as const, step: 1, min: 1900, max: 2100, width: "30%" },
  { key: "carIndex", label: "CAR（0-1）", type: "number" as const, step: 0.01, min: 0, max: 1, width: "30%" },
];

const CAR_SCALAR: ReadonlyArray<JsonbObjectField> = [
  { key: "riskLevel", label: "风险等级", type: "enum", options: ["low", "mid", "high"] },
  { key: "isWarningListed", label: "中科院预警名单", type: "bool" },
];

function JcrFullForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { lastUpdatedAt: nowIso() };
  const set = (next: any) => onChange(ensureLastUpdated(next));
  return (
    <div className="space-y-4">
      <JsonbObjectEditor schema={JCR_FULL_SCALAR} value={v} onChange={set} />
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">JIF Subjects</div>
        <JsonbTableEditor
          columns={JCR_SUBJECT_COLUMNS}
          rows={v.jifSubjects ?? []}
          onChange={(next) => set({ ...v, jifSubjects: next })}
          newRowDefaults={{ subject: "" }}
        />
      </div>
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">JCI Subjects</div>
        <JsonbTableEditor
          columns={JCR_SUBJECT_COLUMNS}
          rows={v.jciSubjects ?? []}
          onChange={(next) => set({ ...v, jciSubjects: next })}
          newRowDefaults={{ subject: "" }}
        />
      </div>
    </div>
  );
}

function PublicationStatsForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { lastUpdatedAt: nowIso() };
  const set = (next: any) => onChange(ensureLastUpdated(next));
  return (
    <div className="space-y-4">
      <JsonbObjectEditor schema={PUB_STATS_SCALAR} value={v} onChange={set} />
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">年发文量历史</div>
        <JsonbTableEditor
          columns={ANNUAL_VOLUME_COLUMNS}
          rows={v.annualVolumeHistory ?? []}
          onChange={(next) => set({ ...v, annualVolumeHistory: next })}
          newRowDefaults={{ year: new Date().getFullYear(), count: null }}
        />
      </div>
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">活跃机构（Scimago Top 5）</div>
        <JsonbTableEditor
          columns={TOP_INSTITUTIONS_COLUMNS}
          rows={v.topInstitutions ?? []}
          onChange={(next) => set({ ...v, topInstitutions: next })}
          newRowDefaults={{ name: "" }}
        />
      </div>
    </div>
  );
}

function CitingJournalsTop10Form({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { topJournals: [], lastUpdatedAt: nowIso() };
  const set = (next: any) => onChange(ensureLastUpdated(next));
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">引用 Top 期刊</div>
        <JsonbTableEditor
          columns={CITING_JOURNALS_COLUMNS}
          rows={v.topJournals ?? []}
          onChange={(next) => set({ ...v, topJournals: next })}
          newRowDefaults={{ name: "", count: 0 }}
        />
      </div>
      <JsonbObjectEditor schema={CITING_SCALAR} value={v} onChange={set} />
    </div>
  );
}

function CarIndexHistoryForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const v = value ?? { data: [], riskLevel: "low", lastUpdatedAt: nowIso() };
  const set = (next: any) => onChange(ensureLastUpdated(next));
  return (
    <div className="space-y-4">
      <JsonbObjectEditor schema={CAR_SCALAR} value={v} onChange={set} />
      <div>
        <div className="text-xs font-medium text-gray-600 mb-1">CAR 历史</div>
        <JsonbTableEditor
          columns={CAR_DATA_COLUMNS}
          rows={v.data ?? []}
          onChange={(next) => set({ ...v, data: next })}
          newRowDefaults={{ year: new Date().getFullYear(), carIndex: null }}
        />
      </div>
    </div>
  );
}
