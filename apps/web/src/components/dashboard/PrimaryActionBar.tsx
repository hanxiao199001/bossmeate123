/**
 * 5-21 P0 — 主 CTA 条。
 * 双模:
 *  normal: 2 主 CTA (内容工坊 / 销售雷达) + 1 次 CTA (视频)
 *  empty:  "今天还没开始, 一键启动" 单大按钮
 */
import { Link } from "react-router-dom";

export interface PrimaryActionBarProps {
  mode: "normal" | "empty";
}

export default function PrimaryActionBar({ mode }: PrimaryActionBarProps) {
  if (mode === "empty") {
    return (
      <section className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 flex items-center gap-4">
        <span className="text-3xl">🚀</span>
        <div className="flex-1">
          <div className="text-base font-bold text-gray-900">今天还没开始</div>
          <div className="text-xs text-gray-500 mt-0.5">点一下，BossMate 帮你抓选题、写图文、找客户</div>
        </div>
        <Link
          to="/workbench"
          className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
        >
          一键启动今日产出 →
        </Link>
      </section>
    );
  }

  return (
    <section className="mb-6 flex items-center gap-3">
      <Link
        to="/workbench"
        className="flex-1 px-5 py-3 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <span className="text-base">📝</span>
          <span>打开内容工坊</span>
        </span>
        <span className="text-xs opacity-80">采用推荐 · 一键发布</span>
      </Link>
      <Link
        to="/sales-radar"
        className="flex-1 px-5 py-3 bg-rose-600 text-white text-sm font-medium rounded-xl hover:bg-rose-700 active:scale-95 transition-all flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <span className="text-base">📡</span>
          <span>跟进销售线索</span>
        </span>
        <span className="text-xs opacity-80">热线索优先</span>
      </Link>
      <Link
        to="/video/create"
        className="px-4 py-3 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-purple-300 hover:text-purple-600 transition-all"
        title="一键生成视频"
      >
        🎬 视频
      </Link>
    </section>
  );
}
