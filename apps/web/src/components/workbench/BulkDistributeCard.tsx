/**
 * 5-23 PR #161 — 多选模式下右侧批量发布卡 (替单文章 DistributionCard).
 *
 * 仅含: 平台账号勾选 (6-11 施工包C1: 收口到统一 AccountSelector) + 主按钮 "发布 N × M = K 次".
 * 点击后调 onSubmit, parent 触发 POST /admin/bulk-distribute + 弹 progress panel.
 */
import type { WorkbenchAccount } from "./DistributionCard";
import AccountSelector from "../AccountSelector";

export interface BulkDistributeCardProps {
  selectedArticleIds: Set<string>;
  accounts: WorkbenchAccount[];
  selectedAccountIds: Set<string>;
  onChangeAccountIds: (ids: string[]) => void;
  onSubmit: () => void;
  submitting: boolean;
}

export default function BulkDistributeCard({
  selectedArticleIds,
  accounts,
  selectedAccountIds,
  onChangeAccountIds,
  onSubmit,
  submitting,
}: BulkDistributeCardProps) {
  const articleCount = selectedArticleIds.size;
  const accountCount = selectedAccountIds.size;
  const totalJobs = articleCount * accountCount;
  const estimatedSec = Math.ceil(totalJobs * 3); // throttle 3s 默认

  return (
    <div>
      <div className="mb-4 px-2 py-3 bg-green-50 border border-green-200 rounded-lg">
        <div className="text-sm font-medium text-green-800">📤 批量发布</div>
        <div className="text-xs text-green-700 mt-0.5">已选 {articleCount} 篇 × {accountCount} 账号 = {totalJobs} 次发布</div>
      </div>

      <AccountSelector
        accounts={accounts}
        value={[...selectedAccountIds]}
        onChange={onChangeAccountIds}
        showGroupSelectAll
        disabled={submitting}
      />

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
