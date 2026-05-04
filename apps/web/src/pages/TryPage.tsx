/**
 * BossMate 公开 onboarding 页 —— /try（PR B.9）
 *
 * 客户来源：公众号订阅号 hard guard 罐头里推的 BossMate 平台 URL。
 * 路径：填论文摘要 → AI 3 秒匹配 5 本最对口期刊 → CTA 引导注册解锁完整功能。
 *
 * 公开（无 auth），用直接 fetch 避免 utils/api.ts 的 401 跳转 + toast 干扰。
 */
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";

interface JournalMatch {
  name: string;
  discipline: string;
  partition: string;
  impactFactor: number;
  reason: string;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export default function TryPage() {
  const [abstract, setAbstract] = useState("");
  const [matches, setMatches] = useState<JournalMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    postJSON("/public/telemetry", { event: "viewed" }).catch(() => { /* fire-and-forget */ });
  }, []);

  async function onSubmit() {
    if (abstract.trim().length < 50) { setErr("摘要请至少 50 字"); return; }
    setErr(null); setLoading(true); setMatches(null);
    try {
      const data = await postJSON<{ matches: JournalMatch[] }>("/public/match-journals", { abstract });
      setMatches(data.matches);
    } catch (e: any) {
      setErr(e?.message || "AI 匹配失败");
    } finally {
      setLoading(false);
    }
  }

  function onSignupClick() {
    postJSON("/public/telemetry", { event: "signup_clicked" }).catch(() => { /* fire-and-forget */ });
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-950 via-slate-900 to-purple-950 text-white p-6">
      <div className="max-w-3xl mx-auto py-8">
        <h1 className="text-3xl font-bold mb-2">BossMate · AI 期刊匹配（免费试用）</h1>
        <p className="text-gray-300 mb-6">贴上你的论文摘要，AI 3 秒帮你匹配 5 本最对口期刊。</p>
        <textarea
          className="w-full p-4 rounded bg-slate-800 text-white border border-slate-600 focus:border-indigo-400 outline-none"
          rows={8}
          placeholder="把论文摘要粘贴到这里（中文或英文均可，至少 50 字）..."
          value={abstract}
          onChange={(e) => setAbstract(e.target.value)}
          disabled={loading}
        />
        {err && <div className="mt-2 text-red-400 text-sm">{err}</div>}
        <button
          onClick={onSubmit}
          disabled={loading || abstract.trim().length < 50}
          className="mt-4 px-6 py-3 bg-indigo-500 hover:bg-indigo-400 disabled:bg-slate-700 disabled:cursor-not-allowed rounded font-semibold"
        >
          {loading ? "AI 匹配中…" : "开始匹配"}
        </button>

        {matches && (
          <div className="mt-8 space-y-3">
            <h2 className="text-xl font-semibold mb-3">为你推荐的 5 本期刊</h2>
            {matches.map((m, i) => (
              <div key={i} className="p-4 bg-slate-800/70 border border-slate-700 rounded">
                <div className="flex items-start justify-between gap-4">
                  <div className="font-semibold text-lg text-indigo-300">{m.name}</div>
                  <div className="text-sm text-gray-400 whitespace-nowrap">{m.partition} · IF {m.impactFactor}</div>
                </div>
                {m.discipline && <div className="text-sm text-gray-400 mt-1">{m.discipline}</div>}
                <div className="text-sm text-gray-200 mt-2">推荐理由：{m.reason}</div>
              </div>
            ))}
            <div className="mt-6 p-5 bg-indigo-500/10 border border-indigo-400/40 rounded">
              <div className="font-semibold mb-1">想看完整数据？</div>
              <div className="text-sm text-gray-300 mb-3">注册 BossMate 解锁：影响因子曲线 / 录用率历史 / 自引率风险 / 出版费 / 审稿周期 / 一键投稿模板</div>
              <Link to="/register" onClick={onSignupClick} className="inline-block px-5 py-2 bg-indigo-500 hover:bg-indigo-400 rounded font-semibold">
                免费注册解锁完整功能 →
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
