/**
 * 6-11 施工包C1-a (审计 2.1) — 统一账号选择组件。
 *
 * 原先"按平台分组列账号 + 勾选 + 已验证标记"在 5 处各写一份
 * (DistributionCard / BulkDistributeCard / ManualGenerateModal / ContentDetailPage 发布面板 / WorkflowPage 第8步),
 * 视觉以 DistributionCard 为基准全部收口到这里。
 *
 * 设计约束:
 *  - 组件内不发请求, accounts 由调用方传入 (各处取数逻辑不动);
 *  - 受控组件: value (选中 id 数组) + onChange;
 *  - defaultVerifiedChecked: 账号到位且当前无选中时, 一次性默认勾选 isVerified 账号 (不覆盖用户操作);
 *  - showGroupSelectAll: 平台级全选 checkbox (原 ContentDetailPage "全选本平台" 能力);
 *  - mode="single": 单选 (RoundupGenerateModal 类场景预留);
 *  - PR-S6 兼容: 抖音/视频号账号带 loginStatus 字段时显示登录态徽标 (推草稿前置), 其余平台显示 API 验证态。
 */
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { platformShortLabel, platformIcon, isBrowserLoginPlatform } from "../utils/platforms";

export interface SelectorAccount {
  id: string;
  platform: string;
  accountName: string;
  isVerified?: boolean | null;
  /** PR-S4/S6: 抖音/视频号浏览器登录态 (有值时这两个平台显示登录态而非验证态) */
  loginStatus?: "none" | "logged_in" | "expired";
  status?: string;
  groupName?: string | null;
  capability?: string | null;
}

export interface AccountSelectorProps {
  accounts: SelectorAccount[];
  /** 选中的账号 id */
  value: string[];
  onChange: (ids: string[]) => void;
  mode?: "multi" | "single";
  /** 默认勾选已验证账号 (由调用方决定; 仅在拿到账号且 value 为空时应用一次) */
  defaultVerifiedChecked?: boolean;
  /** 平台级全选 checkbox */
  showGroupSelectAll?: boolean;
  disabled?: boolean;
}

/** PR-S6: 走"浏览器登录态推草稿箱"的半自动平台 */


export default function AccountSelector({
  accounts,
  value,
  onChange,
  mode = "multi",
  defaultVerifiedChecked = false,
  showGroupSelectAll = false,
  disabled = false,
}: AccountSelectorProps) {
  // 默认勾选已验证账号 — 只应用一次, 之后完全交给用户
  const appliedDefaultRef = useRef(false);
  useEffect(() => {
    if (!defaultVerifiedChecked || appliedDefaultRef.current || accounts.length === 0) return;
    appliedDefaultRef.current = true;
    if (value.length > 0) return;
    const verified = accounts.filter((a) => a.isVerified).map((a) => a.id);
    if (verified.length === 0) return;
    onChange(mode === "single" ? verified.slice(0, 1) : verified);
  }, [accounts, defaultVerifiedChecked, mode, onChange, value.length]);

  const selected = new Set(value);

  // 按 platform groupBy (同原 DistributionCard)
  const grouped = accounts.reduce<Record<string, SelectorAccount[]>>((acc, a) => {
    (acc[a.platform] ??= []).push(a);
    return acc;
  }, {});
  const platforms = Object.keys(grouped).sort();

  const toggleOne = (id: string) => {
    if (disabled) return;
    if (mode === "single") {
      onChange(selected.has(id) ? [] : [id]);
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const toggleGroup = (platform: string) => {
    if (disabled || mode === "single") return;
    const ids = (grouped[platform] ?? []).map((a) => a.id);
    const allSelected = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onChange([...next]);
  };

  if (accounts.length === 0) {
    return (
      <p className="text-xs text-slate-400">
        无可用账号 (去 <Link to="/accounts" className="text-indigo-600 hover:text-indigo-500 underline">账号管理</Link> 添加)
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {platforms.map((p) => {
        const list = grouped[p] ?? [];
        const allSelected = list.every((a) => selected.has(a.id));
        return (
          <div key={p}>
            <div className="flex items-center gap-2 mb-1.5">
              {showGroupSelectAll && mode === "multi" && (
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => toggleGroup(p)}
                  disabled={disabled}
                  className="w-4 h-4 rounded border-slate-300 accent-indigo-600 cursor-pointer"
                  aria-label={`全选 ${platformShortLabel(p)}`}
                />
              )}
              <span className="text-sm leading-none">{platformIcon(p)}</span>
              <span className="text-xs font-medium text-slate-500">{platformShortLabel(p)}</span>
              <span className="text-xs text-slate-400">({list.length})</span>
            </div>
            <div className="space-y-1.5">
              {list.map((a) => (
                <label
                  key={a.id}
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-slate-50 ${
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
                  }`}
                >
                  <input
                    type={mode === "single" ? "radio" : "checkbox"}
                    checked={selected.has(a.id)}
                    onChange={() => toggleOne(a.id)}
                    disabled={disabled}
                    className="w-4 h-4 rounded border-slate-300 accent-indigo-600"
                  />
                  <span className="text-sm text-slate-700 flex-1 truncate">{a.accountName}</span>
                  {/* PR-S6: 抖音/视频号看登录态(推草稿前置); 其余平台看 API 验证 */}
                  {isBrowserLoginPlatform(a.platform) && a.loginStatus !== undefined ? (
                    a.loginStatus === "logged_in" ? (
                      <span className="text-xs text-emerald-600" title="已登录·可推草稿">✓ 已登录</span>
                    ) : (
                      <Link
                        to="/accounts"
                        className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 hover:bg-amber-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        未登录·去扫码
                      </Link>
                    )
                  ) : a.isVerified ? (
                    <span className="text-xs text-emerald-600" title="已验证">✓</span>
                  ) : (
                    <span className="text-xs text-slate-400" title="未验证">未验</span>
                  )}
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
