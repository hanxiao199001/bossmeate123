/**
 * 5-21 P3 — 全局 chat 抽屉 (slide-in 600px from right)。
 * ESC / overlay click / 关闭按钮 都可关。zIndex 高 (z-50) 浮在所有页面上，但 < RiskAuditModal 的 z-50 同级。
 */
import { useEffect } from "react";
import ChatPanel from "./ChatPanel";

export interface ChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function ChatDrawer({ open, onClose }: ChatDrawerProps) {
  // ESC 关
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      {/* overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* drawer */}
      <aside className="fixed top-0 right-0 z-50 h-screen w-full sm:w-[600px] bg-white shadow-2xl flex flex-col" role="dialog" aria-modal="true" aria-label="AI 助手">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0 bg-gradient-to-r from-blue-50 to-indigo-50">
          <h2 className="text-base font-bold text-gray-900">💬 BossMate 助手</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none" aria-label="关闭">×</button>
        </div>
        <div className="flex-1 overflow-hidden">
          <ChatPanel />
        </div>
      </aside>
    </>
  );
}
