/**
 * PR-Y2: 企业画像开通向导 — 给新客户开通的可视化流程, 串起 /admin/onboarding 三接口。
 * 第1步 贴资料+问卷 → 提炼企业画像; 第2步 一键推导账号定位; 第3步 生成选题池。
 */
import { useState } from "react";
import { api } from "../utils/api";
import { toast } from "../components/Toast";

interface CompanyProfile {
  industry: string;
  products: string[];
  targetCustomers: string;
  sellingPoints: string[];
  competitors?: string[];
  taboos?: string[];
  toneSuggestion?: string;
  summary: string;
}

const QUESTIONS = [
  "你们卖什么产品/服务?",
  "谁会掏钱买?决策的是什么人?",
  "客户最常问你们的问题是什么?",
  "你最想让客户记住你们哪一点?",
  "绝对不能碰的话题或表述?",
];

export default function OnboardingWizardPage() {
  const [step, setStep] = useState(1);
  const [materials, setMaterials] = useState("");
  const [answers, setAnswers] = useState<string[]>(Array(QUESTIONS.length).fill(""));
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [accounts, setAccounts] = useState<Array<{ accountName: string; role: string; persona: string }>>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const extractProfile = async () => {
    const mats = materials.split(/\n-{3,}\n/).map((m) => m.trim()).filter((m) => m.length >= 50);
    if (mats.length === 0) { toast.error("请贴至少一段 ≥50 字的公司资料 (官网/产品介绍/历史文章)"); return; }
    const questionnaire: Record<string, string> = {};
    QUESTIONS.forEach((q, i) => { if (answers[i].trim()) questionnaire[q] = answers[i].trim(); });
    setBusy(true);
    try {
      const r = await api.post("/admin/onboarding/profile", { materials: mats, questionnaire });
      const p = (r.data as any)?.data?.profile ?? (r.data as any)?.profile;
      setProfile(p);
      setStep(2);
      toast.success("企业画像已提炼");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "画像提炼失败");
    } finally { setBusy(false); }
  };

  const deriveAccounts = async () => {
    setBusy(true);
    try {
      const r = await api.post("/admin/onboarding/derive-accounts", { overwrite: false });
      setAccounts(((r.data as any)?.data?.accounts ?? (r.data as any)?.accounts ?? []));
      setStep(3);
      toast.success("账号定位已推导并写入");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "账号定位推导失败 (确认该客户已添加账号)");
    } finally { setBusy(false); }
  };

  const genTopics = async () => {
    setBusy(true);
    try {
      const r = await api.post("/admin/onboarding/topic-pool", { count: 50 });
      setTopics(((r.data as any)?.data?.topics ?? (r.data as any)?.topics ?? []));
      setStep(4);
      toast.success("选题池已生成");
    } catch (e: any) {
      toast.error(e?.response?.data?.message || "选题池生成失败");
    } finally { setBusy(false); }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-1">新客户开通向导</h1>
      <p className="text-sm text-gray-500 mb-4">三步给客户配好企业画像、账号定位、选题池。请先用客户的账号登录后操作。</p>

      <div className="flex items-center gap-2 mb-6 text-xs">
        {["①企业画像", "②账号定位", "③选题池", "✓完成"].map((label, i) => (
          <div key={label} className={`px-2.5 py-1 rounded-full ${step >= i + 1 ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-400"}`}>{label}</div>
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">公司资料 (官网文案 / 产品介绍 / 历史文章, 多段用单独一行 --- 分隔)</label>
            <textarea value={materials} onChange={(e) => setMaterials(e.target.value)} rows={6}
              placeholder="把官网介绍、产品说明、已有爆款文贴进来..."
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:border-indigo-400" />
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium text-gray-700">老板问卷 (选填, 答得越细画像越准)</div>
            {QUESTIONS.map((q, i) => (
              <div key={q}>
                <label className="block text-xs text-gray-500 mb-0.5">{q}</label>
                <input value={answers[i]} onChange={(e) => { const a = [...answers]; a[i] = e.target.value; setAnswers(a); }}
                  className="w-full text-sm px-2 py-1.5 border border-gray-200 rounded-lg" />
              </div>
            ))}
          </div>
          <button onClick={() => void extractProfile()} disabled={busy}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "提炼中… (约30秒)" : "提炼企业画像 →"}
          </button>
        </div>
      )}

      {step === 2 && profile && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-100 rounded-xl p-4 text-sm space-y-1.5">
            <div><span className="text-gray-400">行业:</span> {profile.industry}</div>
            <div><span className="text-gray-400">产品:</span> {profile.products?.join("、")}</div>
            <div><span className="text-gray-400">目标客户:</span> {profile.targetCustomers}</div>
            <div><span className="text-gray-400">卖点:</span> {profile.sellingPoints?.join("、")}</div>
            {profile.taboos && profile.taboos.length > 0 && <div><span className="text-gray-400">禁忌:</span> <span className="text-rose-600">{profile.taboos.join("、")}</span></div>}
            <div className="pt-1 text-gray-600">{profile.summary}</div>
          </div>
          <p className="text-xs text-gray-400">画像已存入该客户配置。下一步给他的每个账号自动分配角色定位和人设。</p>
          <button onClick={() => void deriveAccounts()} disabled={busy}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "推导中…" : "推导账号定位 →"}
          </button>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-100 rounded-xl divide-y divide-gray-100">
            {accounts.length === 0 ? <div className="p-4 text-sm text-gray-400">没有写入账号 (可能账号都已有人设, 未覆盖)</div> :
              accounts.map((a) => (
                <div key={a.accountName} className="p-3">
                  <div className="flex items-center gap-2"><span className="text-sm font-medium text-gray-900">{a.accountName}</span><span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">{a.role}</span></div>
                  <div className="text-xs text-gray-500 mt-1">{a.persona}</div>
                </div>
              ))}
          </div>
          <button onClick={() => void genTopics()} disabled={busy}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "生成中…" : "生成选题池 (50条) →"}
          </button>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-800">
            ✅ 开通完成!企业画像、{accounts.length} 个账号定位、{topics.length} 条选题已就绪。
            接下来去「账号」页确认领域定位、「今日」页开启每日自动分发即可。
          </div>
          <div className="bg-white border border-gray-100 rounded-xl p-4">
            <div className="text-sm font-medium text-gray-700 mb-2">选题池预览 (前 20 条)</div>
            <div className="flex flex-wrap gap-1.5">
              {topics.slice(0, 20).map((t, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{t}</span>)}
            </div>
          </div>
          <button onClick={() => { setStep(1); setMaterials(""); setAnswers(Array(QUESTIONS.length).fill("")); setProfile(null); setAccounts([]); setTopics([]); }}
            className="text-sm text-indigo-600 hover:underline">再开通一个客户</button>
        </div>
      )}
    </div>
  );
}
