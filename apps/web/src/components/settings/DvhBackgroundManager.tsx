/**
 * 7-29 数字人视频背景图库 — 管理员维护, 全租户共享(和数字人形象库放一起)。
 *
 * 老板拿到一批背景图后: 拖进下面的框 → 系统自动校验尺寸 + 内容审核 → 通过的直接入库,
 *   之后运营在「生成视频」弹窗里就能选到。
 *
 * ⚠️ 图必须是 9:16 竖版(如 1080×1920) 或 16:9 横版(如 1920×1080), 短边 ≥720。
 *   比例不对会被拒 —— 不是找茬: 数字人合成按秒扣费(0.165 元/秒), 比例错了阿里云会拉伸/裁切
 *   甚至直接忽略, 出片才发现钱已经花了。宁可上传时重裁一次。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../utils/api";

export interface DvhBackground {
  id: string;
  name: string;
  url: string;
  thumbUrl?: string;
  orientation: "portrait" | "landscape";
  width: number;
  height: number;
}

export default function DvhBackgroundManager() {
  const [list, setList] = useState<DvhBackground[]>([]);
  const [uploading, setUploading] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.get<{ backgrounds?: DvhBackground[] }>("/admin/dvh-backgrounds")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((r) => setList((((r.data as any)?.backgrounds ?? (r.data as any)?.data?.backgrounds ?? []) as DvhBackground[])))
      .catch(() => { /* 拉不到就空列表 */ });
  }, []);
  useEffect(() => { load(); }, [load]);

  const upload = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    setUploading(true); setMsg(null);
    try {
      const fd = new FormData();
      for (const f of arr) fd.append("images", f);
      const r = await api.upload<{ backgrounds?: DvhBackground[]; added?: number }>("/admin/dvh-backgrounds/upload", fd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = ((r.data as any)?.data ?? r.data) as { backgrounds?: DvhBackground[]; added?: number };
      setList(d?.backgrounds ?? []);
      setMsg({ ok: true, text: `已入库 ${d?.added ?? arr.length} 张背景图` });
    } catch (e) {
      // 后端把"为什么不合格"写在 message 里(比如"需要 9:16 竖版, 你传的是 4:3"), 原样显示别吞
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = e as any;
      setMsg({ ok: false, text: err?.message || err?.response?.data?.message || "上传失败" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  const rename = async (id: string, name: string) => {
    const next = list.map((b) => (b.id === id ? { ...b, name } : b));
    setList(next);
    setSavingName(true);
    try {
      await api.patch("/admin/dvh-backgrounds", { backgrounds: next });
    } catch {
      setMsg({ ok: false, text: "改名保存失败" });
    } finally { setSavingName(false); }
  };

  const remove = async (b: DvhBackground) => {
    if (!confirm(`确认删除背景图「${b.name}」? 已经用它生成过的视频不受影响。`)) return;
    try {
      const r = await api.delete<{ backgrounds?: DvhBackground[] }>(`/admin/dvh-backgrounds/${b.id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setList((((r.data as any)?.backgrounds ?? (r.data as any)?.data?.backgrounds ?? []) as DvhBackground[]));
      setMsg({ ok: true, text: `已删除「${b.name}」` });
    } catch {
      setMsg({ ok: false, text: "删除失败" });
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-lg bg-sky-100 flex items-center justify-center text-xl">🖼️</div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">数字人背景图库</h2>
          <p className="text-sm text-gray-500">
            传进来的图,运营在「生成视频」弹窗里就能直接选。不选背景 = 阿里云默认纯黑底。
          </p>
        </div>
      </div>

      {/* 规格说明 — 放在上传框之前, 让人先看到再传 */}
      <div className="mt-3 text-xs text-gray-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
        <b>图片规格(不符合会被拒绝上传)</b>:
        <br />· 竖版短视频(抖音/视频号)用 <b>9:16</b>,推荐 <b>1080×1920</b>
        <br />· 横版用 <b>16:9</b>,推荐 <b>1920×1080</b>
        <br />· 短边至少 720px;格式 JPG / PNG / WebP;单张 ≤10MB
        <br />· 比例允许 ±5% 误差,差得多了必须先裁图 —— 数字人合成按秒收费,比例错了阿里云会拉伸或直接忽略,出片才发现钱就白花了
        <br />· 建议画面中下部留空(数字人站在那儿),别把重点内容放在会被人物挡住的位置
      </div>

      {/* 上传区 */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
        className={`mt-3 border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          dragging ? "border-sky-500 bg-sky-50" : "border-gray-300 hover:border-sky-400 hover:bg-gray-50"
        } ${uploading ? "opacity-60 pointer-events-none" : ""}`}
      >
        <div className="text-3xl mb-1">{uploading ? "⏳" : "⬆️"}</div>
        <div className="text-sm font-medium text-gray-700">
          {uploading ? "上传中,正在校验尺寸和内容审核…" : "把背景图拖到这里,或点击选择文件"}
        </div>
        <div className="text-xs text-gray-400 mt-1">可一次选多张</div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && void upload(e.target.files)}
        />
      </div>

      {msg && (
        <div className={`mt-3 text-sm px-3 py-2 rounded-lg border ${
          msg.ok ? "text-green-700 bg-green-50 border-green-200" : "text-red-700 bg-red-50 border-red-200"
        }`}>{msg.text}</div>
      )}

      {/* 图库列表 */}
      <div className="mt-4">
        <div className="text-sm font-semibold text-gray-700 mb-2">
          当前背景图({list.length}){savingName && <span className="ml-2 text-xs text-gray-400">保存中…</span>}
        </div>
        {list.length === 0 ? (
          <div className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-lg px-4 py-6 text-center">
            还没有背景图。传几张上来,运营生成视频时就能选了。
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {list.map((b) => (
              <div key={b.id} className="border border-gray-200 rounded-lg p-2">
                <img
                  src={b.thumbUrl || b.url}
                  alt={b.name}
                  className={`w-full rounded bg-gray-50 object-cover ${b.orientation === "portrait" ? "h-36" : "h-20"}`}
                  loading="lazy"
                />
                <input
                  value={b.name}
                  onChange={(e) => setList((prev) => prev.map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)))}
                  onBlur={(e) => void rename(b.id, e.target.value.trim() || "未命名背景")}
                  className="mt-1 w-full text-xs border border-transparent hover:border-gray-300 focus:border-sky-400 rounded px-1 py-0.5 outline-none"
                  title="点这里改名字"
                />
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[10px] text-gray-400">
                    {b.orientation === "portrait" ? "竖版" : "横版"} {b.width}×{b.height}
                  </span>
                  <button onClick={() => void remove(b)} className="text-[10px] text-red-500 hover:text-red-600">删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
