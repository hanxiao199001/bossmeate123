/**
 * 7-05 多租户开通 P0 — 「平台管理」页(替代 ssh 跑 provision-tenant CLI)。
 * 仅平台管理员(手机号在 PLATFORM_ADMIN_PHONES 白名单)可见/可用:
 *   上半: 客户开通表单(公司/老板手机/姓名/信用代码/法人/执照URL/套餐) → POST /platform/tenants
 *         成功提示含欢迎短信结果(未配置短信 → 提示"请口头通知客户")
 *   下半: 客户列表(公司/owner手机/套餐/状态/成员数/创建时间), 分页 → GET /platform/tenants
 * 风格照 KfServicePage / AccountsPage(白卡 + tailwind)。
 */
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api, ApiError } from "../utils/api";
import { toast } from "../components/Toast";
import { usePlatformAdmin } from "../hooks/usePlatformAdmin";

interface PlatformTenant {
  id: string;
  name: string;
  plan: string;
  status: string;
  verifiedStatus: string | null;
  createdAt: string;
  ownerPhone: string | null;
  memberCount: number;
}

interface ProvisionResp {
  tenant: { id: string; name: string; plan: string };
  owner: { id: string; phone: string | null; name: string };
  smsSent: boolean;
  smsNote: string;
}

const PLAN_LABEL: Record<string, string> = { free: "免费", trial: "试用", basic: "基础", pro: "专业" };
const PHONE_RE = /^1[3-9]\d{9}$/;

const emptyForm = { company: "", phone: "", name: "", credit: "", legal: "", licenseUrl: "", plan: "trial" };

