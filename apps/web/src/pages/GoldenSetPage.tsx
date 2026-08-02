/**
 * Golden Set 标注页 — 评估体系的地基。
 *
 * ## 为什么要有这个页面
 * 系统至今没有任何评估能力: 改了 prompt 不知道变好还是变坏、六维评分器的信度从未验证过
 * (两个模型对同一批文章相关性只有 r=0.254)、老板走后没人能校准质量标尺。
 * 带理由的人工标注是"什么算好内容"这个标准**唯一能被代码消费的形式** —— 文档写不出、注释留不住。
 *
 * ## 🔴 防锚定(这个页面最重要的设计)
 * 标注前**绝不显示**六维分/AI审稿/质检状态。看到"83 分"再判断，测出来的就不是人的标准，
 * 而是"人对系统打分的认同度" —— 那份数据一文不值。
 * 后端 /candidates 与 /content/:id 已在响应层剔除评分字段(assertBlind 会主动拦截泄漏)，
 * 前端这里再守一道: 系统分只在**标完这一篇之后**、按需拉 /system-scores 才显示。
 *
 * ## 快捷键(4-5 小时标 50 篇，鼠标点不过来)
 *   1 = 好   2 = 中   3 = 差   ← → 翻页   Ctrl/Cmd+Enter = 保存理由并下一篇
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../utils/api";
import { sanitizeHtml } from "../utils/sanitize";

type GoldenLabel = "good" | "fair" | "poor";

const LABEL_TEXT: Record<GoldenLabel, string> = {
  good: "好 — 可以直接发",
  fair: "中 — 改改能发",
  poor: "差 — 不能发",
};

const LABEL_STYLE: Record<GoldenLabel, string> = {
  good: "bg-emerald-600 hover:bg-emerald-700 border-emerald-600",
  fair: "bg-amber-500 hover:bg-amber-600 border-amber-500",
  poor: "bg-rose-600 hover:bg-rose-700 border-rose-600",
};

interface BlindJournal {
  name: string | null;
  impactFactor: string | number | null;
  partition: string | null;
  catalogs: unknown;
}

interface BlindCard {
  id: string;
  title: string | null;
  body: string | null;
  kind: string;
  kindText: string;
  createdAt: string | null;
  journal: BlindJournal | null;
  myLabel: string | null;
  myReason: string | null;
}

interface SystemScores {
  sixDimTotal: number | null;
  degraded?: boolean;
  degradedReason?: string | null;
  status?: string | null;
  dims?: Record<string, { score: number }> | null;
}

interface Stats {
  target: number;
  mine: number;
  total: number;
  distribution?: Record<string, number>;
}

export default function GoldenSetPage() {
  const [cards, setCards] = useState<BlindCard[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  // 系统分只在标完之后才拉 —— 防锚定的关键，别提前
  const [scores, setScores] = useState<SystemScores | null>(null);
  const [scoresLoading, setScoresLoading] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);

  const card = cards[idx];

  const loadStats = useCallback(async () => {
    try {
      const r = await api.get<Stats>("/golden-set/stats");
      if (r.data) setStats(r.data);
    } catch {
      /* 进度条挂了不该挡住标注 */
    }
  }, []);

  const loadCards = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.get<{ items: BlindCard[]; poolSize?: number }>(
        "/golden-set/candidates?strategy=sampled&limit=50"
      );
      setCards(r.data?.items ?? []);
      setIdx(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "拉取待标内容失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCards();
    void loadStats();
  }, [loadCards, loadStats]);

  // 切换卡片时重置：理由回填自己之前标的、系统分收起、正文折叠复位
  useEffect(() => {
    setReason(card?.myReason ?? "");
    setScores(null);
    setBodyExpanded(false);
  }, [card?.id, card?.myReason]);

  const fetchScores = useCallback(async (contentId: string) => {
    setScoresLoading(true);
    try {
      const r = await api.get<SystemScores>(`/golden-set/content/${contentId}/system-scores`);
      setScores(r.data ?? null);
    } catch {
      setScores(null);
    } finally {
      setScoresLoading(false);
    }
  }, []);

  const annotate = useCallback(
    async (label: GoldenLabel, opts: { advance?: boolean } = {}) => {
      if (!card || saving) return;
      setSaving(true);
      try {
        await api.post("/golden-set/annotate", {
          contentId: card.id,
          label,
          reason: reason.trim() || undefined,
        });
        // 本地同步，避免翻回来看到旧值
        setCards((prev) =>
          prev.map((c) => (c.id === card.id ? { ...c, myLabel: label, myReason: reason.trim() || null } : c))
        );
        void loadStats();
        // 标完才允许看系统分
        void fetchScores(card.id);
        if (opts.advance !== false && idx < cards.length - 1) {
          // 给 300ms 看一眼系统分再跳，不然刚出来就被翻走了
          setTimeout(() => setIdx((i) => Math.min(i + 1, cards.length - 1)), 900);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "保存失败");
      } finally {
        setSaving(false);
      }
    },
    [card, reason, saving, idx, cards.length, loadStats, fetchScores]
  );

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (inInput) {
        // 理由框里 Cmd/Ctrl+Enter = 保存当前标签并下一篇
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && card?.myLabel) {
          e.preventDefault();
          void annotate(card.myLabel as GoldenLabel);
        }
        return;
      }
      if (e.key === "1") void annotate("good");
      else if (e.key === "2") void annotate("fair");
      else if (e.key === "3") void annotate("poor");
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, cards.length - 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotate, cards.length, card?.myLabel]);

  const done = stats?.mine ?? 0;
  const target = stats?.target ?? 50;
  const pct = Math.min(100, Math.round((done / target) * 100));
  const remainMin = Math.max(0, Math.round((target - done) * 4)); // 经验值 4 分钟/篇

  return (
    <div className="pb-24">
      <div className="px-6 pt-4">
        <h1 className="text-xl font-medium">🏷️ 内容标注（Golden Set）</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          凭你的judgment标"能不能发"，<b>标完才会显示系统给的分</b>——先看到分会带偏判断，那样这批数据就白标了
        </p>
      </div>

      {/* 进度 */}
      <div className="max-w-6xl mx-auto px-6 mt-4">
        <div className="bg-white border rounded-lg p-3 flex items-center gap-4">
          <div className="flex-1">
            <div className="flex justify-between text-xs text-gray-600 mb-1">
              <span>
                已标 <b className="text-gray-900">{done}</b> / {target} 篇
                {stats && stats.total > done ? <span className="text-gray-400">（全员共 {stats.total}）</span> : null}
              </span>
              <span>{done >= target ? "🎉 够用了，多标更准" : `预计还需 ${remainMin} 分钟`}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <button onClick={() => void loadCards()} className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50">
            换一批
          </button>
        </div>
      </div>

      {err && (
        <div className="max-w-6xl mx-auto px-6 mt-3">
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded p-3">{err}</div>
        </div>
      )}

      {loading ? (
        <div className="max-w-6xl mx-auto px-6 py-16 text-center text-gray-400">加载中…</div>
      ) : !card ? (
        <div className="max-w-6xl mx-auto px-6 py-16 text-center text-gray-400">
          没有待标内容了。点「换一批」重新采样，或者去内容工坊看看有没有新内容。
        </div>
      ) : (
        <main className="max-w-6xl mx-auto px-6 py-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          {/* 左：内容 */}
          <div className="bg-white border rounded-lg p-5">
            <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
              <span className="px-2 py-0.5 bg-gray-100 rounded">{card.kindText}</span>
              {card.createdAt && <span>{new Date(card.createdAt).toLocaleDateString("zh-CN")}</span>}
              <span className="ml-auto">
                第 {idx + 1} / {cards.length} 篇
              </span>
            </div>

            <h2 className="text-lg font-semibold leading-snug mb-1">{card.title || "（无标题）"}</h2>

            {card.journal && (
              <div className="text-xs text-gray-500 mb-4 flex flex-wrap gap-x-3 gap-y-1">
                {card.journal.name && <span>📖 {card.journal.name}</span>}
                {card.journal.impactFactor != null && <span>IF {String(card.journal.impactFactor)}</span>}
                {card.journal.partition && <span>{card.journal.partition}</span>}
              </div>
            )}

            <div
              className={`prose prose-sm max-w-none text-gray-800 overflow-hidden ${
                bodyExpanded ? "" : "max-h-[420px]"
              }`}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(card.body || "<p class='text-gray-400'>（无正文）</p>") }}
            />
            {!bodyExpanded && (card.body?.length ?? 0) > 1200 && (
              <button
                onClick={() => setBodyExpanded(true)}
                className="mt-2 text-xs text-blue-600 hover:underline"
              >
                展开全文 ↓
              </button>
            )}
          </div>

          {/* 右：标注 */}
          <div className="space-y-4">
            <div className="bg-white border rounded-lg p-4 sticky top-4">
              <div className="text-sm font-medium mb-3">这篇能不能发？</div>
              <div className="space-y-2">
                {(["good", "fair", "poor"] as GoldenLabel[]).map((l, i) => (
                  <button
                    key={l}
                    onClick={() => void annotate(l)}
                    disabled={saving}
                    className={`w-full text-left px-3 py-2.5 rounded border text-white text-sm transition disabled:opacity-50 ${LABEL_STYLE[l]} ${
                      card.myLabel === l ? "ring-2 ring-offset-1 ring-gray-800" : ""
                    }`}
                  >
                    <span className="inline-block w-5 text-white/70">{i + 1}</span>
                    {LABEL_TEXT[l]}
                    {card.myLabel === l && <span className="float-right">✓</span>}
                  </button>
                ))}
              </div>

              <div className="mt-4">
                <label className="text-xs text-gray-600 block mb-1">
                  为什么？<span className="text-gray-400">（一句话，最值钱的部分）</span>
                </label>
                <textarea
                  ref={reasonRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="如：数据太少像凑字数 / 期刊不对口 / 标题没钩子 / 像 AI 写的"
                  className="w-full text-sm border rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  这些理由会被提炼成「驳回原因」分类，是系统学会自我调整的输入
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => setIdx((i) => Math.max(i - 1, 0))}
                  disabled={idx === 0}
                  className="flex-1 text-xs px-2 py-1.5 border rounded hover:bg-gray-50 disabled:opacity-40"
                >
                  ← 上一篇
                </button>
                <button
                  onClick={() => setIdx((i) => Math.min(i + 1, cards.length - 1))}
                  disabled={idx >= cards.length - 1}
                  className="flex-1 text-xs px-2 py-1.5 border rounded hover:bg-gray-50 disabled:opacity-40"
                >
                  下一篇 →
                </button>
              </div>
              <div className="text-[11px] text-gray-400 mt-2 text-center">
                快捷键：1 好 · 2 中 · 3 差 · ← → 翻页
              </div>
            </div>

            {/* 系统分：标完才出现 */}
            {(scores || scoresLoading) && (
              <div className="bg-gray-50 border rounded-lg p-4">
                <div className="text-xs text-gray-500 mb-2">系统当时给的分（标完才显示）</div>
                {scoresLoading ? (
                  <div className="text-sm text-gray-400">加载中…</div>
                ) : scores?.sixDimTotal == null ? (
                  <div className="text-sm text-gray-600">
                    <b>未评上分</b>
                    <div className="text-xs text-gray-400 mt-1">
                      {scores?.degradedReason || "评分器当时不可用，不是内容问题"}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="text-2xl font-semibold">{scores.sixDimTotal}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {scores.sixDimTotal >= 80 ? "系统判：可发" : "系统判：未达发布线"}
                      {card.myLabel && (
                        <span className="ml-1">
                          · 你判：{LABEL_TEXT[card.myLabel as GoldenLabel].split(" ")[0]}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
