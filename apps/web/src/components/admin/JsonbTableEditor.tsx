/**
 * jsonb table editor（PR-1 admin v2 framework）。
 *
 * schema-driven 行编辑：每列声明 key / label / 类型，组件渲染 add row + remove row + 单元格 input。
 * 适用于 ifHistory.data（year/if）/ scopeDetails.subjectDistribution（subject/percent）等数组-of-行 形状。
 *
 * 行级 add/remove 是 admin 主操作，不做拖拽排序（B.4-1 enricher 已按 year 排序，admin 一般不动）。
 * 上限 maxRows=50 防 DoS（与 backend zod array max 50 对齐）。
 */
import { useCallback } from "react";

export type JsonbTableColumn =
  | { key: string; label: string; type: "string"; width?: string; placeholder?: string }
  | { key: string; label: string; type: "number"; width?: string; step?: number; min?: number; max?: number };

type Row = Record<string, unknown>;

export function JsonbTableEditor({
  columns,
  rows,
  onChange,
  maxRows = 50,
  newRowDefaults,
}: {
  columns: ReadonlyArray<JsonbTableColumn>;
  rows: Row[] | null | undefined;
  onChange: (next: Row[]) => void;
  maxRows?: number;
  newRowDefaults?: Row;
}) {
  const list = Array.isArray(rows) ? rows : [];

  const updateCell = useCallback(
    (rowIdx: number, key: string, raw: unknown) => {
      const next = list.map((r, i) => (i === rowIdx ? { ...r, [key]: raw } : r));
      onChange(next);
    },
    [list, onChange],
  );

  const removeRow = useCallback(
    (rowIdx: number) => {
      onChange(list.filter((_, i) => i !== rowIdx));
    },
    [list, onChange],
  );

  const addRow = useCallback(() => {
    if (list.length >= maxRows) return;
    const blank: Row = newRowDefaults ? { ...newRowDefaults } : {};
    columns.forEach((c) => {
      if (!(c.key in blank)) blank[c.key] = c.type === "number" ? null : "";
    });
    onChange([...list, blank]);
  }, [list, onChange, columns, maxRows, newRowDefaults]);

  return (
    <div className="border border-gray-200 rounded bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr className="text-left text-gray-600">
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-xs font-medium" style={c.width ? { width: c.width } : undefined}>
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2 w-16"></th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr><td colSpan={columns.length + 1} className="px-3 py-4 text-center text-gray-400 text-xs">暂无行 — 点下方"+ 添加"</td></tr>
          )}
          {list.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              {columns.map((c) => {
                const cur = row[c.key];
                if (c.type === "number") {
                  return (
                    <td key={c.key} className="px-3 py-1.5">
                      <input
                        type="number"
                        value={cur == null || cur === "" ? "" : String(cur)}
                        step={c.step}
                        min={c.min}
                        max={c.max}
                        onChange={(e) => updateCell(i, c.key, e.target.value === "" ? null : Number(e.target.value))}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </td>
                  );
                }
                return (
                  <td key={c.key} className="px-3 py-1.5">
                    <input
                      type="text"
                      value={(cur as string) ?? ""}
                      placeholder={c.placeholder}
                      onChange={(e) => updateCell(i, c.key, e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                );
              })}
              <td className="px-3 py-1.5 text-right">
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-xs px-2 py-0.5 rounded text-red-600 hover:bg-red-50"
                  title="删除该行"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-3 py-2 border-t border-gray-200 flex items-center justify-between">
        <span className="text-xs text-gray-400">{list.length} / {maxRows} 行</span>
        <button
          type="button"
          onClick={addRow}
          disabled={list.length >= maxRows}
          className={`text-xs px-3 py-1 rounded ${list.length >= maxRows ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100"}`}
        >
          + 添加行
        </button>
      </div>
    </div>
  );
}
