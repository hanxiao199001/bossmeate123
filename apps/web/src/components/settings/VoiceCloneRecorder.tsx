/**
 * 6-26 自助声音克隆: 账号卡片里点"克隆声音" → 浏览器录音(读一段给定文字)→ 上传 → 百炼建音色。
 * 7-10 音色库改造: 克隆成功后存进音色库(voice_catalog, 可起名字), 不再直接覆盖账号绑定 ——
 *   录多条互不覆盖; 到账号行的"音色"下拉里选用, 生成弹窗里也能单次临时换。
 *   后端 POST /accounts/:id/clone-voice(webm→wav→百炼→入库)。
 */
import { useRef, useState } from "react";
import { api } from "../../utils/api";

const SCRIPT =
  "大家好，今天给大家推荐一本适合硕博毕业的SCI期刊。这本刊审稿速度快，录用率友好，对国人作者也比较友好。如果你正在为投稿发愁，赶着毕业或者评职称，这本刊值得重点考虑，具体的投稿建议我在视频里给你详细讲。";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export default function VoiceCloneRecorder({ accountId, cloned, onSaved }: { accountId: string; cloned?: boolean; onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [msg, setMsg] = useState("");
  const [preview, setPreview] = useState("");
  const [voiceName, setVoiceName] = useState(""); // 7-10 入库名字(空=后端默认"账号名的声音 M-D")
  const mrRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setMsg(""); setPreview("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void upload(); };
      mr.start();
      mrRef.current = mr; setRecording(true); setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      setMsg("无法录音，请在浏览器里允许麦克风权限");
    }
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    mrRef.current?.stop();
    setRecording(false);
  }

  async function upload() {
    if (elapsed < 8) { setMsg("录音太短，请读完整段(15 秒以上)再停"); return; }
    setBusy(true); setMsg("上传并克隆中(约 10-20 秒)…");
    try {
      const blob = new Blob(chunksRef.current);
      const dataUrl = await blobToDataUrl(blob);
      const r = await api.post<{ voice: string; previewUrl?: string; catalogId?: string; name?: string }>(
        `/accounts/${accountId}/clone-voice`,
        { audioBase64: dataUrl, ...(voiceName.trim() ? { name: voiceName.trim() } : {}) },
      );
      // 7-10 音色库: 克隆已入库(不自动绑定), 提示去下拉里选
      setMsg(`✅ 已克隆入库「${r?.data?.name || voiceName.trim() || "我的声音"}」。到账号行的"音色"下拉里选它即可使用。`);
      if (r?.data?.previewUrl) setPreview(r.data.previewUrl);
      onSaved?.(); // 刷新音色库下拉
    } catch (e) {
      setMsg("克隆失败：" + ((e as Error)?.message || "请重试，确保读满 15 秒、环境安静"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        title="录一段自己的声音，克隆后存进音色库，账号在音色下拉里选用"
        className={`text-xs px-2 py-0.5 rounded-full border cursor-pointer ${cloned ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"}`}
      >
        🎤 录音入库 ▾
      </button>

      {open && (
        <div className="mt-2 p-3 rounded-lg border border-gray-200 bg-white shadow-sm w-[320px] text-left">
          <div className="text-xs font-medium text-gray-700 mb-1">录一段你的声音(读下面这段，约 30 秒，环境安静)</div>
          <div className="text-xs text-gray-500 leading-relaxed mb-2 max-h-24 overflow-auto bg-gray-50 rounded p-2">{SCRIPT}</div>

          <input
            type="text"
            value={voiceName}
            onChange={(e) => setVoiceName(e.target.value)}
            maxLength={60}
            placeholder='音色名字(可空, 默认"账号名的声音+日期")'
            disabled={busy || recording}
            className="w-full mb-2 px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400 disabled:bg-gray-50"
          />

          <div className="flex items-center gap-2">
            {!recording ? (
              <button onClick={() => void start()} disabled={busy}
                className="text-xs px-3 py-1 rounded bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">● 开始录音</button>
            ) : (
              <button onClick={stop}
                className="text-xs px-3 py-1 rounded bg-gray-800 text-white hover:bg-black">■ 停止({elapsed}s)</button>
            )}
            {recording && <span className="text-xs text-rose-600 animate-pulse">录音中…</span>}
          </div>

          {msg && <div className="text-xs mt-2 text-gray-700">{msg}</div>}
          {preview && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">试听(你的克隆声音):</div>
              <audio controls src={preview} className="w-full h-8" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
