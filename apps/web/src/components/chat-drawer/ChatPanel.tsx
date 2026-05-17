/**
 * 5-21 P3 — slim chat panel: 消息流 + 输入框 + 发送.
 * 复用 ChatPage 的 /chat API (普通 POST 非 SSE, 实测过).
 * 简化: 只支持当前 conversation (新建 / localStorage 续上次). skill 切换 dropdown 在顶部.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../../utils/api";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
}

interface Conversation {
  id: string;
  title?: string;
  skillType?: string;
}

const LAST_CONV_KEY = "bossmate.chatDrawer.lastConvId";
const SKILLS: Array<{ value: string; label: string }> = [
  { value: "general", label: "通用" },
  { value: "article", label: "图文" },
  { value: "video", label: "视频" },
  { value: "customer_service", label: "客服" },
];

export default function ChatPanel() {
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [skillType, setSkillType] = useState("general");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 初始: 拿 localStorage 上次 conv 或创建新
  useEffect(() => {
    const last = (typeof localStorage !== "undefined") ? localStorage.getItem(LAST_CONV_KEY) : null;
    if (last) {
      setConvId(last);
      api.get<{ messages?: Message[] }>(`/chat/conversations/${last}/messages`)
        .then((r) => {
          const msgs = ((r as any).data?.messages ?? (r as any).data ?? []) as Message[];
          setMessages(Array.isArray(msgs) ? msgs : []);
        })
        .catch(() => { /* 静默, 用户可新建 */ });
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function ensureConversation(): Promise<string> {
    if (convId) return convId;
    const res = await api.post<Conversation>("/chat/conversations", { skillType });
    const newId = (res as any).data?.id;
    if (newId) {
      setConvId(newId);
      try { localStorage.setItem(LAST_CONV_KEY, newId); } catch { /* ignore */ }
      return newId;
    }
    throw new Error("创建会话失败");
  }

  async function handleSend() {
    const content = input.trim();
    if (!content || sending) return;
    setSending(true);
    setInput("");
    // 乐观加 user msg
    const tempUser: Message = { id: `tmp-${Date.now()}`, role: "user", content };
    setMessages((prev) => [...prev, tempUser]);
    try {
      const id = await ensureConversation();
      const res = await api.post<{ assistantMessage?: Message }>(`/chat/conversations/${id}/messages`, { content, skillType });
      const am = (res as any).data?.assistantMessage as Message | undefined;
      if (am) setMessages((prev) => [...prev, am]);
    } catch (err) {
      setMessages((prev) => [...prev, { id: `err-${Date.now()}`, role: "system", content: "发送失败: " + (err instanceof Error ? err.message : "未知") }]);
    } finally {
      setSending(false);
    }
  }

  function handleNewConv() {
    setConvId(null);
    setMessages([]);
    try { localStorage.removeItem(LAST_CONV_KEY); } catch { /* ignore */ }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-2 shrink-0">
        <button onClick={handleNewConv} className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200 text-gray-700">+ 新对话</button>
        <select value={skillType} onChange={(e) => setSkillType(e.target.value)} className="px-2 py-1 text-xs border border-gray-300 rounded bg-white">
          {SKILLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-gray-50">
        {messages.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-8">向 BossMate 助手提问…</p>
        ) : messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
              m.role === "user" ? "bg-blue-600 text-white"
                : m.role === "system" ? "bg-amber-50 text-amber-700 border border-amber-200"
                : "bg-white text-gray-800 border border-gray-200"
            }`}>{m.content}</div>
          </div>
        ))}
      </div>

      <div className="px-3 py-3 border-t border-gray-200 bg-white shrink-0">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            rows={2}
            placeholder="问点什么…（Enter 发送 / Shift+Enter 换行）"
            className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded resize-none"
            disabled={sending}
          />
          <button onClick={handleSend} disabled={sending || !input.trim()} className="px-3 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300">
            {sending ? "…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