export default function PlatformPage() {
  const { isPlatformAdmin, checked } = usePlatformAdmin();

  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<ProvisionResp | null>(null);

  const [items, setItems] = useState<PlatformTenant[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const r = await api.get<{ items: PlatformTenant[]; total: number }>(
        `/platform/tenants?page=${p}&pageSize=${pageSize}`,
      );
      setItems(r.data?.items ?? []);
      setTotal(r.data?.total ?? 0);
    } catch { /* api 层已 toast */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (checked && isPlatformAdmin) void loadList(page);
  }, [checked, isPlatformAdmin, page, loadList]);

  if (checked && !isPlatformAdmin) return <Navigate to="/" replace />;
  if (!checked) return <div className="p-6 text-sm text-gray-400">校验平台权限中…</div>;

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.company.trim()) { toast.error("公司名不能为空"); return; }
    if (!PHONE_RE.test(form.phone.trim())) { toast.error("老板手机号格式不正确"); return; }
    if (!form.name.trim()) { toast.error("老板姓名不能为空"); return; }
    if (form.licenseUrl.trim() && !/^https?:\/\//.test(form.licenseUrl.trim())) { toast.error("营业执照 URL 须以 http(s):// 开头"); return; }
    setSubmitting(true);
    setLastResult(null);
    try {
      const r = await api.post<ProvisionResp>("/platform/tenants", {
        company: form.company.trim(),
        phone: form.phone.trim(),
        name: form.name.trim(),
        credit: form.credit.trim() || undefined,
        legal: form.legal.trim() || undefined,
        licenseUrl: form.licenseUrl.trim() || undefined,
        plan: form.plan,
      });
      if (r.data) {
        setLastResult(r.data);
        toast.success(`已开通「${r.data.tenant.name}」`);
        setForm({ ...emptyForm });
        setPage(1);
        void loadList(1);
      }
    } catch (e) {
      // ALREADY_PROVISIONED / PHONE_TAKEN 等业务错 api 层已 toast(message 来自后端)
      if (!(e instanceof ApiError)) toast.error("开通失败, 请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-gray-900">平台管理 · 客户开通</h1>
        <p className="text-xs text-gray-400 mt-0.5">签约后在此开通客户(替代服务器 CLI)。老板随后用手机号验证码登录, 无需密码。</p>
      </div>

      {/* 开通表单 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-900 mb-4">开通新客户</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-xs text-gray-500">
            公司名 <span className="text-rose-500">*</span>
            <input value={form.company} onChange={set("company")} placeholder="如: 顺仕美途"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            老板手机号 <span className="text-rose-500">*</span>
            <input value={form.phone} onChange={set("phone")} placeholder="13800138000" maxLength={11}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            老板姓名 <span className="text-rose-500">*</span>
            <input value={form.name} onChange={set("name")} placeholder="如: 韩老板"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            统一社会信用代码(选填, 填了即标记已认证)
            <input value={form.credit} onChange={set("credit")} placeholder="91110108MA01XXXX2B"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            法人代表(选填)
            <input value={form.legal} onChange={set("legal")}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            营业执照图 URL(选填)
            <input value={form.licenseUrl} onChange={set("licenseUrl")} placeholder="https://…"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-indigo-400 outline-none" />
          </label>
          <label className="text-xs text-gray-500">
            套餐
            <select value={form.plan} onChange={set("plan")}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 bg-white focus:border-indigo-400 outline-none">
              <option value="trial">trial · 试用(1运营+1销售)</option>
              <option value="basic">basic · 基础(2+2)</option>
              <option value="pro">pro · 专业(5+5)</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => void submit()} disabled={submitting}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {submitting ? "开通中…" : "开通客户"}
          </button>
          <span className="text-xs text-gray-400">开通成功会尝试给老板发欢迎短信; 短信未配置时请口头通知客户。</span>
        </div>

        {lastResult && (
          <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${lastResult.smsSent ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
            <div className="font-medium">✅ 「{lastResult.tenant.name}」已开通 — 老板 {lastResult.owner.name}({lastResult.owner.phone}), 套餐 {PLAN_LABEL[lastResult.tenant.plan] ?? lastResult.tenant.plan}</div>
            <div className="mt-1 text-xs">{lastResult.smsSent ? "📩 " : "⚠️ "}{lastResult.smsNote}</div>
          </div>
        )}
      </div>

      {/* 客户列表 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">客户列表 <span className="text-gray-400 font-normal">共 {total} 家</span></h2>
          <button onClick={() => void loadList(page)} className="text-xs text-indigo-600 hover:text-indigo-700">刷新</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                <th className="py-2 pr-3 font-medium">公司</th>
                <th className="py-2 pr-3 font-medium">老板手机</th>
                <th className="py-2 pr-3 font-medium">套餐</th>
                <th className="py-2 pr-3 font-medium">状态</th>
                <th className="py-2 pr-3 font-medium">认证</th>
                <th className="py-2 pr-3 font-medium">成员数</th>
                <th className="py-2 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-gray-400 text-xs">加载中…</td></tr>
              )}
              {!loading && items.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-gray-400 text-xs">暂无客户</td></tr>
              )}
              {items.map((t) => (
                <tr key={t.id} className="border-b border-gray-50 hover:bg-gray-50/60">
                  <td className="py-2.5 pr-3 text-gray-900 font-medium">{t.name}</td>
                  <td className="py-2.5 pr-3 text-gray-600">{t.ownerPhone ?? "—"}</td>
                  <td className="py-2.5 pr-3"><span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-xs">{PLAN_LABEL[t.plan] ?? t.plan}</span></td>
                  <td className="py-2.5 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${t.status === "active" ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
                      {t.status === "active" ? "正常" : t.status}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-xs text-gray-500">{t.verifiedStatus === "verified" ? "已认证" : "未认证"}</td>
                  <td className="py-2.5 pr-3 text-gray-600">{t.memberCount}</td>
                  <td className="py-2.5 text-xs text-gray-500">{new Date(t.createdAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
              className="px-2 py-1 rounded border border-gray-200 text-gray-600 disabled:opacity-40">上一页</button>
            <span className="text-gray-400">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 rounded border border-gray-200 text-gray-600 disabled:opacity-40">下一页</button>
          </div>
        )}
      </div>
    </div>
  );
}
