/**
 * 5-23 PR #161 — 多选模式下右侧批量发布卡 (替单文章 DistributionCard).
 *
 * 仅含: 平台账号 checkbox (同 DistributionCard 模式) + 主按钮 "发布 N × M = K 次".
 * 点击后调 onSubmit(accountIds), parent 触发 POST /admin/bulk-distribute + 弹 progress panel.
 */
import type { WorkbenchAccount } from "./DistributionCard";

const PLATFORM_LABEL: Record<string, string> = {
  wechat: "公众号", wechat_video: "视频号", baijiahao: "百家号",
  toutiao: "头条号", zhihu: "知乎", xiaohongshu: "小红书", douyin: "抖音",
};

export interface BulkDistributeCardProps {
  selectedArticleIds: Set<string>;
  accounts: WorkbenchAccount[];
  selectedAccountIds: Set<string>;
  onToggleAccount: (id: string) => void;
  onSubmit: () => void;
  submitting: boolean;
}

export default function BulkDistributeCard({
  selectedArticleIds,
  accounts,
  selectedAccountIds,
  onToggleAccount,
  onSubmit,
  submitting,
}: BulkDistributeCardProps) {
  const articleCount = selectedArticleIds.size;
  const accountCount = selectedAccountIds.size;
  const totalJobs = articleCount * accountCount;
  const estimatedSec = Math.ceil(totalJobs * 3); // throttle 3s 默认

  // 按 platform 分组 (同 DistributionCard 模式)
  const grouped = accounts.reduce<Record<string, WorkbenchAccount[]>>((acc, a) => {
    (acc[a.platform] ||= []).push(a);
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-4 px-2 py-3 bg-green-50 border border-green-200 rounded-lg">
        <div className="text-sm font-medium text-green-800">📤 批量发布</div>
        <div className="text-xs text-green-700 mt-0.5">已选 {articleCount} 篇 × {accountCount} 账号 = {totalJobs} 次发布</div>
      </div>

      <div className="space-y-3">
        {Object.entries(grouped).map(([platform, list]) => (
          <div key={platform}>
            <div className="text-xs font-medium text-gray-500 mb-1.5">{PLATFORM_LABEL[platform] || platform}</div>
            <div className="space-y-1">
              {list.map((a) => (
                <label key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={selectedAccountIds.has(a.id)}
                    onChange={() => onToggleAccount(a.id)}
                    disabled={submitting}
                  />
                  <span className="flex-1 truncate text-gray-700">{a.accountName}</span>
                  {a.isVerified && <span className="text-xs text-green-600">✓</span>}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onSubmit}
        disabled={submitting || articleCount === 0 || accountCount === 0}
        className={`mt-4 w-full py-2.5 text-sm font-medium rounded-lg ${
          submitting || articleCount === 0 || accountCount === 0
            ? "bg-gray-200 text-gray-400 cursor-not-allowed"
            : "bg-green-600 text-white hover:bg-green-700 active:scale-95"
        }`}
      >
        {submitting ? "提交中..." : `发布 ${articleCount} × ${accountCount} = ${totalJobs} 次`}
      </button>
      {totalJobs > 0 && !submitting && (
        <p className="mt-1.5 text-[11px] text-gray-400 text-center">预计 {estimatedSec} 秒 (throttle 3s/次)</p>
      )}
      {totalJobs > 200 && (
        <p className="mt-1 text-[11px] text-red-500 text-center">⚠️ 超 200 上限, 减少 articles 或 accounts</p>
      )}
    </div>
  );
}
