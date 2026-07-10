/**
 * 7-10 音色库管理(薄): 列表(名字/类型/voice_id 尾号/创建时间/试听) + 改名 + 删除。
 *   数据源 GET /voice-catalog; 改名 PATCH /voice-catalog/:id; 删除 DELETE /voice-catalog/:id(adminOnly)。
 *   预置音色是全局共享行(shared=true), 只读不可改删。删除有账号绑定时后端 409, 提示先去账号页换音色。
 *   录音入库入口在"账号管理"每个账号行的 🎤 按钮(录完这里自动多一条)。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../utils/api";

interface VoiceRow {
  id: string;
  name: string;
  voiceId: string;
  voiceTail: string;
  type: string; // cloned | preset
  sampleUrl?: string | null;
  shared?: boolean;
  createdAt?: string;
}

export default function VoiceCatalogManager() {
  const [rows, setRows] = useState<VoiceRow[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.get<{ voices?: VoiceRow[] }>("/voice-catalog")
      .then((r) => setRows(((r.data as any)?.voices ?? []) as VoiceRow[]))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const rename = async (id: string) => {
    const name = nameDraft.trim();
    if (!name) { setMsg({ ok: false, text: "名字不能为空" }); return; }
    setBusyId(id); setMsg(null);
    try {
      await api.patch(`/voice-catalog/${id}`, { name });
      setEditId(null);
      setMsg({ ok: true, text: "已改名" });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: "改名失败: " + (e?.message || "未知") });
    } finally { setBusyId(null); }
  };

  const remove = async (row: VoiceRow) => {
    if (!confirm(`确认删除音色「${row.name}」? 已绑定该音色的账号会被拦下并提示。`)) return;
    setBusyId(row.id); setMsg(null);
    try {
      await api.delete(`/voice-catalog/${row.id}`);
      setMsg({ ok: true, text: `已删除「${row.name}」` });
      load();
    } catch (e: any) {
      // 409 VOICE_IN_USE: 后端带账号名提示
      setMsg({ ok: false, text: e?.message || "删除失败" });
    } finally { setBusyId(null); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center text-xl">{"🎙️"}</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">音色库</h2>
          <p className="text-sm text-gray-500">
            克隆音+预置音色成库 — 账号在「账号管理」的音色下拉里挑, 生成视频弹窗可单次临时换; 录新音色走账号行的 🎤 录音入库
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-gray-500 bg-gray-50 border border-dashed border-gray-200 rounded-lg p-4">
          还没有音色。到「账号管理」任一账号行点 🎤 录音入库, 或等预置音色种子迁移生效。
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {rows.map((v) => (
            <div key={v.id} className="py-2.5 flex items-center gap-3 text-sm">
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${v.type === "cloned" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-gray-100 text-gray-600 border border-gray-200"}`}>
                {v.type === "cloned" ? "克隆音" : "预置"}
              </span>
              {editId === v.id ? (
                <span className="flex items-center gap-1.5 flex-1 min-w-0">
                  <input
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    maxLength={60}
                    className="flex-1 min-w-0 px-2 py-1 border border-blue-300 rounded text-sm focus:outline-none"
                    autoFocus
                  />
                  <button onClick={() => void rename(v.id)} disabled={busyId === v.id}
                    className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">存</button>
                  <button onClick={() => setEditId(null)} className="text-xs px-2 py-1 rounded text-gray-500 hover:text-gray-700">取消</button>
                </span>
              ) : (
                <span className="flex-1 min-w-0 truncate font-medium text-gray-800" title={v.name}>{v.name}</span>
              )}
              <span className="text-xs text-gray-400 font-mono shrink-0" title={`voice_id 尾号`}>{v.voiceTail}</span>
              {v.createdAt && (
                <span className="text-xs text-gray-400 shrink-0">{new Date(v.createdAt).toLocaleDateString()}</span>
              )}
              {v.sampleUrl && <audio controls src={v.sampleUrl} className="h-7 w-40 shrink-0" preload="none" />}
              {!v.shared && editId !== v.id && (
                <>
                  <button
                    onClick={() => { setEditId(v.id); setNameDraft(v.name); setMsg(null); }}
                    className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 shrink-0"
                  >改名</button>
                  <button
                    onClick={() => void remove(v)}
                    disabled={busyId === v.id}
                    className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 shrink-0"
                  >删除</button>
                </>
              )}
              {v.shared && <span className="text-xs text-gray-400 shrink-0">全局共享</span>}
            </div>
          ))}
        </div>
      )}

      {msg && <div className={`mt-3 text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</div>}
    </div>
  );
}
