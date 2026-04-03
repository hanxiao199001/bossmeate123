import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../utils/api";

const quickTags = [
  { label: "\u{1F4DD} 写一篇图文", text: "帮我写一篇图文" },
  { label: "\u{1F3AC} 做一个视频脚本", text: "帮我写一个视频脚本" },
  { label: "\u{1F50D} 分析行业关键词", text: "帮我分析一下行业热门关键词" },
  { label: "\u{1F4CA} 查看数据报告", text: "__NAV__/data-dashboard" },
];

function inferSkillType(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/写|创作|生成/.test(lower) && /文章|图文|内容/.test(lower)) return "article";
  if (/视频|脚本/.test(lower)) return "video";
  return undefined;
}

const hasSpeechAPI =
  typeof window !== "undefined" &&
  !!(window.SpeechRecognition || window.webkitSpeechRecognition);

export default function SmartInput() {
  const [input, setInput] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const navigate = useNavigate();
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  function toggleVoice() {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setInput(transcript);
    };

    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognition.onerror = () => {
      setIsRecording(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setIsRecording(true);
    recognition.start();
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      const skillType = inferSkillType(text);
      const res = await api.post<{ id: string }>("/chat/conversations", {
        title: text.slice(0, 30),
        skillType,
      });

      if (res.data) {
        const convId = res.data.id;
        navigate(`/chat/${convId}?autoMessage=${encodeURIComponent(text)}`);
      }
    } catch (err) {
      console.error("创建对话失败:", err);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTagClick(tag: (typeof quickTags)[number]) {
    if (tag.text.startsWith("__NAV__")) {
      navigate(tag.text.replace("__NAV__", ""));
      return;
    }
    setInput(tag.text);
    textareaRef.current?.focus();
  }

  return (
    <div className="max-w-2xl mx-auto my-8 px-4">
      <p className="text-center text-gray-500 text-sm mb-3">
        一句话，开始工作
      </p>

      <div className="relative flex items-center bg-white border border-gray-200 rounded-2xl shadow-sm hover:shadow-md transition-shadow px-4 py-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isRecording
              ? "正在听..."
              : "告诉我你想做什么... 例如：写一篇关于新型降糖药的科普文章，发到微信公众号"
          }
          className="flex-1 resize-none outline-none text-gray-800 placeholder-gray-400 bg-transparent text-sm leading-relaxed"
          rows={2}
        />

        {hasSpeechAPI && (
          <button
            onClick={toggleVoice}
            className={`ml-2 w-9 h-9 flex items-center justify-center rounded-full transition shrink-0 ${
              isRecording
                ? "bg-red-100 text-red-500 animate-pulse"
                : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            }`}
            title={isRecording ? "停止录音" : "语音输入"}
          >
            {"\u{1F399}\u{FE0F}"}
          </button>
        )}

        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="ml-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-xl disabled:opacity-40 hover:bg-blue-700 transition shrink-0"
        >
          {sending ? "..." : "发送"}
        </button>
      </div>

      <div className="flex flex-wrap justify-center gap-2 mt-3">
        {quickTags.map((tag) => (
          <button
            key={tag.label}
            onClick={() => handleTagClick(tag)}
            className="px-3 py-1.5 text-xs bg-gray-50 text-gray-600 rounded-full border border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition"
          >
            {tag.label}
          </button>
        ))}
      </div>
    </div>
  );
}
