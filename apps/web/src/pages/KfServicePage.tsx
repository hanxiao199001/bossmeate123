/**
 * 7-2 B-kf — 「AI 客服」管理页（企微微信客服，admin only）。
 * 布局照 SalesRadarPage 风格：tab 切换「概览」/「会话」/「FAQ 管理」/「企微设置」。
 *  - 概览（默认打开，运营每天第一眼）：今日数卡 + 近7天柱条 + "AI 没答上"清单 + agentSecret 漏配警示
 *  - 会话：左列表（manual 置顶标红 + 只看待人工筛选）| 右消息流 + 人工回复 + auto/manual 切换
 *  - FAQ：表格 CRUD（问题/答案/启用/排序）
 *  - 企微设置：配置表单 + agentSecret 漏配警示条
 * 后端：/admin/kf/*（routes/work-wechat-kf.ts）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../utils/api";
import { toast } from "../components/Toast";
import { parseFaqText, parseFaqCsv, type ParsedFaq } from "../utils/faqParse";

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

/* —— 概览统计（GET /admin/kf/stats）—— */
interface KfStatBucket {
  conversations: number;
  customerMessages: number;
  aiReplies: number;
  handoffs: number;
  manualReplies: number;
  blockedSensitive: number;
}
interface KfDailyStat extends KfStatBucket { date: string }
interface KfUnansweredItem {
  conversationId: string;
  externalUserid: string;
  question: string | null;
  transferredAt: string | null;
  sensitiveBlocked?: boolean;
}
interface KfStatsData {
  days: number;
  today: KfDailyStat;
  period: KfStatBucket;
  daily: KfDailyStat[];
  unanswered: KfUnansweredItem[];
  agentSecretConfigured: boolean;
}

/** 从概览跳会话 tab 的初始态（只看待人工 / 直接打开某会话） */
interface ConvInit { manualOnly?: boolean; conversationId?: string }

