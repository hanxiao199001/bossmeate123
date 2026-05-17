/**
 * 5-17 P0 hero — DashboardPage 顶部 "系统活着 + 产能 + ROI" 区块。
 * 5-22 老板 demo 第 1 act：一进来 3 大数字直击 ROI。
 */
import { Link } from "react-router-dom";

export interface HeroSectionProps {
  systemArticlesToday: number;
  monthlySavings: number; // ¥ — 已由父组件用 cost-comparison util 算好
  roiMultiple: number;
  userName: string | undefined;
}

const yuan = (n: number) => `¥${Math.round(n).toLocaleString("zh-CN")}`;

function todayLabel(): string {
  const now = new Date();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  return `周${weekday} ${now.getMonth() + 1}月${now.getDate()}日`;
}

export default function HeroSection({ systemArticlesToday, monthlySavings, roiMultiple, userName }: HeroSectionProps) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6 mb-5">
      <div className="text-sm text-gray-500 mb-3">你好，{userName || "韩宵"} · {todayLabel()}</div>

      <div className="space-y-2.5 mb-5">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-sm text-gray-600">今日 BossMate 自动产出</span>
          <span className="text-3xl font-bold text-blue-600">{systemArticlesToday}<span className="text-base font-normal text-gray-500"> 篇图文</span></span>
          <span className="text-xs text-gray-400">（推荐池）</span>
        </div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-sm text-gray-600">本月帮你节省</span>
          <span className="text-3xl font-bold text-emerald-600">{yuan(monthlySavings)}</span>
          <span className="text-gray-300">·</span>
          <span className="text-sm text-gray-600">ROI</span>
          <span className="text-3xl font-bold text-emerald-600">{roiMultiple.toFixed(1)}<span className="text-base font-normal">x</span></span>
          <Link to="/cost-comparison" className="text-sm text-blue-600 hover:underline ml-1">查看 →</Link>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link to="/workbench" className="px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
          ✨ 一键生成图文
        </Link>
        <Link to="/video/create" className="px-5 py-2.5 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700">
          🎬 一键生成视频
        </Link>
      </div>
    </section>
  );
}
