/**
 * 运行时参数面板（Phase 4）。**验收标准：老韩不碰代码改掉一个阈值。**
 *
 * ## 🔴 必须显示「来源」，不能只显示数字（红线 #22）
 *
 * 读取顺序是 `DB → env → 代码默认`，三层都可能是当前值的出处。
 * 只显示一个数字，就无法回答「这个 30 是配的还是默认的」——
 * 而两种情况的处置完全不同：前者要改配置，后者要改代码。
 *
 * 8-18 实测踩过：代码默认已改成 40，但 DB 里躺着 30 分钟前自测写的 30，
 * **实际生效是 30**，而代码里白纸黑字写着 40。
 * 那次如果参数页只显示数字，运营看到 30 会以为「就该是 30」。
 *
 * ## 边界由后端说了算
 *
 * `min/max` 从接口带下来，前端只做提示；**真正的拦截在写入侧**
 * （`setParam` 里校验）—— 前端能绕过，DB 不能。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../utils/api";

interface ParamRow {
  key: string;
  type: "number" | "boolean";
  label: string;
  impact: string;
  current: number | boolean;
  source: "配置" | "环境变量" | "默认";
  min?: number;
  max?: number;
  audience: "运营" | "开发";
}

/** 来源徽标 —— 颜色只是辅助，文字本身必须能独立读懂 */
const SOURCE_STYLE: Record<ParamRow["source"], { bg: string; fg: string; hint: string }> = {
  配置: { bg: "#eff6ff", fg: "#1d4ed8", hint: "有人改过，存在数据库里" },
  环境变量: { bg: "#fefce8", fg: "#a16207", hint: "来自服务器环境变量" },
  默认: { bg: "#f8fafc", fg: "#475569", hint: "没人配过，用的是代码里的默认值" },
};

export default function RuntimeParamsPanel() {
  const [rows, setRows] = useState<ParamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<ParamRow[]>("/ops/params");
      setRows(Array.isArray(r.data) ? r.data : []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (p: ParamRow, raw: number | boolean) => {
    setSaving(p.key);
    try {
      await api.put(`/ops/params/${p.key}`, { value: raw });
      await load();
      setEditing((e) => ({ ...e, [p.key]: "" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(null);
    }
  };

  if (loading) return <p>加载中…</p>;

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>系统参数</h2>
      <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
        改完立刻生效，不需要重启。每次改动都会记录是谁改的、改前是多少。
      </p>

      {err && (
        <div style={{ background: "#fef2f2", color: "#991b1b", padding: 10, borderRadius: 8, margin: "10px 0" }}>{err}</div>
      )}

      {rows.map((p) => {
        const st = SOURCE_STYLE[p.source];
        return (
          <div key={p.key} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{p.label}</strong>
              {/* 🔴 来源徽标 —— 红线 #22：运营看到的必须是生效值 + 它从哪来 */}
              <span
                title={st.hint}
                style={{ background: st.bg, color: st.fg, fontSize: 12, padding: "2px 8px", borderRadius: 999 }}
              >
                {p.source}
              </span>
              {p.audience === "开发" && (
                <span style={{ background: "#fef2f2", color: "#b91c1c", fontSize: 12, padding: "2px 8px", borderRadius: 999 }}>
                  开发用·改前先问
                </span>
              )}
            </div>

            <div style={{ color: "#555", fontSize: 13, margin: "8px 0", lineHeight: 1.7 }}>{p.impact}</div>

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "#888", fontSize: 13 }}>当前</span>
              <strong style={{ fontSize: 16 }}>{String(p.current)}</strong>

              {p.type === "boolean" ? (
                <button
                  disabled={saving === p.key}
                  onClick={() => void save(p, !(p.current as boolean))}
                  style={{ padding: "6px 14px", borderRadius: 8 }}
                >
                  改为 {String(!(p.current as boolean))}
                </button>
              ) : (
                <>
                  <input
                    type="number"
                    value={editing[p.key] ?? ""}
                    placeholder={`${p.min ?? ""} ~ ${p.max ?? ""}`}
                    onChange={(e) => setEditing((s) => ({ ...s, [p.key]: e.target.value }))}
                    style={{ width: 110, padding: "6px 8px", borderRadius: 8, border: "1px solid #d1d5db" }}
                  />
                  <button
                    disabled={saving === p.key || !editing[p.key]}
                    onClick={() => void save(p, Number(editing[p.key]))}
                    style={{ padding: "6px 14px", borderRadius: 8 }}
                  >
                    保存
                  </button>
                  <span style={{ color: "#999", fontSize: 12 }}>
                    允许范围 {p.min} ~ {p.max}
                  </span>
                </>
              )}
            </div>
            <div style={{ color: "#aaa", fontSize: 11, marginTop: 6, fontFamily: "monospace" }}>{p.key}</div>
          </div>
        );
      })}
    </div>
  );
}
