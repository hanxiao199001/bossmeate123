/**
 * PR-I4 / PR-K4 — "多刊盘点" 生成 modal.
 *
 * 学同行 (顾老论文说) 风格的多刊盘点长文: 选学科 + 核心目录 + 数量 + 读者画像,
 * 自动按录用率挑对普通作者友好的刊, 一次性生成整篇盘点。
 *
 * PR-K4: 可选"目标账号" — 选账号后自动按其期刊定位(国内核心/国外期刊)选刊,
 *   生成后链 /publish 直接送进该账号的微信草稿箱(draft_only 公众号)。
 *
 * POST /admin/roundup { discipline?, catalog?, count?, scope?, audience } → { contentId, title }
 * 选了账号时再 POST /publish { contentId, accountIds:[accountId] }。
 */
import { useState, useEffect } from "react";
import { api } from "../../utils/api";

type Catalog = "" | "pku-core" | "cssci" | "cssci-ext" | "cscd" | "sci-core";

interface Account {
  id: string;
  accountName: string;
  platform: string;
  journalScope?: string;
  status?: string;
  isVerified?: boolean;
}

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
const SCOPE_LABEL: Record<string, string> = { both: "两者都做", domestic: "国内核心", international: "国外期刊" };

interface RoundupGenerateModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: (contentId: string) => void;
}

export default function RoundupGenerateModal({ open, onClose, onComplete }: RoundupGenerateModalProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");   // "" = 不指定, 仅生成草稿
  const [discipline, setDiscipline] = useState("");
  const [catalog, setCatalog] = useState<Catalog>("");
  const [scope, setScope] = useState("");           // 手动期刊定位 (未选账号时生效)
  const [count, setCount] = useState(5);
  const [audience, setAudience] = useState("普通院校教师");
  const [phase, setPhase] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string>("");
  const [lastContentId, setLastContentId] = useState<string>("");

  // 拉账号列表
  useEffect(() => {
    if (!open) return;
    api.get<{ data: Account[] }>("/accounts")
      .then((res) => {
        const list = (res.data as any)?.data ?? (res.data as any) ?? [];
        setAccounts(Array.isArray(list) ? list : []);
      })
      .catch(() => setAccounts([]));
  }, [open]);

  if (!open) return null;
  const generating = phase === "generating";

  const selectedAccount = accounts.find((a) => a.id === accountId);
  // 选了账号 → 定位跟随账号 (both → 不过滤); 否则用手动 scope
  const effectiveScope = selectedAccount
    ? (selectedAccount.journalScope && selectedAccount.journalScope !== "both" ? selectedAccount.journalScope : "")
    : scope;
  const scopeLocked = !!selectedAccount;

  const reset = () => {
    setPhase("idle"); setError(null); setDoneMsg(""); setLastContentId("");
  };
  const handleClose = () => {
    if (generating) return;
    reset();
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
        scope: effectiveScope || undefined,
        audience: audience.trim() || "普通院校教师",
      });
      const data = (res.data as any)?.data ?? res.data;
      const contentId = data?.contentId;
      if (!contentId) throw new Error("无 contentId 返回");
      setLastContentId(contentId);

      // 选了账号 → 直接发布(公众号 draft_only = 进该账号草稿箱)
      if (accountId && selectedAccount) {
        try {
          await api.post("/publish", { contentId, accountIds: [accountId] });
          setDoneMsg(`已生成并送入【${selectedAccount.accountName}】的微信草稿箱，去公众号后台发送即可。`);
        } catch (pubErr: any) {
          setDoneMsg(`盘点已生成(草稿已入库)，但送入【${selectedAccount.accountName}】草稿箱失败：${pubErr?.response?.data?.message || pubErr?.message || "请到工作台手动发布"}`);
        }
        setPhase("done");
      } else {
        setPhase("idle");
        onComplete(contentId);
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || "盘点生成失败");
      setPhase("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-bold text-gray-900">📚 多刊盘点</h2>
          <button onClick={handleClose} disabled={generating}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none disabled:opacity-40">&times;</button>
        </div>
        <p className="text-xs text-gray-400 mb-4">按录用率挑对普通作者友好的刊，生成一篇同行盘点风格长文。</p>

        {phase === "done" ? (
          <div className="space-y-4">
            <div className="px-3 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
              ✅ {doneMsg}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { const id = lastContentId; reset(); onComplete(id); }}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                查看文章
              </button>
              <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">关闭</button>
            </div>
          </div>
        ) : (
        <>
        <div className="space-y-4">
          {/* PR-K4 目标账号 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">目标账号</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={generating}
              className="w-full px-2.5 py-1.5 border border-gray-200 rounded-lg text-sm bg-white disabled:opacity-50">
              <option value="">不指定（仅生成草稿，稍后手动发布）</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.accountName}（{SCOPE_LABEL[a.journalScope || "both"]}）
                </option>
              ))}
            </select>
            {selectedAccount && (
              <p className="mt-1 text-xs text-teal-600">
                将按【{SCOPE_LABEL[selectedAccount.journalScope || "both"]}】选刊，生成后直接送入该账号草稿箱
              </p>
            )}
          </div>

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

          {/* 期刊定位 (未选账号时手动; 选了账号则跟随账号锁定) */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">
              期刊定位 {scopeLocked && <span className="text-teal-600">（跟随账号）</span>}
            </label>
            <div className="flex gap-1.5">
              {([["", "不限"], ["domestic", "国内核心"], ["international", "国外期刊"]] as const).map(([v, lbl]) => {
                const active = scopeLocked ? effectiveScope === v : scope === v;
                return (
                  <button key={v} onClick={() => !generating && !scopeLocked && setScope(v)} disabled={generating || scopeLocked}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      active ? "border-teal-500 bg-teal-50 text-teal-700" : "border-gray-200 text-gray-600 hover:border-gray-300"
                    } ${generating || scopeLocked ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}>
                    {lbl}
                  </button>
                );
              })}
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
            {accountId ? "正在生成并送入账号草稿箱，约 10-20 秒..." : "正在生成盘点长文，约 10-20 秒..."}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={handleClose} disabled={generating}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 disabled:opacity-40">关闭</button>
          <button onClick={handleSubmit} disabled={generating}
            className={`px-4 py-2 text-sm font-medium rounded-lg ${
              generating ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
            }`}>
            {generating ? "生成中..." : accountId ? "生成并送入账号" : "生成盘点"}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
