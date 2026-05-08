/**
 * 联系方式 admin form（Day 2 PR A）。
 *
 * SettingsPage 第 5 section — 老板自维护 tenant.contact_meta：
 *   contactName / wechatId / workingHours / qrCodeUrl / email / phone
 *
 * v1：
 *   - qrCodeUrl 走 URL 输入框（v2 做 COS 上传）
 *   - 整段替换语义（一次保存全部字段）
 *   - 顶部 "所见即所得" 预览块，与 shunshi-style 区块 21 渲染对齐
 *
 * 后端：GET /api/v1/tenant/info（含 contactMeta）+ PATCH /api/v1/tenant/contact
 */

import { useEffect, useState } from "react";
import { api, ApiError } from "../utils/api";
import { toast } from "./Toast";

interface ContactMeta {
  contactName: string;
  wechatId?: string | null;
  workingHours?: string | null;
  qrCodeUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  lastUpdatedAt?: string;
}

interface TenantInfo {
  id: string;
  name: string;
  contactMeta: ContactMeta | null;
}

const INITIAL: ContactMeta = {
  contactName: "",
  wechatId: "",
  workingHours: "",
  qrCodeUrl: "",
  email: "",
  phone: "",
};

export default function ContactMetaSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ContactMeta>(INITIAL);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<TenantInfo>("/tenant/info")
      .then((res) => {
        if (res.data?.contactMeta) {
          setForm({ ...INITIAL, ...res.data.contactMeta });
        }
      })
      .catch(() => {
        /* api.ts 已 toast；表单保持空白等老板首次填 */
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setError(null);
    if (!form.contactName.trim()) {
      setError("contactName 必填");
      return;
    }
    setSaving(true);
    try {
      // 空字符串字段提交时转 undefined（zod optional 允许；避免空字符串 lastUpdatedAt 等空值噪音）
      const payload: ContactMeta = { contactName: form.contactName.trim() };
      (["wechatId", "workingHours", "qrCodeUrl", "email", "phone"] as const).forEach((k) => {
        const v = form[k];
        if (typeof v === "string" && v.trim()) (payload as any)[k] = v.trim();
      });
      const res = await api.patch<{ contactMeta: ContactMeta }>("/tenant/contact", { contactMeta: payload });
      if (res.data?.contactMeta) {
        setForm({ ...INITIAL, ...res.data.contactMeta });
      }
      toast.success("联系方式已保存");
    } catch (err) {
      if (err instanceof ApiError && err.code === "VALIDATION_ERROR") {
        setError("字段格式不正确（检查 email / qrCodeUrl URL 格式）");
      } else if (!(err instanceof ApiError)) {
        toast.error("保存失败，请稍后重试");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-xl">📇</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">联系方式</h2>
          <p className="text-sm text-gray-500">公众号底部「📝 联系方式」区块 + 公众号文章二维码引流的展示源</p>
        </div>
      </div>

      {/* 预览（所见即所得） */}
      {form.contactName && (
        <Preview meta={form} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="联系人名称（必填）" value={form.contactName} onChange={(v) => setForm({ ...form, contactName: v })} placeholder="BossMate 期刊小助手" />
        <Field label="微信号" value={form.wechatId ?? ""} onChange={(v) => setForm({ ...form, wechatId: v })} placeholder="bossmate_journal" />
        <Field label="工作时间" value={form.workingHours ?? ""} onChange={(v) => setForm({ ...form, workingHours: v })} placeholder="工作日 9:00-18:00 答疑" />
        <Field label="二维码 URL（v1：先上传 COS 再粘贴 URL）" value={form.qrCodeUrl ?? ""} onChange={(v) => setForm({ ...form, qrCodeUrl: v })} placeholder="https://cos.boss-mates.com/qr.png" />
        <Field label="邮箱" value={form.email ?? ""} onChange={(v) => setForm({ ...form, email: v })} placeholder="ops@boss-mates.com" />
        <Field label="电话" value={form.phone ?? ""} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+86 138-xxxx-xxxx" />
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {form.lastUpdatedAt && (
        <p className="mt-3 text-xs text-gray-400">上次更新：{new Date(form.lastUpdatedAt).toLocaleString("zh-CN")}</p>
      )}

      <div className="mt-4 flex justify-end">
        <button
          onClick={handleSave}
          disabled={loading || saving || !form.contactName.trim()}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            loading || saving || !form.contactName.trim()
              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </section>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
    </label>
  );
}

function Preview({ meta }: { meta: ContactMeta }) {
  return (
    <div className="mb-5 p-4 bg-gray-50 rounded-lg border border-gray-200">
      <p className="text-xs text-gray-500 mb-2">公众号渲染预览（区块 21）：</p>
      <div className="bg-white rounded-md p-3 text-center">
        <p className="text-sm font-bold text-gray-900">{meta.contactName}</p>
        {meta.qrCodeUrl && (
          <img src={meta.qrCodeUrl} alt="二维码" className="mx-auto mt-2 w-24 h-24 rounded object-cover" />
        )}
        {meta.workingHours && <p className="text-xs text-gray-500 mt-1">{meta.workingHours}</p>}
        {meta.wechatId && <p className="text-xs text-gray-700 mt-1"><strong>微信：</strong>{meta.wechatId}</p>}
        {meta.email && <p className="text-xs text-gray-700 mt-1"><strong>邮箱：</strong>{meta.email}</p>}
        {meta.phone && <p className="text-xs text-gray-700 mt-1"><strong>电话：</strong>{meta.phone}</p>}
      </div>
    </div>
  );
}
