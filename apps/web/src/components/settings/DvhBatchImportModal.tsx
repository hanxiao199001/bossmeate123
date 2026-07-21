/**
 * 7-21 数字人形象「批量粘贴导入」弹框。
 *   老板从阿里云控制台复制多个公模形象, 一次粘贴多行 → 预览 → 勾选 → 追加进目录。
 *   关键: 导入是「追加不覆盖」——由父组件把现有 extras + 勾选新条目 一起 PATCH, 绝不冲掉已有形象。
 *   同 avatarCode(现有目录 或 批内重复)标记为「已存在」, 默认不勾, 导入跳过。
 */
import { useMemo, useState } from "react";
import { parseDvhCatalogPaste, type ParsedDvhEntry } from "../../utils/dvhCatalogParse";

const MAX_TOTAL = 50; // 与后端 PATCH /admin/dvh-catalog 上限一致

export interface DvhImportEntry {
  key: string;
  avatarCode: string;
  avatarLabel: string;
  voiceCode: string;
  voiceLabel: string;
  templateLabel: string;
  preview?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 现有目录已占用的 avatarCode(含内置), 用于标记「已存在」 */
  existingCodes: string[];
  /** 现有目录总条数(含内置), 用于 50 条上限提示 */
  existingCount: number;
  /** 确认导入: 父组件负责「读现有 extras + 追加这些 + PATCH 整体」 */
  onConfirm: (entries: DvhImportEntry[]) => Promise<void>;
}

const PLACEHOLDER = `每行一个形象，格式：
名字 | avatarCode | 音色code(可选) | 预览图URL(可选)

例：
博远-西装男 | CH_2d_37AsLhUrBxacjHP0 | | https://xxx.jpg
知性女声 | CH_2d_aaaaBBBBccccDDDD | maoxiaomei
（分隔符用 | 或 Tab 或多个空格都行，可从阿里云表格直接复制）`;

export default function DvhBatchImportModal({ open, onClose, existingCodes, existingCount, onConfirm }: Props) {
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { entries, errors } = useMemo(
    () => parseDvhCatalogPaste(text, { existingCodes }),
    [text, existingCodes],
  );

  // 默认勾选: 新增(非 dup)且已解析出的行; dup 默认不勾
  const isChecked = (e: ParsedDvhEntry) =>
    checked[e.line] ?? !e.isDup;

  const selected = entries.filter((e) => isChecked(e) && !e.isDup);
  const wouldTotal = existingCount + selected.length;
  const overLimit = wouldTotal > MAX_TOTAL;

  const reset = () => { setText(""); setChecked({}); setErr(null); setImporting(false); };
  const close = () => { reset(); onClose(); };

  const doImport = async () => {
    if (selected.length === 0) { setErr("没有可导入的新形象(已存在的会跳过)"); return; }
    if (overLimit) { setErr(`目录上限 ${MAX_TOTAL} 条，当前 ${existingCount} 条，本次勾选 ${selected.length} 条会超限`); return; }
    setImporting(true); setErr(null);
    try {
      await onConfirm(selected.map((e) => ({
        key: e.key,
        avatarCode: e.avatarCode,
        avatarLabel: e.avatarLabel,
        voiceCode: e.voiceCode,
        voiceLabel: e.voiceLabel,
        templateLabel: e.templateLabel,
        ...(e.preview ? { preview: e.preview } : {}),
      })));
      close();
    } catch (e: any) {
      setErr("导入失败: " + (e?.response?.data?.message || e?.message || "未知"));
      setImporting(false);
    }
  };

  if (!open) return null;
  const newCount = entries.filter((e) => !e.isDup).length;
  const dupCount = entries.filter((e) => e.isDup).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">📋 批量粘贴导入形象</h2>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="text-xs text-gray-500 leading-relaxed">
            阿里云控制台 → 2D 数字人资产中心，把形象信息按下面格式每行一个粘进来。
            <b>名字、avatarCode 必填</b>；音色留空用系统默认（艾夏-亲和女声）；预览图 URL 可选。
            <b>导入是追加</b>，不会覆盖已有形象；同一 avatarCode 已存在的会自动跳过。
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setChecked({}); }}
            placeholder={PLACEHOLDER}
            rows={7}
            className="w-full text-xs font-mono border border-gray-300 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-fuchsia-200"
          />

          {errors.length > 0 && (
            <div className="text-xs text-amber-600 bg-amber-50 rounded p-2 space-y-0.5">
              {errors.map((m, i) => <div key={i}>⚠️ {m}</div>)}
            </div>
          )}

          {entries.length > 0 && (
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                解析出 {entries.length} 行
                <span className="text-green-600">新增 {newCount}</span>
                {dupCount > 0 && <span className="text-gray-400">已存在(跳过) {dupCount}</span>}
              </div>
              <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 max-h-64 overflow-y-auto">
                {entries.map((e) => (
                  <div key={e.line} className={`flex items-center gap-2 px-3 py-2 text-xs ${e.isDup ? "opacity-50" : ""}`}>
                    <input
                      type="checkbox"
                      checked={isChecked(e)}
                      disabled={e.isDup}
                      onChange={(ev) => setChecked((c) => ({ ...c, [e.line]: ev.target.checked }))}
                      className="flex-shrink-0"
                    />
                    {e.preview ? (
                      <img src={e.preview} alt="" className="w-7 h-7 rounded object-cover bg-gray-50 flex-shrink-0" />
                    ) : (
                      <div className="w-7 h-7 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">🧑‍🎤</div>
                    )}
                    <span className="font-medium text-gray-800 truncate max-w-[110px]" title={e.avatarLabel}>{e.avatarLabel}</span>
                    <span className={`truncate max-w-[150px] ${e.codeWarning ? "text-red-500" : "text-gray-400"}`} title={e.avatarCode}>
                      {e.avatarCode}{e.codeWarning ? " (格式异常?)" : ""}
                    </span>
                    <span className="text-gray-400 ml-auto">🎙 {e.voiceCode}</span>
                    {e.isDup && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 flex-shrink-0">已存在</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {overLimit && (
            <div className="text-xs text-red-600 bg-red-50 rounded p-2">
              目录上限 {MAX_TOTAL} 条：现有 {existingCount} 条 + 本次 {selected.length} 条 = {wouldTotal} 条，超限。请减少勾选。
            </div>
          )}
          {err && <div className="text-sm text-red-600">❌ {err}</div>}
        </div>

        <div className="px-6 py-3 border-t bg-gray-50 flex items-center justify-between gap-2">
          <span className="text-xs text-gray-500">
            将导入 <b className="text-fuchsia-700">{selected.length}</b> 个新形象（追加，不覆盖现有 {existingCount} 个）
          </span>
          <div className="flex items-center gap-2">
            <button onClick={close} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">取消</button>
            <button
              onClick={() => void doImport()}
              disabled={importing || selected.length === 0 || overLimit}
              className={`px-4 py-1.5 text-sm font-medium rounded ${importing || selected.length === 0 || overLimit
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-fuchsia-600 text-white hover:bg-fuchsia-700"}`}
            >
              {importing ? "导入中…" : `追加导入 ${selected.length} 个`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
