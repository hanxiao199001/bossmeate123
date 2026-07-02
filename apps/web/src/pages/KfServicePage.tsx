/**
 * 7-2 B-kf — 「AI 客服」管理页（企微微信客服，admin only）。
 * 布局照 SalesRadarPage 风格：tab 切换「会话」/「FAQ 管理」。
 *  - 会话：左列表（manual 标红）| 右消息流 + 人工回复 + auto/manual 切换
 *  - FAQ：表格 CRUD（问题/答案/启用/排序）
 * 后端：/admin/kf/*（routes/work-wechat-kf.ts）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../utils/api";
import { toast } from "../components/Toast";

interface KfConversation {
  id: string;
  openKfid: string;
  externalUserid: string;
  mode: "auto" | "manual";
  lastMsgAt: string | null;
  createdAt: string;
  lastMsgContent: string | null;
  lastMsgDirection: string | null;
}

interface KfMessage {
  id: string;
  direction: "in" | "out";
  msgType: string;
  content: string;
  aiIntent: string | null;
  aiAction: string | null;
  createdAt: string;
}

interface KfFaq {
  id: string;
  question: string;
  answer: string;
  enabled: boolean;
  sort: number;
}

const INTENT_LABEL: Record<string, string> = {
  journal_query: "期刊查询", service_faq: "服务FAQ", chitchat: "闲聊", handoff: "转人工",
};
const ACTION_LABEL: Record<string, string> = {
  answered: "AI已答", transferred: "已转人工", skipped: "跳过", manual: "人工", human_wecom: "企微端人工",
};

function relTime(t: string | null): string {
  if (!t) return "—";
  const d = Date.now() - new Date(t).getTime();
  const m = Math.floor(d / 60_000);
  if (m < 1) return "刚刚"; if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

/* ============ 会话 tab ============ */
function ConversationsTab() {
  const [convs, setConvs] = useState<KfConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<KfMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = convs.find((c) => c.id === activeId) ?? null;

  const loadConvs = useCallback(() => {
    api.get<{ items: KfConversation[] }>("/admin/kf/conversations?pageSize=100")
      .then((r) => setConvs(r.data?.items ?? []))
      .catch(() => setConvs([]));
  }, []);

  const loadMessages = useCallback((id: string) => {
    api.get<{ messages: KfMessage[] }>(`/admin/kf/conversations/${id}/messages`)
      .then((r) => setMessages(r.data?.messages ?? []))
      .catch(() => setMessages([]));
  }, []);

  useEffect(() => { loadConvs(); }, [loadConvs]);
  useEffect(() => { if (activeId) loadMessages(activeId); }, [activeId, loadMessages]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const toggleMode = async () => {
    if (!active) return;
    const mode = active.mode === "auto" ? "manual" : "auto";
    try {
      await api.post(`/admin/kf/conversations/${active.id}/mode`, { mode });
      toast.success(mode === "manual" ? "已切换为人工接管，AI 停止自动回复" : "已恢复 AI 自动回复");
      loadConvs();
    } catch { /* api 层已 toast */ }
  };

  const sendReply = async () => {
    if (!active || !draft.trim() || sending) return;
    setSending(true);
    try {
      const r = await api.post<{ sent: boolean }>(`/admin/kf/conversations/${active.id}/reply`, { text: draft.trim() });
      if (r.data && !r.data.sent) toast.warning("已记录，但企微未送达（可能超 48h 互动窗口）");
      setDraft("");
      loadMessages(active.id);
    } catch { /* api 层已 toast */ }
    finally { setSending(false); }
  };

  return (
    <div className="flex gap-4" style={{ height: "calc(100vh - 180px)" }}>
      {/* 左：会话列表 */}
      <aside className="w-72 shrink-0 bg-white rounded-2xl border border-gray-200 overflow-y-auto">
        {convs.length === 0 && (
          <p className="p-4 text-sm text-gray-400">暂无会话。客户通过微信客服发消息后会出现在这里。</p>
        )}
        <ul className="divide-y divide-gray-100">
          {convs.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActiveId(c.id)}
                className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${activeId === c.id ? "bg-indigo-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-800 truncate">{c.externalUserid}</span>
                  {/* manual 标红提醒运营跟进 */}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${c.mode === "manual" ? "bg-red-100 text-red-600" : "bg-emerald-100 text-emerald-600"}`}>
                    {c.mode === "manual" ? "人工" : "AI"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-xs text-gray-500 truncate">
                    {c.lastMsgDirection === "out" ? "[回] " : ""}{c.lastMsgContent ?? "（无消息）"}
                  </span>
                  <span className="text-[10px] text-gray-400 shrink-0">{relTime(c.lastMsgAt)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 右：消息流 + 回复 */}
      <section className="flex-1 bg-white rounded-2xl border border-gray-200 flex flex-col min-w-0">
        {!active ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">选择左侧会话查看消息</div>
        ) : (
          <>
            <header className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{active.externalUserid}</p>
                <p className="text-xs text-gray-400">客服账号: {active.openKfid}</p>
              </div>
              <button
                onClick={toggleMode}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                  active.mode === "manual"
                    ? "border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                    : "border-red-300 text-red-600 hover:bg-red-50"
                }`}
              >
                {active.mode === "manual" ? "恢复 AI 自动回复" : "切换人工接管"}
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
                    m.direction === "out" ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-800"
                  }`}>
                    <p className={m.msgType !== "text" ? "italic text-gray-400" : ""}>{m.content}</p>
                    <p className={`text-[10px] mt-1 ${m.direction === "out" ? "text-indigo-200" : "text-gray-400"}`}>
                      {m.aiIntent ? `${INTENT_LABEL[m.aiIntent] ?? m.aiIntent} · ` : ""}
                      {m.aiAction ? `${ACTION_LABEL[m.aiAction] ?? m.aiAction} · ` : ""}
                      {relTime(m.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            <footer className="p-3 border-t border-gray-100 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) sendReply(); }}
                placeholder={active.mode === "auto" ? "人工插话（不影响 AI 模式）…" : "输入人工回复…"}
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <button
                onClick={sendReply}
                disabled={sending || !draft.trim()}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700 transition-colors"
              >
                发送
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

/* ============ FAQ tab ============ */
const EMPTY_FAQ = { question: "", answer: "", enabled: true, sort: 0 };

function FaqTab() {
  const [faqs, setFaqs] = useState<KfFaq[]>([]);
  const [editing, setEditing] = useState<Partial<KfFaq> | null>(null); // null=收起; 无 id=新建
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<{ items: KfFaq[] }>("/admin/kf/faqs")
      .then((r) => setFaqs(r.data?.items ?? []))
      .catch(() => setFaqs([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing?.question?.trim() || !editing?.answer?.trim()) { toast.warning("问题和答案不能为空"); return; }
    setSaving(true);
    const body = { question: editing.question.trim(), answer: editing.answer.trim(), enabled: editing.enabled ?? true, sort: editing.sort ?? 0 };
    try {
      if (editing.id) await api.put(`/admin/kf/faqs/${editing.id}`, body);
      else await api.post("/admin/kf/faqs", body);
      toast.success("已保存");
      setEditing(null);
      load();
    } catch { /* api 层已 toast */ }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!window.confirm("确认删除这条 FAQ？")) return;
    try { await api.delete(`/admin/kf/faqs/${id}`); load(); } catch { /* api 层已 toast */ }
  };

  const toggleEnabled = async (f: KfFaq) => {
    try { await api.put(`/admin/kf/faqs/${f.id}`, { enabled: !f.enabled }); load(); } catch { /* api 层已 toast */ }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-xs text-gray-500">AI 只会按这里维护的 FAQ 回答服务类问题（生效上限 30 条），覆盖不了会自动转人工。</p>
        <button onClick={() => setEditing({ ...EMPTY_FAQ })} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700">
          + 新增 FAQ
        </button>
      </div>

      {editing && (
        <div className="bg-white rounded-2xl border border-indigo-200 p-4 space-y-3">
          <input
            value={editing.question ?? ""}
            onChange={(e) => setEditing({ ...editing, question: e.target.value })}
            placeholder="问题，如：你们的服务怎么收费？"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <textarea
            value={editing.answer ?? ""}
            onChange={(e) => setEditing({ ...editing, answer: e.target.value })}
            placeholder="标准答案（AI 将严格按此回答，不自由发挥）"
            rows={3}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
              启用
            </label>
            <label className="flex items-center gap-1.5 text-sm text-gray-600">
              排序
              <input
                type="number"
                value={editing.sort ?? 0}
                onChange={(e) => setEditing({ ...editing, sort: parseInt(e.target.value) || 0 })}
                className="w-16 border border-gray-200 rounded px-2 py-1 text-sm"
              />
            </label>
            <div className="flex-1" />
            <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消</button>
            <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700">
              保存
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-xs text-gray-500">
              <th className="px-4 py-2.5 font-medium">问题</th>
              <th className="px-4 py-2.5 font-medium">答案</th>
              <th className="px-4 py-2.5 font-medium w-16">排序</th>
              <th className="px-4 py-2.5 font-medium w-16">状态</th>
              <th className="px-4 py-2.5 font-medium w-28">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {faqs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">暂无 FAQ，点右上角新增</td></tr>
            )}
            {faqs.map((f) => (
              <tr key={f.id} className={f.enabled ? "" : "opacity-50"}>
                <td className="px-4 py-2.5 text-gray-800 max-w-[200px] truncate">{f.question}</td>
                <td className="px-4 py-2.5 text-gray-600 max-w-[320px] truncate">{f.answer}</td>
                <td className="px-4 py-2.5 text-gray-500">{f.sort}</td>
                <td className="px-4 py-2.5">
                  <button onClick={() => toggleEnabled(f)} className={`text-xs px-2 py-0.5 rounded-full ${f.enabled ? "bg-emerald-100 text-emerald-600" : "bg-gray-100 text-gray-500"}`}>
                    {f.enabled ? "启用" : "停用"}
                  </button>
                </td>
                <td className="px-4 py-2.5 space-x-2">
                  <button onClick={() => setEditing({ ...f })} className="text-xs text-indigo-600 hover:underline">编辑</button>
                  <button onClick={() => remove(f.id)} className="text-xs text-red-500 hover:underline">删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ 页面骨架 ============ */
export default function KfServicePage() {
  const [tab, setTab] = useState<"conversations" | "faqs">("conversations");

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-6xl mx-auto px-6 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">AI 客服</h1>
          <p className="text-xs text-gray-500 mt-0.5">企业微信「微信客服」：AI 自动应答期刊/服务咨询，拿不准自动转人工</p>
        </div>

        <div className="flex items-center gap-1 border-b border-gray-200">
          {([["conversations", "会话"], ["faqs", "FAQ 管理"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                tab === key ? "border-indigo-600 text-indigo-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "conversations" ? <ConversationsTab /> : <FaqTab />}
      </main>
    </div>
  );
}
