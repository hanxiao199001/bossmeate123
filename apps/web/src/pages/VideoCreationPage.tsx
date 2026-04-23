/**
 * 图片转视频 — 创作页面
 *
 * 三步向导：上传图片 → 配置参数 → 合成 & 预览
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../hooks/useAuthStore";
import { api } from "../utils/api";

// ===== 类型 =====
interface UploadedImage {
  remotePath: string;
  width: number;
  height: number;
  sizeBytes: number;
  previewUrl: string; // 本地 blob URL
  title: string;
  durationMs: number;
}

interface BgmOption {
  id: string;
  name: string;
  description: string;
}

type Step = "upload" | "config" | "compose";

// ===== 主组件 =====
export default function VideoCreationPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [step, setStep] = useState<Step>("upload");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);

  // 配置
  const [bgmId, setBgmId] = useState<string>("");
  const [resolution, setResolution] = useState<"1080x1920" | "1920x1080">("1080x1920");
  const [transition, setTransition] = useState<"fade" | "dissolve" | "none">("fade");
  const [title, setTitle] = useState("我的产品视频");

  // 合成
  const [composing, setComposing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // BGM 列表
  const [bgmList, setBgmList] = useState<BgmOption[]>([]);
  useEffect(() => {
    api.get<BgmOption[]>("/video/bgm-list").then(res => {
      if (res.data) setBgmList(res.data as any);
    }).catch(() => {});
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ===== 上传 =====
  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith("image/")).slice(0, 15 - images.length);
    if (fileArray.length === 0) return;
    setUploading(true);

    try {
      const formData = new FormData();
      const previews: string[] = [];
      for (const f of fileArray) {
        formData.append("images", f);
        previews.push(URL.createObjectURL(f));
      }

      const token = useAuthStore.getState().token;
      const resp = await fetch("/api/v1/video/upload-images", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await resp.json();

      if (!resp.ok) {
        setError(data.message || "上传失败");
        return;
      }

      const newImages: UploadedImage[] = (data.data?.images || []).map((img: any, i: number) => ({
        ...img,
        previewUrl: previews[i] || "",
        title: "",
        durationMs: 4000,
      }));

      setImages(prev => [...prev, ...newImages]);
      setError(null);
    } catch {
      setError("上传失败，请检查网络");
    } finally {
      setUploading(false);
    }
  }, [images.length]);

  const removeImage = (idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
  };

  const updateImage = (idx: number, update: Partial<UploadedImage>) => {
    setImages(prev => prev.map((img, i) => i === idx ? { ...img, ...update } : img));
  };

  // ===== 合成 =====
  const handleCompose = async () => {
    setComposing(true);
    setProgress(0);
    setError(null);
    setResult(null);

    try {
      const res = await api.post<{ jobId: string }>("/video/compose", {
        title,
        images: images.map(img => ({
          remotePath: img.remotePath,
          durationMs: img.durationMs,
          title: img.title || undefined,
        })),
        bgmId: bgmId || undefined,
        resolution,
        transition,
      });

      const jid = res.data?.jobId;
      if (!jid) throw new Error("未返回 jobId");
      setJobId(jid);

      // 轮询进度
      const poll = async () => {
        for (let i = 0; i < 300; i++) { // 最多 10 分钟
          await new Promise(r => setTimeout(r, 2000));
          try {
            const statusRes = await api.get<any>(`/video/status/${jid}`);
            const d = statusRes.data;
            setProgress(d?.progress || 0);
            if (d?.status === "completed") {
              setResult(d.result);
              setComposing(false);
              return;
            }
            if (d?.status === "failed") {
              setError(d.error || "合成失败");
              setComposing(false);
              return;
            }
          } catch { /* continue polling */ }
        }
        setError("合成超时，请在视频列表查看");
        setComposing(false);
      };
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建任务失败");
      setComposing(false);
    }
  };

  // ===== 拖拽 =====
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  };

  const estimatedDuration = images.reduce((s, img) => s + img.durationMs / 1000, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 导航 */}
      <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-blue-600">BossMate</span>
            <span className="text-xs text-gray-400">AI超级员工</span>
          </Link>
          <span className="text-gray-300">|</span>
          <span className="text-sm font-medium text-gray-700">图片转视频</span>
        </div>
        <div className="flex items-center gap-4">
          <Link to="/" className="text-sm text-gray-500 hover:text-blue-600">返回首页</Link>
          <span className="text-sm text-gray-600">{user?.name}</span>
          <button onClick={logout} className="text-sm text-gray-500 hover:text-red-500">退出</button>
        </div>
      </nav>

      <div className="max-w-4xl mx-auto py-8 px-4">
        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-4 mb-8">
          {[
            { key: "upload", label: "上传图片", num: 1 },
            { key: "config", label: "视频配置", num: 2 },
            { key: "compose", label: "合成预览", num: 3 },
          ].map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && <div className="w-8 h-px bg-gray-300" />}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                step === s.key ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500"
              }`}>{s.num}</div>
              <span className={`text-sm ${step === s.key ? "text-blue-600 font-medium" : "text-gray-400"}`}>{s.label}</span>
            </div>
          ))}
        </div>

        {/* Step 1: 上传 */}
        {step === "upload" && (
          <div>
            <div
              className={`border-2 border-dashed rounded-xl p-8 text-center transition ${
                dragOver ? "border-blue-400 bg-blue-50" : "border-gray-300 bg-white"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && handleFiles(e.target.files)}
              />
              <p className="text-lg text-gray-600 mb-2">
                {uploading ? "上传中..." : "拖拽图片到这里，或点击选择"}
              </p>
              <p className="text-sm text-gray-400">支持 JPG/PNG/WebP，单张 ≤ 10MB，最多 15 张</p>
            </div>

            {images.length > 0 && (
              <div className="mt-6">
                <p className="text-sm text-gray-500 mb-3">{images.length} 张图片 · 预计 {estimatedDuration.toFixed(0)} 秒</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                  {images.map((img, i) => (
                    <div key={i} className="relative group">
                      <img src={img.previewUrl} alt="" className="w-full aspect-[3/4] object-cover rounded-lg" />
                      <button
                        onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                        className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition"
                      >✕</button>
                      <input
                        type="text"
                        placeholder="标题(可选)"
                        value={img.title}
                        onChange={(e) => updateImage(i, { title: e.target.value })}
                        className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs px-2 py-1 rounded-b-lg"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setStep("config")}
                disabled={images.length === 0}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:bg-gray-300 hover:bg-blue-700"
              >下一步：视频配置</button>
            </div>
          </div>
        )}

        {/* Step 2: 配置 */}
        {step === "config" && (
          <div className="bg-white rounded-xl p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">视频标题</label>
              <input value={title} onChange={e => setTitle(e.target.value)} className="w-full px-4 py-2 border rounded-lg text-sm" />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">视频方向</label>
                <div className="flex gap-3">
                  {([["1080x1920", "竖版 9:16"], ["1920x1080", "横版 16:9"]] as const).map(([v, l]) => (
                    <button key={v} onClick={() => setResolution(v)}
                      className={`flex-1 py-2 rounded-lg text-sm border ${resolution === v ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"}`}
                    >{l}</button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">转场效果</label>
                <div className="flex gap-3">
                  {([["fade", "淡入淡出"], ["dissolve", "溶解"], ["none", "无"]] as const).map(([v, l]) => (
                    <button key={v} onClick={() => setTransition(v)}
                      className={`flex-1 py-2 rounded-lg text-sm border ${transition === v ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"}`}
                    >{l}</button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">背景音乐</label>
              <div className="flex gap-3">
                <button onClick={() => setBgmId("")}
                  className={`px-4 py-2 rounded-lg text-sm border ${!bgmId ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"}`}
                >无</button>
                {bgmList.map(b => (
                  <button key={b.id} onClick={() => setBgmId(b.id)}
                    className={`px-4 py-2 rounded-lg text-sm border ${bgmId === b.id ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-500"}`}
                  >{b.name}</button>
                ))}
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-600">
              <p>📊 摘要：{images.length} 张图片 · 预计 {estimatedDuration.toFixed(0)} 秒 · {resolution === "1080x1920" ? "竖版" : "横版"} · {transition === "none" ? "无转场" : transition}</p>
            </div>

            <div className="flex justify-between">
              <button onClick={() => setStep("upload")} className="px-6 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50">上一步</button>
              <button onClick={() => { setStep("compose"); handleCompose(); }} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">开始合成</button>
            </div>
          </div>
        )}

        {/* Step 3: 合成 & 预览 */}
        {step === "compose" && (
          <div className="bg-white rounded-xl p-8 text-center">
            {composing && (
              <div>
                <div className="w-16 h-16 mx-auto mb-4 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
                <p className="text-lg font-medium text-gray-700 mb-2">视频合成中...</p>
                <div className="max-w-md mx-auto bg-gray-100 rounded-full h-3 mb-2">
                  <div className="bg-blue-600 h-3 rounded-full transition-all" style={{ width: `${progress}%` }} />
                </div>
                <p className="text-sm text-gray-500">{progress}% · 请勿关闭页面</p>
              </div>
            )}

            {error && !composing && (
              <div className="text-center">
                <p className="text-red-500 text-lg mb-4">❌ {error}</p>
                <button onClick={() => { setStep("config"); setError(null); }} className="px-6 py-2 border border-gray-300 rounded-lg text-sm">返回修改</button>
              </div>
            )}

            {result && !composing && (
              <div>
                <p className="text-green-600 text-lg font-medium mb-4">✅ 视频合成完成</p>
                <video
                  src={result.url || result.videoUrl}
                  controls
                  className="max-w-md mx-auto rounded-lg shadow-lg mb-4"
                  poster={result.coverUrl}
                />
                <div className="flex justify-center gap-4">
                  <a
                    href={result.url || result.videoUrl}
                    download
                    className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
                  >下载视频</a>
                  <button
                    onClick={() => { setStep("upload"); setImages([]); setResult(null); setJobId(null); }}
                    className="px-6 py-2 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
                  >制作新视频</button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && step !== "compose" && (
          <p className="mt-4 text-sm text-red-500 text-center">{error}</p>
        )}
      </div>
    </div>
  );
}
