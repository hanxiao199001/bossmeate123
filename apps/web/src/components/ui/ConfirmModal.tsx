/**
 * 通用二次确认弹窗 — 用于不可逆操作(发布到真实平台等)最终确认。
 * 复用风格: 半透明遮罩 + 居中卡片 + 主/次按钮, 与站内其余 modal 一致。
 */
import type { ReactNode } from "react";

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** 正文内容(可传富文本: 账号列表 / 篇数等) */
  message: ReactNode;
  /** 不可逆提示(醒目红字), 如 "发布后不可撤回" */
  irreversibleNote?: string;
  confirmText?: string;
  cancelText?: string;
  /** true=危险主按钮(红); false=常规(绿) */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  irreversibleNote,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-2">
          <h3 className="text-base font-bold text-gray-900">{title}</h3>
        </div>
        <div className="px-6 py-2 text-sm text-gray-600 leading-relaxed max-h-72 overflow-y-auto">
          {message}
        </div>
        {irreversibleNote && (
          <div className="mx-6 my-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600 font-medium">
            ⚠ {irreversibleNote}
          </div>
        )}
        <div className="flex justify-end gap-3 px-6 py-4">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-50 ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-green-600 hover:bg-green-700"
            }`}
          >
            {loading ? "处理中..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
