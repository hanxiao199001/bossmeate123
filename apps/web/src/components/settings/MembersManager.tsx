/**
 * 6-20 Phase2 成员管理: 老板/管理员在设置页邀请员工(手机号)、改角色、停用。
 *   仅 members.manage(owner/admin)可见; 后端同样强制鉴权, 这里只是界面。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../utils/api";
import { useAuthStore } from "../../hooks/useAuthStore";

interface Member {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt?: string | null;
}
interface Invite {
  id: string;
  phone: string;
  role: string;
  status: string;
  expiresAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "老板",
  admin: "老板", // 6-20 老韩: 管理员并入"老板"显示(看所有内容数据+预警)
  content_operator: "运营",
  sales: "销售",
  // 以下后续再开放
  sales_director: "销售总监",
  finance_viewer: "财务查看",
  member: "成员(旧)",
};
// 6-20: 邀请/改角色只开放 运营 + 销售 两种, 其他后续再加
const ASSIGNABLE = ["content_operator", "sales"];

export default function MembersManager() {
  const myRole = useAuthStore((s) => s.user?.role);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteRole, setInviteRole] = useState("content_operator");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.get<Member[]>("/tenant/members").then((r) => setMembers((r.data as any) ?? [])).catch(() => {});
    api.get<Invite[]>("/tenant/invites").then((r) => setInvites((r.data as any) ?? [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const invite = async () => {
    setMsg(null);
    if (!/^1[3-9]\d{9}$/.test(invitePhone)) { setMsg({ ok: false, text: "请输入正确的手机号" }); return; }
    try {
      await api.post("/tenant/invites", { phone: invitePhone, role: inviteRole });
      setMsg({ ok: true, text: `已邀请 ${invitePhone}，对方用手机验证码登录即自动加入` });
      setInvitePhone("");
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "邀请失败" });
    }
  };

  const changeRole = async (m: Member, role: string) => {
    try { await api.patch(`/tenant/members/${m.id}`, { role }); load(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message || "改角色失败" }); }
  };
  const toggleActive = async (m: Member) => {
    try { await api.patch(`/tenant/members/${m.id}`, { isActive: !m.isActive }); load(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message || "操作失败" }); }
  };

  const roleOptions = ASSIGNABLE;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center text-xl">👥</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">成员管理</h2>
          <p className="text-sm text-gray-500">邀请运营/销售加入公司、分配角色。员工用手机号 + 验证码登录即自动入职，只看到对应模块。</p>
        </div>
      </div>

      {/* 邀请 */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-gray-200 p-3">
        <input value={invitePhone} onChange={(e) => setInvitePhone(e.target.value)} placeholder="员工手机号"
          className="text-sm border border-gray-300 rounded px-3 py-1.5 w-40" />
        <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
          className="text-sm border border-gray-300 rounded px-2 py-1.5">
          {roleOptions.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button onClick={() => void invite()}
          className="text-sm px-4 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">邀请</button>
        {msg && <span className={`text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>

      {/* 待接受邀请 */}
      {invites.length > 0 && (
        <div className="mt-3">
          <div className="text-xs font-semibold text-gray-500 mb-1">待接受邀请({invites.length})</div>
          <div className="flex flex-wrap gap-2">
            {invites.map((i) => (
              <span key={i.id} className="text-xs px-2 py-1 rounded-full border border-amber-200 bg-amber-50 text-amber-700">
                {i.phone} · {ROLE_LABELS[i.role] ?? i.role} · 待登录
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 成员列表 */}
      <div className="mt-4">
        <div className="text-sm font-semibold text-gray-700 mb-2">公司成员({members.length})</div>
        <div className="space-y-2">
          {members.map((m) => {
            const isTop = m.role === "owner" || m.role === "admin"; // 6-20 老板(owner/admin)统一视为顶层, 徽章展示
            const canEdit = !isTop; // 老板行不在此改角色
            return (
              <div key={m.id} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm ${m.isActive ? "border-gray-100" : "border-gray-100 bg-gray-50 opacity-60"}`}>
                <span className="font-medium text-gray-800 truncate max-w-[120px]">{m.name}</span>
                <span className="text-xs text-gray-400">{m.phone || m.email || "—"}</span>
                <span className="ml-auto" />
                {isTop ? (
                  <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">老板</span>
                ) : (
                  <select value={m.role} disabled={!canEdit} onChange={(e) => void changeRole(m, e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-1 disabled:opacity-50">
                    {[m.role, ...roleOptions.filter((r) => r !== m.role)].map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
                  </select>
                )}
                {!isTop && (
                  <button onClick={() => void toggleActive(m)}
                    className={`text-xs px-2 py-1 rounded ${m.isActive ? "text-rose-600 hover:bg-rose-50" : "text-green-600 hover:bg-green-50"}`}>
                    {m.isActive ? "停用" : "启用"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
