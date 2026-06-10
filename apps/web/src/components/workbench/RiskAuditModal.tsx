/**
 * 5-20 P2 — 风控审核 modal。
 * 触发: DistributionCard 发布按钮 → 先调 POST /content/:id/audit → 命中即弹本 modal。
 * 3 选 1:
 *  - [✏️ 改文案]   → navigate /content/:id，让用户编辑
 *  - [⏭ 跳过有风险的账号] → 把 hit 涉及的 platform deselect 后直接 publish 剩余账号
 *  - [⚠️ 强制放行]  → 二次确认 + 填理由 → POST /publish { forceOverride:true, overrideReason }
 */
import { useState } from "react";
import { platformShortLabel } from "../../utils/i18n";

export interface AuditHit {
  platform: string;
  word: string;
  positions: number[];
  severity: "high" | "medium" | "low";
}

export interface AuditResult {
  hits: AuditHit[];
  summary: { totalHits: number; byPlatform: Record<string, number> };
}

export interface RiskAuditModalProps {
  open: boolean;
  audit: AuditResult | null;
  contentId: string | null;
  onClose: () => void;
  onEdit: () => void;             // [改文案] navigate detail page
  onSkipRiskyPlatforms: () => void; // [跳过] deselect 命中 platform + publish 干净的
  onForceOverride: (reason: string) => void; // [强制放行] 已二次确认
}

function hitNoteFor(platform: string, word: string): string {
  if ((platform === "douyin" || platform === "wechat_video") && (word === "微信" || word === "WeChat" || word === "公众号")) {
    return "跨平台导流，平台禁止";
  }
  if (word === "免费" || word === "免费领" || word === "免费送" || word === "抢购" || word === "限时秒杀") {
    return "营销诱导，公众号高度敏感";
  }
  if (word === "100%" || word === "100％" || word === "最便宜" || word === "最低价" || word === "永久免费") {
    return "广告法绝对化用语";
  }
  if (word === "刷单" || word === "代付" || word === "网赚") {
    return "金融红线";
  }
  return "平台规则风险词";
}

export default function RiskAuditModal({ open, audit, contentId, onClose, onEdit, onSkipRiskyPlatforms, onForceOverride }: RiskAuditModalProps) {
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  if (!open || !audit) return null;

  // 按 platform groupBy
  const byPlatform = audit.hits.reduce<Record<string, AuditHit[]>>((acc, h) => {
    (acc[h.platform] ??= []).push(h);
    return acc;
  }, {});
  const platforms = Object.keys(byPlatform).sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col">
        {/* 头 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">
            ⚠️ 风控审核 — 检测到 {audit.summary.totalHits} 个潜在风险
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* 风险列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {platforms.map((p) => (
            <div key={p}>
              <p className="text-sm font-semibold text-gray-700 mb-2">
                {platformShortLabel(p)}: <span className="text-red-600">{byPlatform[p].length} 处</span>
              </p>
              <div className="space-y-1.5">
                {byPlatform[p].map((h) => (
                  <div key={`${p}-${h.word}`} className="flex items-start gap-2 text-sm bg-red-50 px-3 py-2 rounded">
                    <span className="font-mono font-medium text-red-700">"{h.word}"</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-600">出现 {h.positions.length} 次</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-700">{hitNoteFor(p, h.word)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {contentId && (
            <p className="text-xs text-gray-400 pt-2">contentId: {contentId}</p>
          )}
        </div>

        {/* 强制放行表单（二次确认） */}
        {showOverrideForm ? (
          <div className="px-5 py-4 border-t border-gray-200 bg-amber-50">
            <p className="text-sm text-amber-900 font-medium mb-2">
              ⚠️ 强制放行可能导致账号被警告或封号。请填写放行理由（≥10 字）：
            </p>
            <textarea
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 text-sm border border-amber-300 rounded mb-2 resize-none"
              placeholder="例: 学术文章中『免费投稿』为正常表述，非营销诱导"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowOverrideForm(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">取消</button>
              <button
                onClick={() => onForceOverride(overrideReason.trim())}
                disabled={overrideReason.trim().length < 10}
                className="px-4 py-1.5 text-sm font-medium bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-300"
              >
                ⚠️ 确认强制放行
              </button>
            </div>
          </div>
        ) : (
          /* 3 选 1 */
          <div className="px-5 py-3 border-t border-gray-200 flex gap-2 justify-end">
            <button onClick={onEdit} className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              ✏️ 改文案
            </button>
            <button onClick={onSkipRiskyPlatforms} className="px-4 py-2 text-sm font-medium bg-gray-600 text-white rounded-lg hover:bg-gray-700">
              ⏭ 跳过有风险的账号
            </button>
            <button onClick={() => setShowOverrideForm(true)} className="px-4 py-2 text-sm font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600">
              ⚠️ 强制放行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
