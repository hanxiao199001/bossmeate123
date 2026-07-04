/**
 * 7-05 多租户开通 P0 — 老板首登向导卡片(非强制弹窗, 可收起)。
 * 挂在首页(TodayPage)顶部, 仅 owner 且 checklist 未完成/未 dismiss 时显示。
 * 数据: GET/PATCH /tenant/onboarding(存 tenantPreferences key='onboarding_checklist')。
 * 5 步: 企业信息 → 邀请团队 → 绑定发布账号 → 内容方向与人设 → 第一篇样稿。
 * 跳转目标均为前端现有真实路由: /settings /accounts /workbench。
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../utils/api";
import { useAuthStore } from "../hooks/useAuthStore";

type StepStatus = "pending" | "done" | "skipped";
type StepKey = "profile" | "invite" | "accounts" | "persona" | "sample";

interface Checklist {
  steps: Record<StepKey, StepStatus>;
  dismissedAt?: string;
  doneCount: number;
  totalCount: number;
}

const STEP_META: Array<{ key: StepKey; title: string; desc: string; to: string; cta: string }> = [
  { key: "profile", title: "确认企业信息", desc: "核对公司资料与联系方式, 内容署名/模板会用到", to: "/settings", cta: "去设置" },
  { key: "invite", title: "邀请团队", desc: "把运营/销售同事按手机号邀请进来(登录即入职)", to: "/settings", cta: "去邀请" },
  { key: "accounts", title: "绑定发布账号", desc: "接入公众号/抖音/视频号等发布渠道", to: "/accounts", cta: "去绑定" },
  { key: "persona", title: "选内容方向与人设", desc: "给每个账号定人设画像, 生成的内容才有你的味道", to: "/accounts", cta: "去配置" },
  { key: "sample", title: "生成第一篇样稿", desc: "到内容工坊生成一篇, 看看 AI 员工的产出", to: "/workbench", cta: "去生成" },
];

export default function OnboardingChecklist() {
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<Checklist | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const isOwner = user?.role === "owner";

  useEffect(() => {
    if (!isOwner) return;
    api.get<Checklist>("/tenant/onboarding")
      .then((r) => setData(r.data ?? null))
      .catch(() => setData(null)); // 老后端无此接口 → 不显示
  }, [isOwner]);

  if (!isOwner || !data) return null;
  if (data.dismissedAt) return null;
  const allDone = STEP_META.every((s) => data.steps[s.key] !== "pending");
  if (allDone) return null; // 全部完成 → 卡片自动消失

  const patch = async (body: { step?: StepKey; status?: StepStatus; dismiss?: boolean }) => {
    setBusyStep(body.step ?? "dismiss");
    try {
      const r = await api.patch<Checklist>("/tenant/onboarding", body);
      if (r.data) setData(r.data);
    } catch { /* api 层已 toast */ } finally {
      setBusyStep(null);
    }
  };

  const doneCount = STEP_META.filter((s) => data.steps[s.key] !== "pending").length;
  const pct = Math.round((doneCount / STEP_META.length) * 100);

  return (
    <div className="bg-gradient-to-br from-indigo-50 to-white rounded-xl border border-indigo-100 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-900">🚀 欢迎使用 BossMate — 5 步开工清单</h2>
          <p className="text-xs text-gray-500 mt-0.5">按顺序走完, 你的 AI 员工就正式上岗了。随时可收起, 不影响使用。</p>
        </div>
        <button
          onClick={() => void patch({ dismiss: true })}
          disabled={busyStep === "dismiss"}
          className="shrink-0 text-xs text-gray-400 hover:text-gray-600"
          title="收起后不再提示(可让管理员在接口里恢复)"
        >
          收起不再提示
        </button>
      </div>

      {/* 进度条 */}
      <div className="mt-3 flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-indigo-100 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-indigo-600 font-medium shrink-0">{doneCount}/{STEP_META.length}</span>
      </div>

      <ul className="mt-4 space-y-2">
        {STEP_META.map((s, i) => {
          const st = data.steps[s.key];
          const finished = st !== "pending";
          return (
            <li key={s.key} className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 ${finished ? "bg-white/60" : "bg-white border border-gray-100"}`}>
              <span className={`w-5 h-5 rounded-full text-[11px] flex items-center justify-center shrink-0 ${
                st === "done" ? "bg-emerald-500 text-white" : st === "skipped" ? "bg-gray-300 text-white" : "bg-indigo-100 text-indigo-600 font-medium"}`}>
                {st === "done" ? "✓" : st === "skipped" ? "—" : i + 1}
              </span>
              <div className="flex-1 min-w-[180px]">
                <div className={`text-sm ${finished ? "text-gray-400 line-through" : "text-gray-900 font-medium"}`}>{s.title}</div>
                {!finished && <div className="text-xs text-gray-400">{s.desc}</div>}
              </div>
              {!finished && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Link to={s.to} className="px-2.5 py-1 rounded-md bg-indigo-600 text-white text-xs hover:bg-indigo-700">{s.cta}</Link>
                  <button onClick={() => void patch({ step: s.key, status: "done" })} disabled={busyStep === s.key}
                    className="px-2 py-1 rounded-md border border-gray-200 text-xs text-gray-500 hover:text-emerald-600 hover:border-emerald-200 disabled:opacity-50">
                    标记完成
                  </button>
                  <button onClick={() => void patch({ step: s.key, status: "skipped" })} disabled={busyStep === s.key}
                    className="px-2 py-1 rounded-md text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50">
                    跳过
                  </button>
                </div>
              )}
              {finished && (
                <button onClick={() => void patch({ step: s.key, status: "pending" })} disabled={busyStep === s.key}
                  className="text-[11px] text-gray-300 hover:text-gray-500 shrink-0">撤销</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
