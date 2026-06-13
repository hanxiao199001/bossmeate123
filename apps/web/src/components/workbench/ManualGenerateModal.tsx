/**
 * PR #174 — "一键生成发布" modal.
 *
 * 3 段决策:
 *   1. 学科 (默认 auto = 按今日 rotation)
 *   2. 数量 (3/5/10/自定义) + 模板 (A/B/C/E)
 *   3. 目标账号 (默认勾 isVerified) + 是否发布 (默认是)
 *
 * POST /admin/generate-and-publish { discipline, count, template, accountIds }
 * 前端 poll batch status → 进度条 → 完成后可选 bulk-distribute
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../../utils/api";
import JournalFilterTab from "./JournalFilterTab";
import AccountSelector from "../AccountSelector";

type Template = "A" | "B" | "C" | "E";
type CountOption = 3 | 5 | 10 | "custom";
type Discipline = "medicine" | "psychology" | "engineering" | "economics" | "biology" | "education" | "law" | "agriculture" | "auto";

const DISCIPLINE_OPTIONS: { value: Discipline; label: string }[] = [
  { value: "auto", label: "自动 (按今日轮换)" },
  { value: "medicine", label: "医学/健康" },
  { value: "psychology", label: "心理学" },
  { value: "education", label: "教育" },
  { value: "economics", label: "经济管理" },
  { value: "engineering", label: "工程技术" },
  { value: "biology", label: "生物" },
  { value: "law", label: "法学" },
  { value: "agriculture", label: "农林" },
];

const TEMPLATE_LABELS: Record<Template, { name: string; desc: string }> = {
  A: { name: "A 学术", desc: "SCI/SSCI 期刊推荐" },
  B: { name: "B 营销", desc: "公众号引流文" },
  C: { name: "C 解读", desc: "深度论文解读" },
  E: { name: "E 行业", desc: "产业研究" },
};

const COUNT_OPTIONS: { value: CountOption; label: string; time: string }[] = [
  { value: 3, label: "3 篇", time: "~20s" },
  { value: 5, label: "5 篇", time: "~30s" },
  { value: 10, label: "10 篇", time: "~60s" },
  { value: "custom", label: "自定义", time: "" },
];

interface Account {
  id: string;
  accountName: string;
  platform: string;
  isVerified: boolean;
  status: string;
  discipline?: string | null; // PR-W5 账号领域定位(旧单选)
  disciplines?: string[]; // PR-W5b 多选
}

const DISC_LABEL: Record<string, string> = {
  medicine: "医学", psychology: "心理", engineering: "工程", economics: "经管",
  biology: "生物", education: "教育", law: "法学", agriculture: "农林",
  computer: "计算机", environment: "环境", chemistry: "化学", physics: "物理",
};

interface ManualGenerateModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (contentId: string) => void;
}

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 300_000;

export default function ManualGenerateModal({ open, onClose, onComplete }: ManualGenerateModalProps) {
  // PR #175: tab 切换 (快速 / 精准)
  const [activeTab, setActiveTab] = useState<"quick" | "precise">("quick");
  // 段 1: 学科
  const [discipline, setDiscipline] = useState<Discipline>("auto");
  // 段 2: 数量 + 模板
  const [countOption, setCountOption] = useState<CountOption>(5);
  const [customCount, setCustomCount] = useState(5);
  const [template, setTemplate] = useState<Template>("A");
  // 段 3: 账号 + 发布
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());
  const [skipPublish, setSkipPublish] = useState(false);
  // 业务线整理: 生成只产内容入池; 选了号则生成后"直发"(直发+去重, 同手动发布), 不再独家配对
  const publishAccountsRef = useRef<string[]>([]);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  // 进度
  const [phase, setPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const actualCount = countOption === "custom" ? customCount : countOption;

  // 拉账号列表
  useEffect(() => {
    if (!open) return;
    api.get<{ data: Account[] }>("/accounts")
      .then((res) => {
        const list = (res.data as any)?.data ?? (res.data as any) ?? [];
        const arr = Array.isArray(list) ? list : [];
        setAccounts(arr);
        // 默认勾 isVerified=true
        setSelectedAccountIds(new Set(arr.filter((a: Account) => a.isVerified).map((a: Account) => a.id)));
      })
      .catch(() => setAccounts([]));
  }, [open]);

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => cleanup, [cleanup]);

  // poll batch statuses
  useEffect(() => {
    if (batchIds.length === 0 || phase !== "generating") return;
    startedAtRef.current = Date.now();
    const doneSet = new Set<string>();
    const articleByBatch = new Map<string, string>(); // PR-W5: batch→生成的文章

    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed > MAX_WAIT_MS) {
        cleanup();
        setError(`超时, 已完成 ${doneSet.size}/${batchIds.length}`);
        setPhase("error");
        return;
      }
      for (const bid of batchIds) {
        if (doneSet.has(bid)) continue;
        try {
          const res = await api.get(`/batch/${bid}`);
          const row = (res.data as any)?.rows?.[0];
          if (row?.status === "generated" || row?.status === "failed") {
            doneSet.add(bid);
            if (row?.status === "generated" && row?.articleId) articleByBatch.set(bid, row.articleId);
            setCompletedCount(doneSet.size);
          }
        } catch { /* ignore */ }
      }
      if (doneSet.size >= batchIds.length) {
        cleanup();
        // 生成完: 若选了号 → 直发(选中文章×选中号, 服务端去重), 与手动发布同一套
        const articleIds = [...articleByBatch.values()];
        const accIds = publishAccountsRef.current;
        if (articleIds.length > 0 && accIds.length > 0) {
          api.post("/admin/bulk-distribute", { articleIds, accountIds: accIds })
            .then((r: any) => { const d = r?.data?.data ?? r?.data; setPublishNote(`已入队 ${d?.queued ?? articleIds.length * accIds.length} 个发布任务 (${d?.skipped ?? 0} 重复跳过)`); })
            .catch((e: any) => setPublishNote(`生成完成, 但发布失败: ${e?.message ?? "未知错误"}`));
        }
        setPhase("done");
        setTimeout(() => onComplete(""), 1500);
      }
    }, POLL_INTERVAL_MS);
    return cleanup;
  }, [batchIds, phase, onComplete, cleanup]);

  if (!open) return null;

  const toggleAccount = (id: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setError(null);
    if (actualCount < 1 || actualCount > 20) { setError("数量 1-20"); return; }
    setPhase("generating");
    setElapsedMs(0);
    setCompletedCount(0);
    try {
      publishAccountsRef.current = skipPublish ? [] : [...selectedAccountIds];
      const res = await api.post("/admin/generate-and-publish", {
        mode: "discipline-auto",
        discipline,
        count: actualCount,
        template,
        accountIds: [], // 生成阶段不发, 生成完再直发(见 poll-complete)
      });
      const data = (res.data as any)?.data ?? res.data;
      const ids = data?.batchIds ?? [];
      if (!ids.length) throw new Error("无 batchId 返回");
      setBatchIds(ids);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "请求失败");
      setPhase("error");
    }
  };

  // PR #175: 精准筛选提交
  const handlePreciseSubmit = async (journalIds: string[], tmpl: "A" | "B" | "C" | "E") => {
    setError(null);
    setPhase("generating");
    setElapsedMs(0);
    setCompletedCount(0);
    try {
      const res = await api.post("/admin/generate-and-publish", {
        mode: "journal-specified",
        journalIds,
        template: tmpl,
        accountIds: skipPublish ? [] : [...selectedAccountIds],
      });
      const data = (res.data as any)?.data ?? res.data;
      const ids = data?.batchIds ?? [];
      if (!ids.length) throw new Error("无 batchId 返回");
      setBatchIds(ids);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "请求失败");
      setPhase("error");
    }
  };

  const handleCancel = () => {
    if (phase === "generating") {
      if (!confirm("生成中, 确认取消? (后台 batch 不会停)")) return;
    }
    cleanup();
    setPhase("idle");
    setBatchIds([]);
    setCompletedCount(0);
    setError(null);
    setElapsedMs(0);
    onClose();
  };

  const generating = phase === "generating";
  const elapsedSec = Math.floor(elapsedMs / 1000);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900">一键生成发布</h2>
          <button onClick={handleCancel} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        {/* PR #175: Tab bar */}
        <div className="flex gap-1 mb-4 border-b border-gray-100">
          {([["quick", "快速"], ["precise", "精准筛选"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => !generating && setActiveTab(key)}
              disabled={generating}
              className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-blue-500 text-blue-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              } ${generating ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "precise" ? (
          <JournalFilterTab
            accounts={accounts}
            selectedAccountIds={selectedAccountIds}
            toggleAccount={toggleAccount}
            skipPublish={skipPublish}
            setSkipPublish={setSkipPublish}
            onSubmit={handlePreciseSubmit}
            generating={generating}
          />
        ) : (
        <div className="space-y-5">
          {/* 段 1: 学科 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">学科方向</label>
            <div className="flex flex-wrap gap-1.5">
              {DISCIPLINE_OPTIONS.map((d) => (
                <button
                  key={d.value}
                  onClick={() => !generating && setDiscipline(d.value)}
                  disabled={generating}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    discipline === d.value
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-200 text-gray-600 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* 段 2: 数量 + 模板 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">数量</label>
              <div className="space-y-1.5">
                {COUNT_OPTIONS.map((opt) => (
                  <label key={String(opt.value)} className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-lg text-sm cursor-pointer ${
                    countOption === opt.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : ""}`}>
                    <input type="radio" name="count" checked={countOption === opt.value} onChange={() => setCountOption(opt.value)} disabled={generating} className="hidden" />
                    <span className="font-medium">{opt.label}</span>
                    {opt.time && <span className="text-[11px] text-gray-400">{opt.time}</span>}
                  </label>
                ))}
                {countOption === "custom" && (
                  <input type="number" min={1} max={20} value={customCount}
                    onChange={(e) => setCustomCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                    disabled={generating} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm" placeholder="1-20" />
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">模板</label>
              <div className="space-y-1.5">
                {(Object.keys(TEMPLATE_LABELS) as Template[]).map((t) => (
                  <label key={t} className={`block px-2.5 py-1.5 border rounded-lg text-sm cursor-pointer ${
                    template === t ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
                  } ${generating ? "opacity-50 cursor-not-allowed" : ""}`}>
                    <input type="radio" name="template" value={t} checked={template === t} onChange={() => setTemplate(t)} disabled={generating} className="hidden" />
                    <span className="font-medium">{TEMPLATE_LABELS[t].name}</span>
                    <span className="text-[11px] text-gray-400 ml-1">{TEMPLATE_LABELS[t].desc}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* 段 3: 账号 + 发布 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-700">发布到账号</label>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                <input type="checkbox" checked={skipPublish} onChange={(e) => setSkipPublish(e.target.checked)} disabled={generating} className="rounded" />
                仅生成不发布
              </label>
            </div>
            {/* 6-11 施工包C1: 统一 AccountSelector。生成完会直发到所选号(直发+去重) */}
            {!skipPublish && (
              <div className="text-xs text-gray-400 mb-1.5">生成后将直接发到所选账号(已发过的自动去重)。不想发就勾「仅生成不发布」。</div>
            )}
            {!skipPublish && (
              <div className="max-h-40 overflow-y-auto">
                <AccountSelector
                  accounts={accounts.filter((a) => a.status === "active" || a.isVerified)}
                  value={[...selectedAccountIds]}
                  onChange={(ids) => setSelectedAccountIds(new Set(ids))}
                  showGroupSelectAll
                  disabled={generating}
                />
              </div>
            )}
          </div>

        </div>
        )}

        {/* Shared: error + progress + buttons (both tabs) */}
        {error && (
          <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}
        {publishNote && (
          <div className="mt-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">{publishNote}</div>
        )}

        {generating && (
          <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block w-3 h-3 rounded-full bg-blue-500 animate-pulse" />
              <span>生成中... {completedCount}/{batchIds.length} 篇 ({elapsedSec}s)</span>
            </div>
            <div className="w-full bg-blue-200 rounded-full h-1.5">
              <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${batchIds.length > 0 ? (completedCount / batchIds.length) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="mt-3 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            生成完成! {completedCount} 篇已入库, 正在跳转...
          </div>
        )}

        {/* 快速 tab 按钮 (精准 tab 有自己的按钮) */}
        {activeTab === "quick" && (
        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            {generating ? "取消" : "关闭"}
          </button>
          <button
            onClick={handleSubmit}
            disabled={generating || phase === "done"}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              generating || phase === "done"
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {generating ? "生成中..." : phase === "done" ? "完成" : skipPublish ? `生成 ${actualCount} 篇` : `生成并发布 ${actualCount} 篇`}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
