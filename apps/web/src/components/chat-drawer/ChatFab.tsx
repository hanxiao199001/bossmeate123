/**
 * 5-21 P3 — 右下角浮动 FAB, click → 打开 ChatDrawer。
 */
export interface ChatFabProps {
  onClick: () => void;
}

export default function ChatFab({ onClick }: ChatFabProps) {
  return (
    <button
      onClick={onClick}
      aria-label="打开 AI 助手"
      className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-blue-600 text-white text-2xl shadow-lg hover:bg-blue-700 hover:shadow-xl transition-all flex items-center justify-center"
    >
      💬
    </button>
  );
}
