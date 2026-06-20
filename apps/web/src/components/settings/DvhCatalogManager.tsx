/**
 * 6-19 数字人形象库管理: 从阿里云拉取可用形象 → 加入目录(配名字+音色) → 保存。
 *   目的: 多备几个形象(尤其男形象), 给不同账号绑不同形象, 防查重封号。
 *   默认 4 个内置形象不可删; 自定义形象存 SYSTEM config.dvhCatalog(PATCH /admin/dvh-catalog)。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../utils/api";

const DEFAULT_KEYS = ["A_academic", "B_marketing", "C_popular", "E_industry"];
const VOICE_SUGGESTIONS = ["aixia", "maoxiaomei", "aiyuan"]; // 已用过的阿里云音色, 也可填其它

interface CatalogEntry {
  key: string;
  avatarCode: string;
  avatarLabel: string;
  voiceCode: string;
  voiceLabel: string;
  templateLabel: string;
  backgroundUrl?: string;
}
interface CloudAvatar {
  code: string;
  name: string;
  preview?: string;
  avatarType?: string;
  modelType?: string;
  makeStatus?: string;
}

export default function DvhCatalogManager() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [cloud, setCloud] = useState<CloudAvatar[] | null>(null);
  const [pulling, setPulling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCatalog = useCallback(() => {
    api.get<{ catalog?: CatalogEntry[] }>("/admin/dvh-catalog")
      .then((r) => setCatalog(((r.data as any)?.catalog ?? (r.data as any)?.data?.catalog ?? []) as CatalogEntry[]))
      .catch(() => {});
  }, []);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  const extras = catalog.filter((c) => !DEFAULT_KEYS.includes(c.key));

  const pull = async () => {
    setPulling(true); setMsg(null);
    try {
      const r = await api.get<{ avatars?: CloudAvatar[] }>("/admin/dvh-avatars");
      setCloud(((r.data as any)?.avatars ?? (r.data as any)?.data?.avatars ?? []) as CloudAvatar[]);
    } catch (e: any) {
      setMsg({ ok: false, text: "拉取失败: " + (e?.response?.data?.message || e?.message || "未知") });
    } finally { setPulling(false); }
  };

  const addToCatalog = (a: CloudAvatar) => {
    if (catalog.some((c) => c.avatarCode === a.code)) { setMsg({ ok: false, text: "该形象已在目录里" }); return; }
    const key = (a.name || a.code).slice(0, 40).replace(/\s+/g, "_") + "_" + a.code.slice(-4);
    setCatalog((prev) => [...prev, {
      key,
      avatarCode: a.code,
      avatarLabel: a.name || a.code,
      voiceCode: "aixia",
      voiceLabel: "艾夏-亲和女声",
      templateLabel: a.name || a.code,
    }]);
    setMsg({ ok: true, text: `已加入「${a.name || a.code}」, 记得选音色后点保存` });
  };

  const updateEntry = (key: string, patch: Partial<CatalogEntry>) =>
    setCatalog((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const removeEntry = (key: string) => setCatalog((prev) => prev.filter((c) => c.key !== key));

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      await api.patch("/admin/dvh-catalog", { entries: extras });
      setMsg({ ok: true, text: `已保存 ${extras.length} 个自定义形象` });
      loadCatalog();
    } catch (e: any) {
      setMsg({ ok: false, text: "保存失败: " + (e?.response?.data?.message || e?.message || "未知") });
    } finally { setSaving(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-lg bg-fuchsia-100 flex items-center justify-center text-xl">🧑‍🎤</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">数字人形象库</h2>
          <p className="text-sm text-gray-500">多备几个形象(尤其男形象),给不同账号绑不同形象,防查重封号。从阿里云拉取后加入目录、配音色、保存。</p>
        </div>
      </div>

      {/* 当前目录 */}
      <div className="mt-4">
        <div className="text-sm font-semibold text-gray-700 mb-2">当前形象目录({catalog.length})</div>
        <div className="space-y-2">
          {catalog.map((c) => {
            const isDefault = DEFAULT_KEYS.includes(c.key);
            return (
              <div key={c.key} className="flex items-center gap-2 border border-gray-100 rounded-lg px-3 py-2 text-sm">
                <span className="font-medium text-gray-800 truncate max-w-[180px]" title={c.avatarCode}>{c.avatarLabel}</span>
                {isDefault && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">内置</span>}
                <span className="text-gray-400 ml-auto text-xs">音色</span>
                {isDefault ? (
                  <span className="text-xs text-gray-600">{c.voiceLabel}</span>
                ) : (
                  <input
                    list="dvh-voice-suggestions"
                    value={c.voiceCode}
                    onChange={(e) => updateEntry(c.key, { voiceCode: e.target.value, voiceLabel: e.target.value })}
                    className="text-xs border border-gray-300 rounded px-2 py-0.5 w-28"
                    placeholder="阿里云音色code"
                  />
                )}
                {!isDefault && (
                  <button onClick={() => removeEntry(c.key)} className="text-xs text-red-500 hover:text-red-600">删除</button>
                )}
              </div>
            );
          })}
        </div>
        <datalist id="dvh-voice-suggestions">
          {VOICE_SUGGESTIONS.map((v) => <option key={v} value={v} />)}
        </datalist>
      </div>

      {/* 操作区 */}
      <div className="flex items-center gap-3 mt-4">
        <button onClick={() => void pull()} disabled={pulling}
          className="px-4 py-2 text-sm rounded-lg border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50 disabled:opacity-50">
          {pulling ? "拉取中…" : "从阿里云拉取形象"}
        </button>
        <button onClick={() => void save()} disabled={saving}
          className="px-5 py-2 text-sm rounded-lg bg-fuchsia-600 text-white font-medium hover:bg-fuchsia-700 disabled:opacity-50">
          {saving ? "保存中…" : "保存目录"}
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-green-600" : "text-red-600"}`}>{msg.text}</span>}
      </div>

      {/* 阿里云拉取结果 */}
      {cloud && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <div className="text-sm font-semibold text-gray-700 mb-2">阿里云可用形象({cloud.length}) — 点「加入」放进目录</div>
          {cloud.length === 0 ? (
            <div className="text-sm text-gray-400">没拉到形象。请确认阿里云 DVH 账号下已有可用形象、且服务端凭证(ALIYUN_ACCESS_KEY)正确。</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {cloud.map((a) => {
                const added = catalog.some((c) => c.avatarCode === a.code);
                return (
                  <div key={a.code} className="border border-gray-200 rounded-lg p-2 text-center">
                    {a.preview ? (
                      <img src={a.preview} alt={a.name} className="w-full h-28 object-cover rounded mb-1 bg-gray-50" />
                    ) : (
                      <div className="w-full h-28 rounded mb-1 bg-gray-100 flex items-center justify-center text-3xl">🧑‍🎤</div>
                    )}
                    <div className="text-xs font-medium text-gray-800 truncate" title={a.code}>{a.name || a.code}</div>
                    <div className="text-[10px] text-gray-400 truncate">{a.modelType || ""} {a.makeStatus || ""}</div>
                    <button
                      onClick={() => addToCatalog(a)}
                      disabled={added}
                      className={`mt-1 w-full text-xs py-1 rounded ${added ? "bg-gray-100 text-gray-400" : "bg-fuchsia-50 text-fuchsia-700 hover:bg-fuchsia-100"}`}
                    >{added ? "已在目录" : "加入"}</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
