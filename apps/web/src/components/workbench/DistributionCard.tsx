/**
 * 5-18 P1 — Workbench 右列分发卡。
 * #2 多账号矩阵：账号级 checkbox，按 platform groupBy。
 * 复用 platform_accounts 现有字段 (accountName / groupName / isVerified / capability)，无 schema 改动。
 * 默认勾选 isVerified=true 账号 (运营默认想发到已验证号) — 由父组件 ContentWorkbenchPage 拉数时处理。
 *
 * 6-11 施工包C1 (审计 2.1/1.2):
 *  - 账号勾选区收口到统一 <AccountSelector> (平台全选 + 已验证标记);
 *  - 数字人视频 inline 模板下拉下线, "🎬 生成数字人视频"按钮改为弹统一 UnifiedVideoModal (onOpenVideoModal)。
 */
import AccountSelector from "../AccountSelector";

export interface WorkbenchAccount {
  id: string;
  platform: string;
  accountName: string;
  isVerified: boolean | null;
  capability?: string | null;
  groupName?: string | null;
}

export interface DistributionCardProps {
  accounts: WorkbenchAccount[];
  selectedAccountIds: Set<string>;
  onChangeAccountIds: (ids: string[]) => void;
  onPublish: () => void;
  publishing: boolean;
  /** C1-b: 弹统一生成视频 modal (锁定当前选中文章) */
  onOpenVideoModal: () => void;
  disabled?: boolean; // 无选中内容时禁用
}

export default function DistributionCard({
  accounts, selectedAccountIds, onChangeAccountIds, onPublish, publishing,
  onOpenVideoModal, disabled,
}: DistributionCardProps) {
  const selectedCount = accounts.filter((a) => selectedAccountIds.has(a.id)).length;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">选择发布账号</h3>
        <AccountSelector
          accounts={accounts}
          value={[...selectedAccountIds]}
          onChange={onChangeAccountIds}
          showGroupSelectAll
        />
      </div>

      <button
        onClick={onPublish}
        disabled={disabled || publishing || selectedCount === 0}
        className="w-full px-4 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      >
        {publishing ? "📤 发布中…" : `📤 发布到 ${selectedCount} 个账号`}
      </button>

      <div className="border-t border-gray-100 pt-4">
        <div className="text-xs text-gray-500 mb-2 text-center">— 或 —</div>
        <button
          onClick={onOpenVideoModal}
          disabled={disabled}
          className="w-full px-4 py-2 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          🎬 生成数字人视频
        </button>
      </div>
    </div>
  );
}
