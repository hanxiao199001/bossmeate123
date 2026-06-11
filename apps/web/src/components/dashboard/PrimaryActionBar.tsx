/**
 * 5-21 P0 — 主 CTA 条。
 * 双模:
 *  normal: 2 主 CTA (内容工坊 / 销售雷达); 视频快捷按钮 6-11 已撤(入口收敛工坊)
 *  empty:  "今天还没开始, 一键启动" 单大按钮
 */
import { Link } from "react-router-dom";
import { SALES_RADAR_ENABLED } from "../../utils/featureFlags";
import { IconPenSquare, IconRadar, IconSparkles } from "../ui/Icons";

export interface PrimaryActionBarProps {
  mode: "normal" | "empty";
}

export default function PrimaryActionBar({ mode }: PrimaryActionBarProps) {
  if (mode === "empty") {
    return (
      <section className="mb-6 bg-white rounded-2xl border border-indigo-200 ring-1 ring-indigo-200/60 shadow-[0_1px_2px_rgba(16,24,40,0.04)] p-5 flex items-center gap-4">
        <span className="w-11 h-11 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
          <IconSparkles size={20} />
        </span>
        <div className="flex-1">
          <div className="text-base font-semibold text-slate-900">今天还没开始</div>
          <div className="text-xs text-slate-500 mt-0.5">点一下，BossMate 帮你抓选题、写图文、找客户</div>
        </div>
        <Link
          to="/workbench"
          className="px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg shadow-sm hover:bg-indigo-500 active:scale-95 transition-all"
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
        className="flex-1 px-5 py-3 bg-indigo-600 text-white text-sm font-medium rounded-xl shadow-sm hover:bg-indigo-500 active:scale-95 transition-all flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <IconPenSquare size={16} />
          <span>打开内容工坊</span>
        </span>
        <span className="text-xs opacity-80">采用推荐 · 一键发布</span>
      </Link>
      {SALES_RADAR_ENABLED && <Link
        to="/sales-radar"
        className="flex-1 px-5 py-3 bg-rose-600 text-white text-sm font-medium rounded-xl shadow-sm hover:bg-rose-500 active:scale-95 transition-all flex items-center justify-between"
      >
        <span className="flex items-center gap-2">
          <IconRadar size={16} />
          <span>跟进销售线索</span>
        </span>
        <span className="text-xs opacity-80">热线索优先</span>
      </Link>}
      {/* 6-11 老韩拍板撤掉首页视频快捷按钮 — 图转视频入口收敛到工坊「生成视频」弹窗的图转视频选项卡 */}
    </section>
  );
}
