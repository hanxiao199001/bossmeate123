/**
 * 销售 CRM（AI 客服管理台）
 * 左栏：lead 列表（搜索/筛选/未读数/徽章）
 * 右栏：对话窗口（消息气泡 + 接管/交还 + 人工输入）
 * 轮询：每 20 秒拉一次列表 + 当前选中 lead
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ===== 类型 =====
type Stage =
  | "new"
  | "contacted"
  | "qualified"
  | "negotiating"
  | "won"
  | "lost"
  | "need_human";

type HandoverMode = "ai" | "human";

interface Lead {
  id: string;
  tenantId: string;
  channel: string;
  externalId: string | null;
  name: string | null;
  contactId: string | null;
  phone: string | null;
  email: string | null;
  sourceContentId: string | null;
  profile: Record<string, unknown> | null;
  stage: Stage;
  intentScore: number | null;
  assignedUserId: string | null;
  lastMessageAt: string | null;
  handoverMode: HandoverMode;
  takenOverBy: string | null;
  takenOverAt: string | null;
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
  unreadCount?: number;
}

interface SalesMessage {
  id: string;
  tenantId: string;
  leadId: string;
  direction: "inbound" | "outbound";
  kind: string;
  content: string;
  isAiGenerated: boolean | null;
  sentAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface LeadListResp {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

interface LeadDetailResp {
  lead: Lead;
  messages: SalesMessage[];
}

interface SalesStats {
  totalLeads: number;
  unreadLeads: number;
  needHumanCount: number;
  humanModeCount: number;
}

// ===== 常量 =====
const STAGE_LABELS: Record<Stage, string> = {
  new: "新线索",
  contacted: "已联系",
  qualified: "已合格",
  negotiating: "洽谈中",
  won: "成交",
  lost: "流失",
  need_human: "需关注",
};

const STAGE_COLORS: Record<Stage, string> = {
  new: "bg-gray-100 text-gray-600",
  contacted: "bg-blue-100 text-blue-700",
  qualified: "bg-green-100 text-green-700",
  negotiating: "bg-purple-100 text-purple-700",
  won: "bg-emerald-100 text-emerald-700",
  lost: "bg-gray-100 text-gray-500",
  need_human: "bg-red-100 text-red-700",
};

// ===== 工具函数 =====
function formatRelative(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ===== 主组件 =====
export default function SalesPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [messages, setMessages] = useState<SalesMessage[]>([]);
  const [stats, setStats] = useState<SalesStats | null>(null);

  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("");

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const msgEndRef = useRef<HTMLDivElement | null>(null);

  // ===== 拉取列表 =====
  const fetchList = useCallback(async () => {
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      params.set("page", "1");
      params.set("pageSize", "50");
      if (stageFilter) params.set("stage", stageFilter);
      if (search.trim()) params.set("search", search.trim());
      const res = await api.get<LeadListResp>(`/sales/leads?${params.toString()}`);
      if (res.data) setLeads(res.data.items);
    } catch (err) {
      console.error("获取 lead 列表失败", err);
    } finally {
      setLoadingList(false);
    }
  }, [search, stageFilter]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get<SalesStats>("/sales/stats");
      if (res.data) setStats(res.data);
    } catch (err) {
      console.error("获取 stats 失败", err);
    }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await api.get<LeadDetailResp>(`/sales/leads/${id}`);
      if (res.data) {
        setSelectedLead(res.data.lead);
        setMessages(res.data.messages);
      }
    } catch (err) {
      console.error("获取 lead 详情失败", err);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // 初次加载 + 筛选变化
  useEffect(() => {
    fetchList();
  }, [fetchList]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // 选中某条
  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  // 消息到底
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 20s 轮询
  useEffect(() => {
    const t = setInterval(() => {
      fetchList();
      fetchStats();
      if (selectedId) fetchDetail(selectedId);
    }, 20000);
    return () => clearInterval(t);
  }, [fetchList, fetchStats, fetchDetail, selectedId]);

  // ===== 操作 =====
  const handleTakeover = async () => {
    if (!selectedId) return;
    try {
      await api.post(`/sales/leads/${selectedId}/takeover`, {});
      await fetchDetail(selectedId);
      await fetchList();
      await fetchStats();
    } catch (err) {
      console.error("接管失败", err);
    }
  };

  const handleRelease = async () => {
    if (!selectedId) return;
    try {
      await api.post(`/sales/leads/${selectedId}/release`, {});
      await fetchDetail(selectedId);
      await fetchList();
      await fetchStats();
    } catch (err) {
      console.error("交还失败", err);
    }
  };

  const handleSend = async () => {
    if (!selectedId || !input.trim() || sending) return;
    if (selectedLead?.handoverMode !== "human") return;
    setSending(true);
    try {
      await api.post<SalesMessage>(`/sales/leads/${selectedId}/messages`, {
        content: input.trim(),
      });
      setInput("");
      await fetchDetail(selectedId);
      await fetchList();
    } catch (err) {
      console.error("发送失败", err);
    } finally {
      setSending(false);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const filteredLeads = useMemo(() => leads, [leads]);
  const canSend = selectedLead?.handoverMode === "human";

  // ===== 渲染 =====
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* 顶部导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-blue-600">BossMate</span>
            <span className="text-xs text-gray-400">AI超级员工</span>
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-700">AI 销售对话</span>
        </div>
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-gray-500 hover:text-blue-600">
            返回首页
          </Link>
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">
            退出
          </button>
        </div>
      </nav>

      {/* 主体：左右分栏 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左栏 */}
        <aside className="w-[360px] shrink-0 border-r border-gray-200 bg-white flex flex-col">
          {/* 搜索 + 筛选 + 徽章 */}
          <div className="p-4 border-b border-gray-100 space-y-3">
            <div className="flex items-center gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索姓名 / 手机号 / 邮箱"
                className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                className="flex-1 px-2 py-1.5 text-sm rounded-lg border border-gray-200 bg-white"
              >
                <option value="">全部阶段</option>
                <option value="new">新线索</option>
                <option value="contacted">已联系</option>
                <option value="qualified">已合格</option>
                <option value="need_human">需关注</option>
              </select>
              {stats && stats.needHumanCount > 0 && (
                <span className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-700 font-medium whitespace-nowrap">
                  高优先级 {stats.needHumanCount}
                </span>
              )}
            </div>
            {stats && (
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span>共 {stats.totalLeads}</span>
                <span>· 未读 {stats.unreadLeads}</span>
                <span>· 接管 {stats.humanModeCount}</span>
              </div>
            )}
          </div>

          {/* 列表 */}
          <div className="flex-1 overflow-y-auto">
            {loadingList && leads.length === 0 ? (
              <div className="p-4 text-sm text-gray-400 text-center">加载中...</div>
            ) : filteredLeads.length === 0 ? (
              <div className="p-8 text-sm text-gray-400 text-center">暂无线索</div>
            ) : (
              filteredLeads.map((lead) => {
                const selected = lead.id === selectedId;
                const unread = lead.unreadCount ?? 0;
                return (
                  <button
                    key={lead.id}
                    onClick={() => setSelectedId(lead.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors ${
                      selected ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {lead.name || lead.contactId || "匿名客户"}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STAGE_COLORS[lead.stage]}`}
                          >
                            {STAGE_LABELS[lead.stage] ?? lead.stage}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span>意向 {lead.intentScore ?? 0}</span>
                          <span>·</span>
                          <span>{lead.channel}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          {lead.handoverMode === "human" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 font-medium">
                              接管中
                            </span>
                          )}
                          {lead.stage === "need_human" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-700 font-medium">
                              需关注
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-[11px] text-gray-400 whitespace-nowrap">
                          {formatRelative(lead.lastMessageAt ?? lead.createdAt)}
                        </span>
                        {unread > 0 && (
                          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                            {unread > 99 ? "99+" : unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* 右栏 */}
        <section className="flex-1 flex flex-col min-w-0">
          {!selectedLead ? (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
              请在左侧选择一条对话
            </div>
          ) : (
            <>
              {/* 客户信息栏 */}
              <header className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-semibold text-gray-900">
                      {selectedLead.name || selectedLead.contactId || "匿名客户"}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${STAGE_COLORS[selectedLead.stage]}`}
                    >
                      {STAGE_LABELS[selectedLead.stage] ?? selectedLead.stage}
                    </span>
                    {selectedLead.handoverMode === "human" && (
                      <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700 font-medium">
                        接管中
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    {selectedLead.phone && <span>📞 {selectedLead.phone}</span>}
                    <span>渠道：{selectedLead.channel}</span>
                    <span>意向分：{selectedLead.intentScore ?? 0}</span>
                  </div>
                </div>
                <div>
                  {selectedLead.handoverMode === "ai" ? (
                    <button
                      onClick={handleTakeover}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition"
                    >
                      接管对话
                    </button>
                  ) : (
                    <button
                      onClick={handleRelease}
                      className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition"
                    >
                      交还 AI
                    </button>
                  )}
                </div>
              </header>

              {/* 消息区 */}
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 bg-gray-50">
                {loadingDetail && messages.length === 0 ? (
                  <div className="text-center text-sm text-gray-400">加载中...</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-sm text-gray-400">暂无消息</div>
                ) : (
                  messages.map((m) => {
                    const isOut = m.direction === "outbound";
                    return (
                      <div
                        key={m.id}
                        className={`flex ${isOut ? "justify-end" : "justify-start"}`}
                      >
                        <div className="max-w-[70%]">
                          <div
                            className={`px-4 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                              isOut
                                ? "bg-emerald-500 text-white rounded-br-sm"
                                : "bg-white border border-gray-200 text-gray-800 rounded-bl-sm"
                            }`}
                          >
                            {m.content}
                          </div>
                          <div
                            className={`flex items-center gap-1.5 mt-1 text-[11px] text-gray-400 ${
                              isOut ? "justify-end" : "justify-start"
                            }`}
                          >
                            {isOut && m.isAiGenerated && (
                              <span className="px-1 py-0.5 rounded bg-gray-100 text-gray-500">
                                🤖 AI
                              </span>
                            )}
                            <span>{formatTime(m.sentAt ?? m.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={msgEndRef} />
              </div>

              {/* 输入区 */}
              <div className="px-6 py-3 border-t border-gray-200 bg-white">
                {!canSend && (
                  <div className="mb-2 text-xs text-gray-500 bg-gray-50 rounded px-3 py-2">
                    当前由 AI 接待，点击上方「接管对话」后可手动回复
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={onInputKeyDown}
                    disabled={!canSend || sending}
                    placeholder={canSend ? "输入回复，Enter 发送，Shift+Enter 换行" : "请先接管对话"}
                    rows={2}
                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-200 resize-none focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:text-gray-400"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!canSend || sending || !input.trim()}
                    className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
                  >
                    {sending ? "发送中..." : "发送"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
