/**
 * 5-17 P0 hero — DashboardPage 顶部 "系统活着" 区块。
 * 5-21 hotfix: 移除 ROI/月省 视觉污染，搬到独立 /cost-comparison 页面 (那里完整 demo ROI 故事)。
 * 现剩: 问候 + 今日产出 + 双 CTA, 视觉干净。
 */
import { Link } from "react-router-dom";

export interface HeroSectionProps {
  systemArticlesToday: number;
  userName: string | undefined;
}

function todayLabel(): string {
  const now = new Date();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  return `周${weekday} ${now.getMonth() + 1}月${now.getDate()}日`;
}

export default function HeroSection({ systemArticlesToday, userName }: HeroSectionProps) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-6 mb-5">
      <div className="text-sm text-gray-500 mb-3">你好，{userName || "韩宵"} · {todayLabel()}</div>

      <div className="mb-5">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-sm text-gray-600">今日 BossMate 自动产出</span>
          <span className="text-3xl font-bold text-blue-600">{systemArticlesToday}<span className="text-base font-normal text-gray-500"> 篇图文</span></span>
          <span className="text-xs text-gray-400">（推荐池）</span>
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
