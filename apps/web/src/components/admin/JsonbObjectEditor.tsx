/**
 * jsonb scalar-object editor（PR-1 admin v2 framework）。
 *
 * 用法：传 schema 描述字段类型 + value，组件渲染对应 input。
 * 适用于 publicationCosts 这种纯 scalar 字段集合（apc / currency / openAccess / fastTrack / source）。
 *
 * 不支持嵌套对象/数组 — 那些场景请用 JsonbTableEditor 或自己组合。
 */
import { useCallback } from "react";

export type JsonbObjectField =
  | { key: string; label: string; type: "string"; placeholder?: string }
  | { key: string; label: string; type: "number"; step?: number; min?: number; max?: number }
  | { key: string; label: string; type: "bool" }
  | { key: string; label: string; type: "enum"; options: ReadonlyArray<string> };

type ObjectValue = Record<string, unknown> | null | undefined;

export function JsonbObjectEditor({
  schema,
  value,
  onChange,
}: {
  schema: ReadonlyArray<JsonbObjectField>;
  value: ObjectValue;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const v = value ?? {};
  const update = useCallback(
    (key: string, raw: unknown) => {
      const next = { ...v };
      if (raw === "" || raw === null || raw === undefined) delete next[key];
      else next[key] = raw;
      onChange(next);
    },
    [v, onChange],
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {schema.map((f) => {
        const cur = (v as Record<string, unknown>)[f.key];
        const labelEl = <span className="block text-xs font-medium text-gray-600 mb-1">{f.label}</span>;
        if (f.type === "string") {
          return (
            <label key={f.key} className="block">
              {labelEl}
              <input
                type="text"
                value={(cur as string) ?? ""}
                placeholder={f.placeholder}
                onChange={(e) => update(f.key, e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>
          );
        }
        if (f.type === "number") {
          return (
            <label key={f.key} className="block">
              {labelEl}
              <input
                type="number"
                value={cur == null ? "" : String(cur)}
                step={f.step}
                min={f.min}
                max={f.max}
                onChange={(e) => update(f.key, e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </label>
          );
        }
        if (f.type === "bool") {
          return (
            <label key={f.key} className="flex items-center gap-2 text-sm text-gray-700 mt-5">
              <input
                type="checkbox"
                checked={cur === true}
                onChange={(e) => update(f.key, e.target.checked ? true : "")}
              />
              {f.label}
            </label>
          );
        }
        // enum
        return (
          <label key={f.key} className="block">
            {labelEl}
            <select
              value={(cur as string) ?? ""}
              onChange={(e) => update(f.key, e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="">（未设置）</option>
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
}
