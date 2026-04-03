import { useState, useEffect, useRef, useCallback } from "react";
import { Link, useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../utils/api";

/**
 * 对话页面 - 对接真实后端 AI API
 */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  tokensUsed?: number;
  createdAt: string;
}

interface Conversation {
  id: string;
  title: string;
  skillType: string | null;
  updatedAt: string;
}

export default function ChatPage() {
  const { conversationId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(conversationId || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const skillType = searchParams.get("skill") || "general";

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // 加载对话列表
  useEffect(() => {
    async function loadConversations() {
      try {
        const res = await api.get<Conversation[]>("/chat/conversations");
        if (res.data) setConversations(res.data);
      } catch {
        // 静默失败
      }
    }
    loadConversations();
  }, [currentConvId]);

  // 加载消息历史
  useEffect(() => {
    if (!currentConvId) return;
    async function loadMessages() {
      try {
        const res = await api.get<Message[]>(`/chat/conversations/${currentConvId}/messages`);
        if (res.data) {
          setMessages(res.data);
          setTimeout(scrollToBottom, 100);

          // 如果只有 user 消息没有 assistant 回复（推荐创建后刷新），自动触发发送
          const loadedMessages = res.data;
          if (
            loadedMessages &&
            loadedMessages.length === 1 &&
            loadedMessages[0].role === "user" &&
            !autoMessageHandled.current &&
            !searchParams.get("autoMessage")
          ) {
            autoMessageHandled.current = true;
            setTimeout(() => {
              sendMessage(loadedMessages[0].content, currentConvId!);
            }, 300);
          }
        }
      } catch {
        // 对话可能不存在
      }
    }
    loadMessages();
  }, [currentConvId, scrollToBottom]);

  // V3: autoMessage — SmartInput 跳转后自动发送
  const autoMessageHandled = useRef(false);
  useEffect(() => {
    const autoMsg = searchParams.get("autoMessage");
    if (!autoMsg || autoMessageHandled.current || !currentConvId) return;
    autoMessageHandled.current = true;

    // 清掉 URL 参数，避免刷新重复发送
    navigate(`/chat/${currentConvId}`, { replace: true });

    // 延迟一帧，确保对话已加载
    setTimeout(() => {
      setInput(autoMsg);
      // 自动触发发送
      sendMessage(autoMsg, currentConvId);
    }, 200);
  }, [currentConvId, searchParams]);

  // 创建新对话
  async function createConversation(): Promise<string | null> {
    try {
      const res = await api.post<Conversation>("/chat/conversations", {
        title: "新对话",
        skillType,
      });
      if (res.data) {
        setCurrentConvId(res.data.id);
        navigate(`/chat/${res.data.id}`, { replace: true });
        return res.data.id;
      }
    } catch (err: any) {
      console.error("创建对话失败:", err);
    }
    return null;
  }

  // 发送消息核心逻辑（handleSend 和 autoMessage 共用）
  async function sendMessage(userContent: string, convId: string) {
    setLoading(true);

    const tempUserMsg: Message = {
      id: "temp-user-" + Date.now(),
      role: "user",
      content: userContent,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setTimeout(scrollToBottom, 50);

    try {
      const res = await api.post<{
        userMessage: Message;
        aiMessage: Message;
      }>(`/chat/conversations/${convId}/send`, { content: userContent });

      if (res.data) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== tempUserMsg.id),
          res.data!.userMessage,
          res.data!.aiMessage,
        ]);
        setTimeout(scrollToBottom, 100);
      }
    } catch (err: any) {
      const errorMsg: Message = {
        id: "error-" + Date.now(),
        role: "assistant",
        content: `发送失败: ${err.message || "网络错误"}`,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  // 发送按钮/Enter 触发
  async function handleSend() {
    if (!input.trim() || loading) return;

    const userContent = input.trim();
    setInput("");

    let convId = currentConvId;
    if (!convId) {
      convId = await createConversation();
      if (!convId) return;
    }

    await sendMessage(userContent, convId);
  }

  // 切换对话
  function switchConversation(convId: string) {
    setCurrentConvId(convId);
    setMessages([]);
    navigate(`/chat/${convId}`, { replace: true });
  }

  // 新建对话
  function handleNewChat() {
    setCurrentConvId(null);
    setMessages([]);
    navigate(`/chat?skill=${skillType}`, { replace: true });
  }

  // 简单的 Markdown 渲染（带 XSS 清洗）
  function renderContent(content: string) {
    // 先清洗 HTML 标签，防止 XSS
    let safe = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    // 处理标题
    let html = safe
      .replace(/^### (.+)$/gm, '<h3 class="text-base font-bold mt-3 mb-1">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold mt-4 mb-2">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold mt-4 mb-2">$1</h1>');

    // 处理粗体
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // 处理分隔线
    html = html.replace(/^---$/gm, '<hr class="my-3 border-gray-200" />');

    // 处理换行
    html = html.replace(/\n/g, "<br />");

    return html;
  }

  // 格式化时间
  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="h-screen flex bg-gray-50">
      {/* 侧边栏 - 对话列表 */}
      {sidebarOpen && (
        <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-3 border-b border-gray-100">
            <button
              onClick={handleNewChat}
              className="w-full py-2 px-3 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              + 新对话
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => switchConversation(conv.id)}
                className={`w-full text-left px-3 py-2.5 text-sm border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                  conv.id === currentConvId ? "bg-blue-50 text-blue-700" : "text-gray-700"
                }`}
              >
                <div className="font-medium truncate">{conv.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {conv.skillType === "article" ? "图文" : "助手"} · {formatTime(conv.updatedAt)}
                </div>
              </button>
            ))}
            {conversations.length === 0 && (
              <div className="text-center text-gray-400 text-sm mt-8">暂无对话</div>
            )}
          </div>
        </div>
      )}

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col">
        {/* 顶部导航 */}
        <nav className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-gray-500 hover:text-gray-700 text-lg"
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
          <Link to="/" className="text-blue-600 hover:text-blue-700 text-sm">
            返回首页
          </Link>
          <span className="text-gray-300">|</span>
          <span className="font-medium text-gray-900 text-sm">
            AI 助手
          </span>
          {loading && (
            <span className="ml-auto text-xs text-orange-500 animate-pulse">
              AI正在生成中...
            </span>
          )}
        </nav>

        {/* 消息区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="max-w-3xl mx-auto space-y-4">
            {messages.length === 0 && !loading && (
              <div className="text-center text-gray-400 mt-20">
                <p className="text-5xl mb-4">&#x1F916;</p>
                <p className="text-lg font-medium text-gray-600">AI 助手</p>
                <p className="text-sm mt-2">问答、翻译、总结、头脑风暴，有什么可以帮你的？</p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <QuickPrompt
                    text="帮我总结一下这个概念"
                    onClick={(t) => { setInput(t); inputRef.current?.focus(); }}
                  />
                  <QuickPrompt
                    text="翻译成英文"
                    onClick={(t) => { setInput(t); inputRef.current?.focus(); }}
                  />
                  <QuickPrompt
                    text="帮我想几个选题方向"
                    onClick={(t) => { setInput(t); inputRef.current?.focus(); }}
                  />
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-white border border-gray-200 text-gray-800 shadow-sm"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <div
                      className="text-sm leading-relaxed prose-sm"
                      dangerouslySetInnerHTML={{ __html: renderContent(msg.content) }}
                    />
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  )}
                  <div
                    className={`text-xs mt-2 ${
                      msg.role === "user" ? "text-blue-200" : "text-gray-400"
                    }`}
                  >
                    {formatTime(msg.createdAt)}
                    {msg.model && msg.model !== "none" && (
                      <span className="ml-2">via {msg.model}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                    <span className="text-sm text-gray-400">AI正在思考并生成内容...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* 输入区域 */}
        <div className="bg-white border-t border-gray-200 p-3">
          <div className="max-w-3xl mx-auto flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none resize-none text-sm"
              placeholder={
                skillType === "article"
                  ? "描述你想写的文章，如：写一篇AI在期刊出版中的应用，面向编辑，800字..."
                  : "输入你的问题..."
              }
              rows={2}
              disabled={loading}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="px-5 py-2.5 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors self-end text-sm"
            >
              {loading ? "生成中" : "发送"}
            </button>
          </div>
          <div className="max-w-3xl mx-auto mt-1.5 text-xs text-gray-400 text-center">
            Enter 发送 · Shift+Enter 换行 · AI生成内容仅供参考
          </div>
        </div>
      </div>
    </div>
  );
}

// 快捷提示按钮
function QuickPrompt({ text, onClick }: { text: string; onClick: (text: string) => void }) {
  return (
    <button
      onClick={() => onClick(text)}
      className="px-3 py-1.5 bg-white border border-gray-200 rounded-full text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
    >
      {text}
    </button>
  );
}
