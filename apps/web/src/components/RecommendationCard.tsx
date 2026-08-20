/**
 * PR #134 V2.5 PHASE 4 Day 2 (5-13) — 推荐 article 卡片.
 *
 * Decision 3 锁: 封面用 journals.coverImageUrl + emoji fallback (5-11 user 拍板).
 * 主操作: [📤 发布] [👀 详情] [⏭ 跳过] + [🎬 生成数字人视频] (5-15 PR #141 wire).
 */
import { useState } from "react";
import { dataSourceLabel } from "../utils/i18n";
import { htmlToPlainText } from "../utils/html-text";

// 5-15 PR #141: 4 套数字人模板（对应 PR #137 template-mapping 的 4 主播）
export const DVH_TEMPLATES = [
  { value: "A_academic", label: "A 学术" },
  { value: "B_marketing", label: "B 营销" },
  { value: "C_popular", label: "C 科普" },
  { value: "E_industry", label: "E 行业" },
] as const;

export interface RecommendationItem {
  id: string;
  title: string | null;
  body: string | null;
  status: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  journal: {
    id: string;
    name: string | null;
    nameEn: string | null;
    impactFactor: number | null;
    partition: string | null;
    confidence: number | null;
    coverImageUrl: string | null;
  } | null;
}

interface Props {
  item: RecommendationItem;
  onView: () => void;
  onPublish: () => void;
  onSkip: () => void;
  onGenerateDvh: (templateId: string) => void;
}

const EMOJI_BY_PARTITION: Record<string, string> = { Q1: "🥇", Q2: "🥈", Q3: "🥉", Q4: "🎓" };

function summarize(body: string | null, maxLen = 100): string {
  if (!body) return "AI 已生成完整 article，点击查看详情。";
  // 8-20: 同 ContentPreviewPane，原来不解实体，卡片摘要会显示 &amp; 等字面量。
  const plain = htmlToPlainText(body);
  return plain.length > maxLen ? plain.slice(0, maxLen) + "…" : plain;
}

export default function RecommendationCard({ item, onView, onPublish, onSkip, onGenerateDvh }: Props) {
  const [dvhTemplate, setDvhTemplate] = useState<string>(DVH_TEMPLATES[0].value);
  const j = item.journal;
  const cover = j?.coverImageUrl && /^https?:\/\//i.test(j.coverImageUrl) ? j.coverImageUrl : null;
  const fallback = j?.partition && EMOJI_BY_PARTITION[j.partition] ? EMOJI_BY_PARTITION[j.partition] : "📰";
  const conf = j?.confidence ?? null;
  const dsBadge = (item.metadata as any)?.dataSource && dataSourceLabel[(item.metadata as any).dataSource]
    ? dataSourceLabel[(item.metadata as any).dataSource]
    : null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow flex flex-col">
      {/* 封面 */}
      <div className="h-32 bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center overflow-hidden shrink-0">
        {cover ? (
          <img src={cover} alt={j?.name ?? ""} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <span className="text-5xl">{fallback}</span>
        )}
      </div>

      <div className="p-4 flex flex-col flex-1">
        {/* 标题 */}
        <h3 className="text-base font-semibold text-gray-900 line-clamp-2 mb-2" title={item.title ?? ""}>
          {item.title || "(无标题)"}
        </h3>

        {/* 期刊 + 可信度 */}
        {j && (
          <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
            {j.name && <span className="text-gray-700 font-medium">{j.name}</span>}
            {j.impactFactor !== null && <span className="text-gray-500">IF {j.impactFactor}</span>}
            {j.partition && <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">{j.partition}</span>}
            {conf !== null && (
              <span className={`px-1.5 py-0.5 rounded ${conf >= 80 ? "bg-green-50 text-green-700" : conf >= 50 ? "bg-yellow-50 text-yellow-700" : "bg-red-50 text-red-700"}`}>
                可信度 {conf}
              </span>
            )}
            {dsBadge && <span className="text-gray-400">{dsBadge}</span>}
          </div>
        )}

        {/* 摘要 */}
        <p className="text-sm text-gray-600 line-clamp-3 mb-3 flex-1">{summarize(item.body)}</p>

        {/* 操作 */}
        <div className="flex gap-2 mt-auto">
          <button onClick={onPublish} className="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700">📤 发布</button>
          <button onClick={onView} className="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100">👀 详情</button>
          <button onClick={onSkip} className="px-2 py-1.5 text-xs font-medium rounded bg-gray-50 text-gray-500 border border-gray-200 hover:bg-gray-100">⏭ 跳过</button>
        </div>
        {/* 5-15 PR #141: 数字人视频 — inline select 选 4 套主播模板 */}
        <div className="flex gap-2 mt-2">
          <select
            value={dvhTemplate}
            onChange={(e) => setDvhTemplate(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded bg-white text-gray-700"
            aria-label="数字人模板"
          >
            {DVH_TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <button
            onClick={() => onGenerateDvh(dvhTemplate)}
            className="flex-1 px-2 py-1.5 text-xs font-medium rounded bg-pink-600 text-white hover:bg-pink-700"
          >
            🎬 生成数字人视频
          </button>
        </div>
      </div>
    </div>
  );
}
