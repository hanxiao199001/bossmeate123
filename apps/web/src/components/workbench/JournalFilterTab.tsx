/**
 * PR #175 — ManualGenerateModal Tab 2 "精准筛选"
 *
 * LetPub 风格: 7 个 filter, 实时筛 DB 39+ 期刊, 勾选后生成.
 * 调 GET /admin/journals/search → 返回匹配列表
 */
import { useState, useEffect, useCallback } from "react";
import { api } from "../../utils/api";

type Template = "A" | "B" | "C" | "E";
type SortBy = "if_desc" | "if_asc" | "name";
type WosLevel = "all" | "scie" | "ssci";

const DISCIPLINE_FILTER_OPTIONS = [
  { value: "", label: "全部" },
  { value: "medicine", label: "医学" },
  { value: "agriculture", label: "农业" },
  { value: "engineering", label: "工程" },
  { value: "education", label: "教育" },
  { value: "biology", label: "生物" },
  { value: "economics", label: "经济" },
  { value: "psychology", label: "心理" },
  { value: "law", label: "法学" },
];

const TEMPLATE_LABELS: Record<Template, string> = {
  A: "A 学术", B: "B 营销", C: "C 解读", E: "E 行业",
};

interface Journal {
  id: string;
  name_en: string;
  name: string;
  issn: string | null;
  impact_factor: number | null;
  partition: string | null;
  discipline: string | null;
  wos_level: string | null;
  confidence: number | null;
}

interface JournalFilterTabProps {
  accounts: Array<{ id: string; accountName: string; platform: string; isVerified: boolean; status: string }>;
  selectedAccountIds: Set<string>;
  toggleAccount: (id: string) => void;
  skipPublish: boolean;
  setSkipPublish: (v: boolean) => void;
  onSubmit: (journalIds: string[], template: Template) => void;
  generating: boolean;
}