const INTENT_LABEL: Record<string, string> = {
  journal_query: "期刊查询", service_faq: "服务FAQ", chitchat: "闲聊", handoff: "转人工",
};
const ACTION_LABEL: Record<string, string> = {
  answered: "AI已答", transferred: "已转人工", skipped: "跳过", manual: "人工", human_wecom: "企微端人工",
  blocked_sensitive: "敏感词拦截·未外发",
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

/* ============ 概览 tab（运营每天第一眼：客服活着没 + 哪些没答上） ============ */
function OverviewTab({ manualTotal, onGoManual, onOpenConversation, onGoConfig }: {
  manualTotal: number;
  onGoManual: () => void;
  onOpenConversation: (id: string) => void;
  onGoConfig: () => void;
}) {
  const [stats, setStats] = useState<KfStatsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<KfStatsData>("/admin/kf/stats?days=7")
      .then((r) => setStats(r.data ?? null))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="py-12 text-center text-sm text-gray-400">统计加载中…</p>;
  if (!stats) return <p className="py-12 text-center text-sm text-gray-400">统计加载失败，请刷新重试</p>;

  const { today, period, daily, unanswered } = stats;
  const maxMsg = Math.max(...daily.map((d) => d.customerMessages), 1);

  const cards: Array<{ label: string; value: number; sub: string; danger?: boolean; onClick?: () => void }> = [
    { label: "今日会话", value: today.conversations, sub: `客户消息 ${today.customerMessages} 条` },
    { label: "今日 AI 答", value: today.aiReplies, sub: `近 ${stats.days} 天共 ${period.aiReplies} 条` },
    { label: "今日转人工", value: today.handoffs, sub: manualTotal > 0 ? `${manualTotal} 个会话待人工处理，点击查看` : "点击查看会话", danger: true, onClick: onGoManual },
    { label: "今日人工答", value: today.manualReplies, sub: `近 ${stats.days} 天共 ${period.manualReplies} 条` },
  ];

  return (
    <div className="space-y-4">
      {/* agentSecret 漏配 + 近7天有转人工 → 运营最可能在这里看到的警示 */}
      {!stats.agentSecretConfigured && period.handoffs > 0 && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
          <p className="flex-1 text-sm text-amber-800">
            近 {stats.days} 天发生过 <b>{period.handoffs} 次转人工</b>，但尚未配置企业应用 Secret ——
            客户转人工时<b>不会推送通知给运营</b>，客户会一直在企微「待接入池」等待。强烈建议现在配置。
          </p>
          <button onClick={onGoConfig} className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-sm hover:bg-amber-600">
            去配置
          </button>
        </div>
      )}

      {/* 4 张数卡 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={c.onClick}
            disabled={!c.onClick}
            className={`text-left bg-white rounded-2xl border p-4 transition-colors ${
              c.onClick ? "border-gray-200 hover:border-red-300 hover:bg-red-50/40 cursor-pointer" : "border-gray-200 cursor-default"
            }`}
          >
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-2xl font-semibold mt-1 ${c.danger && c.value > 0 ? "text-red-600" : "text-gray-900"}`}>{c.value}</p>
            <p className="text-[11px] text-gray-400 mt-1">{c.sub}</p>
          </button>
        ))}
      </div>

      {/* 敏感词出站拦截：N=0 不显示（多数租户永远看不到这行才是常态） */}
      {period.blockedSensitive > 0 && (
        <p className="text-[11px] text-red-500 px-1">
          其中敏感词拦截 {period.blockedSensitive} 次（今日 {today.blockedSensitive} 次）—— AI 回复命中敏感词库被拦下未外发，已自动转人工，可在下方清单查看对应会话
        </p>
      )}

      {/* 近 7 天趋势（纯 div 柱条，不引图表库） */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-800">近 {stats.days} 天趋势</p>
          <p className="text-[11px] text-gray-400">柱高 = 客户消息条数；日期标红 = 当天有转人工</p>
        </div>
        <div className="flex items-end gap-2 h-28 pt-2">
          {daily.map((d) => (
            <div
              key={d.date}
              className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0"
              title={`${d.date}\n会话 ${d.conversations} · 客户消息 ${d.customerMessages}\nAI答 ${d.aiReplies} · 转人工 ${d.handoffs} · 人工答 ${d.manualReplies}`}
            >
              <span className="text-[10px] text-gray-400">{d.customerMessages > 0 ? d.customerMessages : ""}</span>
              <div
                className={`w-full max-w-[40px] rounded-t ${d.customerMessages > 0 ? "bg-indigo-500/80" : "bg-gray-100"}`}
                style={{ height: `${d.customerMessages > 0 ? Math.max((d.customerMessages / maxMsg) * 72, 6) : 2}px` }}
              />
              <span className={`text-[10px] ${d.handoffs > 0 ? "text-red-500 font-medium" : "text-gray-400"}`}>
                {d.date.slice(5)}{d.handoffs > 0 ? ` (${d.handoffs})` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* AI 没答上的问题（转人工前客户原话）→ 补 FAQ 的直接依据 */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <header className="px-4 py-3 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-800">AI 没答上的问题（最近转人工）</p>
          <p className="text-[11px] text-gray-400 mt-0.5">这些是转人工前客户的原话 —— 把常见的补进「FAQ 管理」，下次 AI 就能自己答</p>
        </header>
        {unanswered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">AI 都答上了，近 {stats.days} 天暂无转人工</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {unanswered.map((u, i) => (
              <li key={`${u.conversationId}-${i}`} className="px-4 py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 truncate">{u.question ?? "（客户未发文本消息，可能是图片/语音）"}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">客户 {u.externalUserid.slice(0, 12)}… · {relTime(u.transferredAt)}</p>
                </div>
                {u.sensitiveBlocked && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">触发敏感词拦截</span>
                )}
                <button
                  onClick={() => onOpenConversation(u.conversationId)}
                  className="shrink-0 text-xs text-indigo-600 hover:underline"
                >
                  查看会话
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ============ 会话 tab ============ */
function ConversationsTab({ init, onManualChanged }: { init: ConvInit | null; onManualChanged: () => void }) {
  const [convs, setConvs] = useState<KfConversation[]>([]);
  const [manualOnly, setManualOnly] = useState(!!init?.manualOnly);
  const [activeId, setActiveId] = useState<string | null>(init?.conversationId ?? null);
  const [messages, setMessages] = useState<KfMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const active = convs.find((c) => c.id === activeId) ?? null;
  const manualCount = convs.filter((c) => c.mode === "manual").length;
  // manual 置顶（sort 稳定，组内保持服务端"最近消息在前"顺序）；可选只看待人工
  const displayed = (manualOnly ? convs.filter((c) => c.mode === "manual") : convs)
    .slice()
    .sort((a, b) => (a.mode === "manual" ? 0 : 1) - (b.mode === "manual" ? 0 : 1));

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
      onManualChanged(); // 刷新 tab 标题上的待处理角标
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
      {/* 左：会话列表（manual 置顶 + 待处理计数 + 只看待人工筛选） */}
      <aside className="w-72 shrink-0 bg-white rounded-2xl border border-gray-200 overflow-y-auto">
        <div className="sticky top-0 bg-white px-4 py-2 border-b border-gray-100 flex items-center justify-between gap-2 text-xs">
          {manualCount > 0
            ? <span className="text-red-600 font-medium">待人工处理 {manualCount}</span>
            : <span className="text-gray-400">暂无待人工</span>}
          <label className="flex items-center gap-1 text-gray-500 shrink-0">
            <input type="checkbox" checked={manualOnly} onChange={(e) => setManualOnly(e.target.checked)} />
            只看待人工
          </label>
        </div>
        {displayed.length === 0 && (
          <p className="p-4 text-sm text-gray-400">
            {manualOnly ? "没有待人工处理的会话" : "暂无会话。客户通过微信客服发消息后会出现在这里。"}
          </p>
        )}
        <ul className="divide-y divide-gray-100">
          {displayed.map((c) => (
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

/* ============ 批量导入弹窗 ============ */
interface ImportRow extends ParsedFaq { selected: boolean }
const PASTE_EXAMPLE = "你们怎么收费？|按套餐报价，具体请咨询顾问\n审稿周期一般多久？|通常 1-3 个月，视期刊而定\n\n或用 Q/A 格式：\nQ: 你们是代写吗？\nA: 不是，我们只做投稿咨询与期刊推荐";

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [source, setSource] = useState<"paste" | "file">("paste");
  const [pasteText, setPasteText] = useState("");
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [mode, setMode] = useState<"skip" | "update">("skip");
  const [importing, setImporting] = useState(false);
  const [parsed, setParsed] = useState(false);

  const doParse = (res: { items: ParsedFaq[]; errors: string[] }) => {
    setRows(res.items.map((it) => ({ ...it, selected: true })));
    setErrors(res.errors);
    setParsed(true);
  };

  const parsePaste = () => {
    if (!pasteText.trim()) { toast.warning("请先粘贴内容"); return; }
    doParse(parseFaqText(pasteText));
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => doParse(parseFaqCsv(String(reader.result ?? "")));
    reader.onerror = () => toast.error("文件读取失败");
    reader.readAsText(file, "utf-8");
  };

  const selectedCount = rows.filter((r) => r.selected).length;

  const confirmImport = async () => {
    const items = rows.filter((r) => r.selected).map((r) => ({ question: r.question, answer: r.answer }));
    if (items.length === 0) { toast.warning("请至少勾选一条"); return; }
    setImporting(true);
    try {
      const r = await api.post<{ imported: number; updated: number; skipped: number; duplicated: number; failed: number }>(
        "/admin/kf/faqs/import", { items, mode });
      const d = r.data;
      if (d) {
        toast.success(`导入完成：新增 ${d.imported}，更新 ${d.updated}，跳过 ${d.skipped}${d.duplicated ? `，批内去重 ${d.duplicated}` : ""}${d.failed ? `，失败 ${d.failed}` : ""}`);
      }
      onImported();
      onClose();
    } catch { /* api 层已 toast */ }
    finally { setImporting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">批量导入 FAQ</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </header>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {/* 输入方式切换 */}
          <div className="flex gap-1 border-b border-gray-200">
            {([["paste", "粘贴文本"], ["file", "上传 CSV"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => { setSource(k); setParsed(false); setRows([]); }}
                className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${source === k ? "border-indigo-600 text-indigo-600 font-medium" : "border-transparent text-gray-500"}`}>
                {l}
              </button>
            ))}
          </div>

          {source === "paste" ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">每行一条「问题 | 答案」（竖线分隔），或用「Q: … / A: …」成对格式。空行忽略。</p>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6}
                placeholder={PASTE_EXAMPLE}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-200" />
              <button onClick={parsePaste} className="px-3 py-1.5 rounded-lg bg-gray-800 text-white text-sm hover:bg-gray-700">解析预览</button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">上传两列 CSV（第一列问题、第二列答案，可含表头）。Excel 请先「另存为 CSV」再上传。</p>
              <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="text-sm" />
              {fileName && <span className="text-xs text-gray-400">已选择：{fileName}</span>}
            </div>
          )}

          {errors.length > 0 && (
            <div className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
              {errors.length} 行无法解析（已忽略）：{errors.slice(0, 3).join("；")}{errors.length > 3 ? " …" : ""}
            </div>
          )}

          {parsed && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>解析出 {rows.length} 条，勾选 {selectedCount} 条</span>
                {rows.length > 0 && (
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={selectedCount === rows.length}
                      onChange={(e) => setRows(rows.map((r) => ({ ...r, selected: e.target.checked })))} />
                    全选
                  </label>
                )}
              </div>
              <div className="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
                {rows.length === 0 ? (
                  <p className="p-4 text-center text-gray-400 text-sm">没有解析到有效问答</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100">
                      {rows.map((r, i) => (
                        <tr key={i} className={r.selected ? "" : "opacity-40"}>
                          <td className="px-2 py-2 w-8">
                            <input type="checkbox" checked={r.selected}
                              onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))} />
                          </td>
                          <td className="px-2 py-2 text-gray-800 max-w-[160px] truncate">{r.question}</td>
                          <td className="px-2 py-2 text-gray-600 max-w-[280px] truncate">{r.answer}</td>
                          <td className="px-2 py-2 w-10">
                            <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600">删</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-gray-100 flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <span>重复问题</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "skip" | "update")}
              className="border border-gray-200 rounded px-2 py-1 text-xs">
              <option value="skip">跳过</option>
              <option value="update">覆盖答案</option>
            </select>
          </label>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消</button>
          <button onClick={confirmImport} disabled={importing || selectedCount === 0}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700">
            导入 {selectedCount} 条
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============ 从历史对话生成建议 ============ */
interface SuggestRow { question: string; answer: string; selected: boolean }

function SuggestModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SuggestRow[]>([]);
  const [msg, setMsg] = useState("");
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get<{ suggestions: ParsedFaq[]; scanned: number; message?: string }>("/admin/kf/faq-suggestions")
      .then((r) => {
        setRows((r.data?.suggestions ?? []).map((s) => ({ ...s, selected: true })));
        setMsg(r.data?.message ?? "");
      })
      .catch(() => setMsg("生成失败，请稍后重试"))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const selectedCount = rows.filter((r) => r.selected).length;

  const adopt = async () => {
    const items = rows.filter((r) => r.selected && r.question.trim() && r.answer.trim())
      .map((r) => ({ question: r.question.trim(), answer: r.answer.trim() }));
    if (items.length === 0) { toast.warning("请至少勾选一条有效建议"); return; }
    setImporting(true);
    try {
      const r = await api.post<{ imported: number; skipped: number }>("/admin/kf/faqs/import", { items, mode: "skip" });
      toast.success(`已采纳：新增 ${r.data?.imported ?? 0}，跳过 ${r.data?.skipped ?? 0}`);
      onImported();
      onClose();
    } catch { /* api 层已 toast */ }
    finally { setImporting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">从历史对话生成建议</h3>
            <p className="text-xs text-gray-400 mt-0.5">AI 从人工接管过的会话里提炼候选问答，你可编辑后采纳入库（不会自动入库）</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </header>

        <div className="px-5 py-4 overflow-y-auto space-y-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-gray-400">AI 正在从历史对话中提炼建议…</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">{msg || "暂无可提炼的建议"}</p>
          ) : (
            rows.map((r, i) => (
              <div key={i} className={`border rounded-xl p-3 space-y-2 ${r.selected ? "border-indigo-200" : "border-gray-200 opacity-50"}`}>
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={r.selected} className="mt-2"
                    onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))} />
                  <div className="flex-1 space-y-1.5">
                    <input value={r.question}
                      onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, question: e.target.value } : x))}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                    <textarea value={r.answer} rows={2}
                      onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, answer: e.target.value } : x))}
                      className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                  <button onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600 mt-2">删</button>
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="px-5 py-3 border-t border-gray-100 flex items-center gap-3">
          <button onClick={load} disabled={loading} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-40">重新生成</button>
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消</button>
          <button onClick={adopt} disabled={importing || selectedCount === 0}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700">
            采纳 {selectedCount} 条
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============ FAQ tab ============ */
const EMPTY_FAQ = { question: "", answer: "", enabled: true, sort: 0 };

function FaqTab() {
  const [faqs, setFaqs] = useState<KfFaq[]>([]);
  const [editing, setEditing] = useState<Partial<KfFaq> | null>(null); // null=收起; 无 id=新建
  const [saving, setSaving] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);

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
      <div className="flex justify-between items-center gap-2">
        <p className="text-xs text-gray-500">AI 只会按这里维护的 FAQ 回答服务类问题（生效上限 30 条），覆盖不了会自动转人工。</p>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowSuggest(true)} className="px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 text-sm hover:bg-indigo-50">
            从历史对话生成建议
          </button>
          <button onClick={() => setShowImport(true)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50">
            批量导入
          </button>
          <button onClick={() => setEditing({ ...EMPTY_FAQ })} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700">
            + 新增 FAQ
          </button>
        </div>
      </div>

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={load} />}
      {showSuggest && <SuggestModal onClose={() => setShowSuggest(false)} onImported={load} />}

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

/* ============ 企微设置 tab ============ */
interface WwConfigStatus {
  configured: boolean;
  corpId?: string;
  agentId?: string;
  token?: string;
  hasEncodingAesKey?: boolean;
  hasKfSecret?: boolean;
  hasAgentSecret?: boolean;
  notifyUserids?: string;
  openKfids?: string[];
  updatedAt?: string;
}

const SECRET_PLACEHOLDER = "●●●●●●●●（已配置，留空则不改）";

function ConfigTab() {
  const [status, setStatus] = useState<WwConfigStatus | null>(null);
  const [form, setForm] = useState({ corpId: "", agentId: "", token: "", encodingAesKey: "", kfSecret: "", agentSecret: "", notifyUserIds: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    api.get<WwConfigStatus>("/admin/work-wechat/config")
      .then((r) => {
        const d = r.data;
        setStatus(d ?? { configured: false });
        if (d?.configured) {
          setForm((f) => ({ ...f, corpId: d.corpId ?? "", agentId: d.agentId ?? "", token: d.token ?? "", notifyUserIds: d.notifyUserids ?? "" }));
        }
      })
      .catch(() => setStatus({ configured: false }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form.corpId.trim() || !form.agentId.trim() || !form.token.trim()) { toast.warning("corpId / agentId / 回调 Token 必填"); return; }
    if (!status?.configured && !form.encodingAesKey.trim()) { toast.warning("首次配置必须填写 EncodingAESKey"); return; }
    if (form.encodingAesKey && form.encodingAesKey.length !== 43) { toast.warning("EncodingAESKey 必须是 43 个字符"); return; }
    setSaving(true);
    // 只提交填了的 Secret 字段（留空 = 保留旧值，对齐后端"省略保留旧值"逻辑）
    const body: Record<string, string> = {
      corpId: form.corpId.trim(), agentId: form.agentId.trim(), token: form.token.trim(),
      notifyUserIds: form.notifyUserIds.trim(),
    };
    if (form.encodingAesKey.trim()) body.encodingAesKey = form.encodingAesKey.trim();
    if (form.kfSecret.trim()) body.kfSecret = form.kfSecret.trim();
    if (form.agentSecret.trim()) body.agentSecret = form.agentSecret.trim();
    try {
      await api.put("/admin/work-wechat/config", body);
      toast.success("企微配置已保存");
      setForm((f) => ({ ...f, encodingAesKey: "", kfSecret: "", agentSecret: "" })); // 清空敏感输入
      load();
    } catch { /* api 层已 toast */ }
    finally { setSaving(false); }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const r = await api.get<{ ok: boolean; error?: string }>("/admin/work-wechat/test");
      if (r.data?.ok) toast.success("连接成功，凭证有效");
      else toast.error(`连接失败：${r.data?.error ?? "未知原因"}`);
    } catch { /* api 层已 toast */ }
    finally { setTesting(false); }
  };

  const field = (label: string, key: keyof typeof form, opts: { placeholder?: string; secret?: boolean; hint?: string } = {}) => (
    <label className="block space-y-1">
      <span className="text-sm text-gray-700">{label}</span>
      <input
        type={opts.secret ? "password" : "text"}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={opts.placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
      />
      {opts.hint && <span className="text-xs text-gray-400">{opts.hint}</span>}
    </label>
  );

  return (
    <div className="max-w-2xl space-y-4">
      {/* agentSecret 漏配警示：不配则转人工无通知，客户在待接入池干等 */}
      {status && !status.hasAgentSecret && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3">
          <p className="text-sm text-amber-800">
            <b>未配置企业应用 Secret：</b>客户转人工时<b>不会推送通知给运营</b>，客户会在企微「待接入池」一直等待、无人知晓。
            强烈建议在下方「自建应用 Secret」填入并保存。
          </p>
        </div>
      )}

      {/* 配置状态 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-800">
              配置状态：
              {status?.configured
                ? <span className="text-emerald-600">已配置</span>
                : <span className="text-gray-400">未配置</span>}
            </p>
            {status?.configured && (
              <p className="text-xs text-gray-400 mt-1">
                客服 Secret {status.hasKfSecret ? "已配" : "未配"} · 自建应用 Secret {status.hasAgentSecret ? "已配" : "未配"}
                {status.openKfids && status.openKfids.length > 0 && <> · 客服账号：{status.openKfids.join("、")}</>}
              </p>
            )}
          </div>
          <button onClick={testConnection} disabled={testing || !status?.configured}
            className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-40">
            {testing ? "测试中…" : "测试连接"}
          </button>
        </div>
      </div>

      {/* 配置表单 */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        {field("企业 ID（corpId）", "corpId", { placeholder: "ww 开头的企业 corpid" })}
        {field("自建应用 AgentId", "agentId", { placeholder: "自建应用的 agentid（数字）" })}
        {field("回调 Token", "token", { placeholder: "回调配置里的 Token" })}
        {field("EncodingAESKey", "encodingAesKey", {
          placeholder: status?.configured ? SECRET_PLACEHOLDER : "43 位 EncodingAESKey",
          hint: "回调配置里的消息加解密密钥，固定 43 字符",
        })}
        {field("微信客服 Secret", "kfSecret", {
          secret: true, placeholder: status?.hasKfSecret ? SECRET_PLACEHOLDER : "微信客服的 Secret（gettoken 用）",
          hint: "「微信客服」管理后台获取，用于收发客服消息",
        })}
        {field("自建应用 Secret", "agentSecret", {
          secret: true, placeholder: status?.hasAgentSecret ? SECRET_PLACEHOLDER : "自建应用 Secret（转人工通知运营用）",
          hint: "转人工时给运营推通知；不填则不推通知",
        })}
        {field("通知运营 userids", "notifyUserIds", {
          placeholder: "运营的企微 userid，逗号分隔；留空 = @all",
          hint: "转人工通知发给谁；清空并保存 = 回退 @all",
        })}

        <div className="flex items-center gap-3 pt-1">
          <p className="text-xs text-gray-400 flex-1">Secret 类字段只写不读，已配置的显示占位，留空表示不修改。</p>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700">
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============ 页面骨架 ============ */
type TabKey = "overview" | "conversations" | "faqs" | "config";

export default function KfServicePage() {
  const [tab, setTab] = useState<TabKey>("overview"); // 概览默认打开：运营每天第一眼
  const [manualTotal, setManualTotal] = useState(0);  // 待人工处理会话总数（tab 角标）
  const [convInit, setConvInit] = useState<ConvInit | null>(null);

  const refreshManualTotal = useCallback(() => {
    api.get<{ total: number }>("/admin/kf/conversations?mode=manual&pageSize=1")
      .then((r) => setManualTotal(r.data?.total ?? 0))
      .catch(() => { /* 角标失败不打扰 */ });
  }, []);
  useEffect(() => { refreshManualTotal(); }, [refreshManualTotal, tab]);

  /** 从概览跳会话 tab（带初始筛选/定位） */
  const openConversations = (init: ConvInit | null) => {
    setConvInit(init);
    setTab("conversations");
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-6xl mx-auto px-6 py-6 space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">AI 客服</h1>
          <p className="text-xs text-gray-500 mt-0.5">企业微信「微信客服」：AI 自动应答期刊/服务咨询，拿不准自动转人工</p>
        </div>

        <div className="flex items-center gap-1 border-b border-gray-200">
          {([["overview", "概览"], ["conversations", "会话"], ["faqs", "FAQ 管理"], ["config", "企微设置"]] as Array<[TabKey, string]>).map(([key, label]) => (
            <button
              key={key}
              onClick={() => { if (key === "conversations") setConvInit(null); setTab(key); }}
              className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                tab === key ? "border-indigo-600 text-indigo-600 font-medium" : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
              {key === "conversations" && manualTotal > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] align-middle">
                  {manualTotal > 99 ? "99+" : manualTotal}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "overview" && (
          <OverviewTab
            manualTotal={manualTotal}
            onGoManual={() => openConversations({ manualOnly: true })}
            onOpenConversation={(id) => openConversations({ conversationId: id })}
            onGoConfig={() => setTab("config")}
          />
        )}
        {tab === "conversations" && <ConversationsTab init={convInit} onManualChanged={refreshManualTotal} />}
        {tab === "faqs" && <FaqTab />}
        {tab === "config" && <ConfigTab />}
      </main>
    </div>
  );
}
