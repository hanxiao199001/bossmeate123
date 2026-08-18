/**
 * 抽样裁决（Phase 3 前端）。**写好压着，等「研小二读懂周报」的确认再放出入口。**
 *
 * ## 这一页在整套东西里的位置
 *
 * 台账能数出「这道闸报了 37 条」，数不出「其中几条报对了」。
 * 没有后一个数，所有去留结论都卡在「台账未成熟」—— 周报上那一片
 * 「暂不评价」等的就是这里的输入。
 *
 * 而这个判断**恰恰不能交给 LLM**：整套台账建起来就是为了摆脱「LLM 评 LLM」。
 *
 * ## 交互刻意做得很窄
 *
 * 一次 10 条、每条三个按钮（拦对了 / 拦错了 / 本该拦没拦），没有输入框。
 * 「每周花 5 分钟」这句承诺是设计约束，不是宣传语 ——
 * 加一个自由文本框就会变成每条 30 秒，然后没人做。
 *
 * 复用 GoldenSetPage 的卡片式推进（一次一条、点完自动下一条），
 * 不另起一套交互 —— 同一个人两个页面，手感应该一样。
 *
 * ## 🔴 本页**尚未注册路由** —— 现在谁也访问不到
 *
 * 等「研小二读懂周报」的确认到了，放出来只需两步：
 *
 * ```
 * ① apps/web/src/App.tsx 加一条 Route：
 *      <Route path="/checker-adjudication" element={
 *        <ProtectedRoute><MainLayout><CheckerAdjudicationPage /></MainLayout></ProtectedRoute>
 *      } />
 * ② 周报 ⑤「这周要你做的事」里那句「等下周『抽样裁决』上线后」
 *      改成带链接的动作（services/ops/weekly-judgment-report.ts）
 * ```
 *
 * 之所以先写好压着：确认一到就能上，不用再等一轮开发 ——
 * 而不是先放出去等人来用（没数据的裁决页会让人以为坏了）。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../utils/api";

interface PendingHit {
  checkerId: string;
  guards: string;
  contentId: string;
  title: string;
  detail: string;
  createdAt: string;
}

interface CheckerStatus {
  checkerId: string;
  guards: string;
  mode: string;
  hits: number;
  adjudicated: number;
  votesNeeded: number;
  message: string;
}

type Verdict = "true_positive" | "false_positive" | "miss";

/** 三个选项。文案用运营的话，不用「真阳性/假阳性」 */
const CHOICES: Array<{ v: Verdict; label: string; hint: string; tone: string }> = [
  { v: "true_positive", label: "拦对了", hint: "这条确实有问题，闸报得对", tone: "#16a34a" },
  { v: "false_positive", label: "拦错了", hint: "这条其实没问题，是误报", tone: "#dc2626" },
  { v: "miss", label: "本该拦没拦", hint: "闸没报，但这条其实有别的问题", tone: "#ca8a04" },
];

export default function CheckerAdjudicationPage() {
  const [hits, setHits] = useState<PendingHit[]>([]);
  const [status, setStatus] = useState<CheckerStatus[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [s, st] = await Promise.all([
        api.get<{ hits: PendingHit[] }>("/ops/checkers/sample"),
        api.get<CheckerStatus[]>("/ops/checkers/status"),
      ]);
      setHits(s.data?.hits ?? []);
      setStatus(Array.isArray(st.data) ? st.data : []);
      setIdx(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (verdict: Verdict) => {
    const cur = hits[idx];
    if (!cur || saving) return;
    setSaving(true);
    try {
      await api.post("/ops/checkers/adjudicate", {
        checkerId: cur.checkerId,
        contentId: cur.contentId,
        verdict,
      });
      setDoneCount((n) => n + 1);
      setIdx((i) => i + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const cur = hits[idx];
  const remaining = Math.max(0, hits.length - idx);

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>抽样裁决</h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: 14 }}>
        系统的每道检查闸报出来的东西，到底对不对，只有人能判。
        每周点十条，系统就能自己算出「哪道闸该留、哪道该关」——
        在此之前它只能写「暂不评价」。
      </p>

      {err && (
        <div style={{ background: "#fef2f2", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {err}
        </div>
      )}

      {loading ? (
        <p>加载中…</p>
      ) : !cur ? (
        <div style={{ background: "#f0fdf4", padding: 20, borderRadius: 10, marginBottom: 24 }}>
          <strong>{doneCount > 0 ? `这一批判完了，本次判了 ${doneCount} 条 ✓` : "当前没有待裁决的内容"}</strong>
          <p style={{ color: "#555", fontSize: 14 }}>
            {doneCount > 0 ? "下周再来即可。" : "近 14 天没有闸报出来的内容 —— 这通常是好事。"}
          </p>
          <button onClick={() => void load()} style={{ padding: "8px 16px", marginTop: 8 }}>
            再抽一批
          </button>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 20, marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#888", fontSize: 13 }}>
            <span>
              第 {idx + 1} / {hits.length} 条（还剩 {remaining}）
            </span>
            <span>{new Date(cur.createdAt).toLocaleDateString("zh-CN")}</span>
          </div>

          {/* 先说这道闸防什么 —— 不知道判据的话没法判对错 */}
          <div style={{ background: "#f8fafc", padding: 12, borderRadius: 8, margin: "12px 0", fontSize: 14 }}>
            <div style={{ color: "#666" }}>这道闸防的是：</div>
            <div style={{ fontWeight: 600 }}>{cur.guards}</div>
          </div>

          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{cur.title || "（无标题）"}</div>
          <div style={{ background: "#fffbeb", padding: 12, borderRadius: 8, fontSize: 14, lineHeight: 1.7 }}>
            {cur.detail}
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            {CHOICES.map((c) => (
              <button
                key={c.v}
                disabled={saving}
                onClick={() => void submit(c.v)}
                title={c.hint}
                style={{
                  flex: 1,
                  padding: "12px 8px",
                  borderRadius: 8,
                  border: `1px solid ${c.tone}`,
                  background: "#fff",
                  color: c.tone,
                  fontWeight: 600,
                  cursor: saving ? "wait" : "pointer",
                }}
              >
                {c.label}
                <div style={{ fontWeight: 400, fontSize: 12, color: "#777", marginTop: 4 }}>{c.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 还差几票 —— 不给这个数，判的人不知道离「够用」还有多远 */}
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>各道闸的进度</h2>
      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#666" }}>
            <th style={{ padding: "6px 4px" }}>闸</th>
            <th>防什么</th>
            <th style={{ width: 70 }}>命中</th>
            <th style={{ width: 90 }}>还差几票</th>
          </tr>
        </thead>
        <tbody>
          {status.map((s) => (
            <tr key={s.checkerId} style={{ borderTop: "1px solid #f1f5f9" }}>
              <td style={{ padding: "6px 4px", fontFamily: "monospace", fontSize: 12 }}>
                {s.checkerId.replace(/^output_health\./, "")}
                {s.mode === "shadow" && <span style={{ color: "#999" }}>［影子］</span>}
              </td>
              <td style={{ color: "#555" }}>{s.guards}</td>
              <td>{s.hits}</td>
              <td style={{ color: s.votesNeeded === 0 ? "#16a34a" : "#666" }}>
                {s.votesNeeded === 0 ? "够了 ✓" : `${s.votesNeeded} 票`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
