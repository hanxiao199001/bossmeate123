/**
 * 5-18 P1 — Workbench 右列分发卡。
 * #2 多账号矩阵：账号级 checkbox，按 platform groupBy。
 * 复用 platform_accounts 现有字段 (accountName / groupName / isVerified / capability)，无 schema 改动。
 * 默认勾选 isVerified=true 账号 (运营默认想发到已验证号)。
 * + 数字人视频独立 dropdown + 按钮（复用 PR #140 route）。
 */
import { DVH_TEMPLATES } from "../RecommendationCard";

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
  onToggleAccount: (id: string) => void;
  onPublish: () => void;
  publishing: boolean;
  dvhTemplate: string;
  onTemplateChange: (id: string) => void;
  onGenerateDvh: () => void;
  generatingDvh: boolean;
  disabled?: boolean; // 无选中内容时禁用
}

const PLATFORM_LABEL: Record<string, string> = {
  wechat: "公众号", wechat_video: "视频号", baijiahao: "百家号",
  toutiao: "头条号", zhihu: "知乎", xiaohongshu: "小红书", douyin: "抖音",
};

export default function DistributionCard({
  accounts, selectedAccountIds, onToggleAccount, onPublish, publishing,
  dvhTemplate, onTemplateChange, onGenerateDvh, generatingDvh, disabled,
}: DistributionCardProps) {
  // 按 platform groupBy
  const grouped = accounts.reduce<Record<string, WorkbenchAccount[]>>((acc, a) => {
    (acc[a.platform] ??= []).push(a);
    return acc;
  }, {});
  const platforms = Object.keys(grouped).sort();
  const selectedCount = accounts.filter((a) => selectedAccountIds.has(a.id)).length;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3">选择发布账号</h3>
        {accounts.length === 0 ? (
          <p className="text-xs text-gray-400">无可用账号 (去 <a href="/accounts" className="text-blue-600 underline">账号管理</a> 添加)</p>
        ) : (
          <div className="space-y-3">
            {platforms.map((p) => (
              <div key={p}>
                <p className="text-xs font-medium text-gray-500 mb-1.5">{PLATFORM_LABEL[p] || p}</p>
                <div className="space-y-1.5">
                  {grouped[p].map((a) => (
                    <label key={a.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedAccountIds.has(a.id)}
                        onChange={() => onToggleAccount(a.id)}
                        className="w-4 h-4 rounded border-gray-300"
                      />
                      <span className="text-sm text-gray-800 flex-1 truncate">{a.accountName}</span>
                      {a.isVerified ? (
                        <span className="text-xs text-green-600">✓</span>
                      ) : (
                        <span className="text-xs text-gray-400" title="未验证">未验</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
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
        <p className="text-xs font-medium text-gray-500 mb-2">数字人视频主播</p>
        <div className="flex gap-2">
          <select
            value={dvhTemplate}
            onChange={(e) => onTemplateChange(e.target.value)}
            className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded bg-white"
            disabled={disabled || generatingDvh}
            aria-label="数字人模板"
          >
            {DVH_TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={onGenerateDvh}
          disabled={disabled || generatingDvh}
          className="w-full mt-2 px-4 py-2 rounded-lg bg-pink-600 text-white text-sm font-medium hover:bg-pink-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
        >
          {generatingDvh ? "🎬 生成中…" : "🎬 生成数字人视频"}
        </button>
      </div>
    </div>
  );
}