export default function JournalFilterTab({
  accounts, selectedAccountIds, toggleAccount, skipPublish, setSkipPublish, onSubmit, generating,
}: JournalFilterTabProps) {
  // Filter state
  const [nameQuery, setNameQuery] = useState("");
  const [issnQuery, setIssnQuery] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [ifMin, setIfMin] = useState("");
  const [ifMax, setIfMax] = useState("");
  const [jcrSubject, setJcrSubject] = useState("");
  const [wosLevel, setWosLevel] = useState<WosLevel>("all");
  const [sortBy, setSortBy] = useState<SortBy>("if_desc");
  const [template, setTemplate] = useState<Template>("A");

  // Results
  const [journals, setJournals] = useState<Journal[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedJournalIds, setSelectedJournalIds] = useState<Set<string>>(new Set());

  // Debounced search
  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nameQuery) params.set("name", nameQuery);
      if (issnQuery) params.set("issn", issnQuery);
      if (discipline) params.set("discipline", discipline);
      if (ifMin) params.set("ifMin", ifMin);
      if (ifMax) params.set("ifMax", ifMax);
      if (jcrSubject) params.set("jcrSubject", jcrSubject);
      if (wosLevel !== "all") params.set("wosLevel", wosLevel);
      params.set("sortBy", sortBy);
      params.set("limit", "30");

      const res = await api.get(`/admin/journals/search?${params.toString()}`);
      const data = (res.data as any)?.data ?? res.data;
      setJournals(data?.items ?? []);
      setTotal(data?.total ?? 0);
    } catch {
      setJournals([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [nameQuery, issnQuery, discipline, ifMin, ifMax, jcrSubject, wosLevel, sortBy]);

  useEffect(() => {
    const timer = setTimeout(doSearch, 300);
    return () => clearTimeout(timer);
  }, [doSearch]);

  const toggleJournal = (id: string) => {
    setSelectedJournalIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setNameQuery(""); setIssnQuery(""); setDiscipline(""); setIfMin(""); setIfMax("");
    setJcrSubject(""); setWosLevel("all"); setSortBy("if_desc");
  };

  const handleSubmit = () => {
    if (selectedJournalIds.size === 0) return;
    onSubmit([...selectedJournalIds], template);
  };

  return (
    <div className="space-y-4">
      {/* Filters row 1: name + ISSN */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">期刊名</label>
          <input type="text" value={nameQuery} onChange={(e) => setNameQuery(e.target.value)}
            placeholder="如 Frontiers..." disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">ISSN</label>
          <input type="text" value={issnQuery} onChange={(e) => setIssnQuery(e.target.value)}
            placeholder="如 0140-6736" disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400" />
        </div>
      </div>

      {/* Filter row 2: IF range + discipline */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">IF 最低</label>
          <input type="number" value={ifMin} onChange={(e) => setIfMin(e.target.value)} placeholder="0"
            disabled={generating} className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">IF 最高</label>
          <input type="number" value={ifMax} onChange={(e) => setIfMax(e.target.value)} placeholder="100"
            disabled={generating} className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">大类学科</label>
          <select value={discipline} onChange={(e) => setDiscipline(e.target.value)} disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white">
            {DISCIPLINE_FILTER_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Filter row 3: JCR subject + SCI + sort */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">JCR 小类</label>
          <input type="text" value={jcrSubject} onChange={(e) => setJcrSubject(e.target.value)}
            placeholder="如 PSYCHOLOGY" disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm" />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">SCI 收录</label>
          <select value={wosLevel} onChange={(e) => setWosLevel(e.target.value as WosLevel)} disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white">
            <option value="all">不限</option>
            <option value="scie">SCIE</option>
            <option value="ssci">SSCI</option>
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-gray-500 mb-1">排序</label>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} disabled={generating}
            className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white">
            <option value="if_desc">IF 降序</option>
            <option value="if_asc">IF 升序</option>
            <option value="name">名称</option>
          </select>
        </div>
      </div>

      {/* Result count + clear */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{loading ? "搜索中..." : `匹配 ${total} 本期刊`}{selectedJournalIds.size > 0 && ` · 已选 ${selectedJournalIds.size}`}</span>
        <button onClick={clearFilters} className="text-blue-500 hover:text-blue-700" disabled={generating}>清空筛选</button>
      </div>

      {/* Journal list */}
      <div className="max-h-40 overflow-y-auto space-y-1 border border-gray-100 rounded-lg p-1.5">
        {journals.length === 0 && !loading && (
          <div className="text-center text-xs text-gray-400 py-4">无匹配期刊</div>
        )}
        {journals.map((j) => (
          <label key={j.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer hover:bg-gray-50 ${
            selectedJournalIds.has(j.id) ? "bg-blue-50 border border-blue-200" : "border border-transparent"
          }`}>
            <input type="checkbox" checked={selectedJournalIds.has(j.id)} onChange={() => toggleJournal(j.id)} disabled={generating} className="rounded" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{j.name_en || j.name}</div>
              <div className="text-[11px] text-gray-400">
                IF {j.impact_factor ?? "-"} · {j.partition ?? "-"} · {j.discipline ?? "-"}
                {j.wos_level && ` · ${j.wos_level}`}
              </div>
            </div>
          </label>
        ))}
      </div>

      {/* Template */}
      <div>
        <label className="block text-[11px] text-gray-500 mb-1">模板</label>
        <div className="flex gap-1.5">
          {(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => (
            <button key={t} onClick={() => !generating && setTemplate(t)} disabled={generating}
              className={`px-2.5 py-1 text-xs rounded-full border ${
                template === t ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600"
              }`}>
              {TEMPLATE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* Account selection (shared) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] text-gray-500">发布到账号</label>
          <label className="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer">
            <input type="checkbox" checked={skipPublish} onChange={(e) => setSkipPublish(e.target.checked)} disabled={generating} className="rounded" />
            仅生成不发布
          </label>
        </div>
        {!skipPublish && accounts.length > 0 && (
          <div className="space-y-0.5 max-h-20 overflow-y-auto">
            {accounts.filter(a => a.status === "active" || a.isVerified).map((a) => (
              <label key={a.id} className={`flex items-center gap-1.5 px-2 py-1 border rounded text-xs cursor-pointer ${
                selectedAccountIds.has(a.id) ? "border-blue-400 bg-blue-50" : "border-gray-100"
              }`}>
                <input type="checkbox" checked={selectedAccountIds.has(a.id)} onChange={() => toggleAccount(a.id)} disabled={generating} className="rounded" />
                <span>{a.accountName}</span>
                {a.isVerified && <span className="text-[10px] text-green-600 bg-green-50 px-1 rounded">已验证</span>}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={generating || selectedJournalIds.size === 0}
        className={`w-full py-2 text-sm font-medium rounded-lg ${
          generating || selectedJournalIds.size === 0
            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
            : "bg-blue-600 text-white hover:bg-blue-700"
        }`}
      >
        {generating ? "生成中..." : skipPublish
          ? `生成 ${selectedJournalIds.size} 篇`
          : `生成并发布 ${selectedJournalIds.size} 篇`}
      </button>
    </div>
  );
}
