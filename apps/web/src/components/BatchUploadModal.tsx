/**
 * P4 BatchUploadModal（5-13 frontend Day 2）。
 *
 * 流程：
 * 1. 拖拽 / 选择 .csv 文件
 * 2. 前端 PapaParse 解析 → 预览前 5 行
 * 3. 显示总行数 + 估时（每篇 ~30s）
 * 4. "开始批量生成" → POST /batch/upload (multipart) → 跳 /batch/:id
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface PreviewRow {
  topic: string;
  journal_id?: string;
  template?: string;
  priority?: string;
}

const ESTIMATE_SECONDS_PER_ROW = 30;
const MAX_BYTES = 5 * 1024 * 1024;

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.ceil(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}min`;
}

export default function BatchUploadModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!open) {
      setFile(null); setPreview([]); setTotalRows(0); setParseErr(null); setUploadErr(null); setUploading(false);
    }
  }, [open]);

  const handleFile = async (f: File) => {
    setFile(f); setParseErr(null); setPreview([]); setTotalRows(0);
    if (!f.name.endsWith(".csv")) { setParseErr("仅支持 .csv 文件"); return; }
    if (f.size > MAX_BYTES) { setParseErr(`文件 ${(f.size/1024/1024).toFixed(2)}MB 超过 5MB 上限`); return; }
    try {
      const text = (await f.text()).replace(/^﻿/, ""); // 去 BOM
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { setParseErr("csv 至少需要 header + 1 行数据"); return; }
      const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
      if (!header.includes("topic")) { setParseErr("csv 必须含 topic 列"); return; }
      const dataLines = lines.slice(1);
      // 仅展示前 5 行（详细校验留 backend）
      const preview5: PreviewRow[] = dataLines.slice(0, 5).map((line) => {
        const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
        const row: Record<string, string> = { topic: "" };
        header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
        return row as unknown as PreviewRow;
      });
      setPreview(preview5);
      setTotalRows(dataLines.length);
    } catch (e) {
      setParseErr((e as Error).message || "csv 解析失败");
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true); setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // 直接 fetch（绕 api.ts 的 JSON content-type，multipart 由 browser 设）
      const token = localStorage.getItem("auth-token") || ""; // useAuthStore 同源
      const resp = await fetch("/api/v1/batch/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      const json = await resp.json();
      const batchId = json?.data?.batchId;
      if (!batchId) throw new Error("响应缺 batchId");
      onClose();
      navigate(`/batch/${batchId}`);
    } catch (e) {
      setUploadErr((e as Error).message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  if (!open) return null;
  const estSec = totalRows * ESTIMATE_SECONDS_PER_ROW / 5; // concurrency 5
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">📤 批量导入 CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* 拖拽 / 选择 */}
          {!file ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false);
                const f = e.dataTransfer.files[0];
                if (f) handleFile(f);
              }}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition ${dragOver ? "border-purple-500 bg-purple-50" : "border-gray-300 hover:border-purple-400"}`}
            >
              <p className="text-4xl mb-3">📤</p>
              <p className="text-base font-medium text-gray-700">拖拽 .csv 文件到这里</p>
              <p className="text-sm text-gray-400 mt-2">或点击选择文件（≤5MB，≤500 行）</p>
              <input ref={inputRef} type="file" accept=".csv" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          ) : (
            <>
              <div className="bg-gray-50 rounded-lg p-3 mb-4 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">📄 {file.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{(file.size / 1024).toFixed(1)} KB · {totalRows} 行有效数据</div>
                </div>
                <button onClick={() => setFile(null)} className="text-xs text-gray-500 hover:text-red-600">重新选择</button>
              </div>

              {parseErr && <div className="text-sm text-red-600 mb-3">❌ {parseErr}</div>}

              {preview.length > 0 && (
                <div className="mb-4">
                  <div className="text-sm font-medium mb-2">前 {preview.length} 行预览：</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="border px-2 py-1 text-left">topic</th>
                          <th className="border px-2 py-1 text-left">journal_id</th>
                          <th className="border px-2 py-1 text-left">template</th>
                          <th className="border px-2 py-1 text-left">priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((r, i) => (
                          <tr key={i}>
                            <td className="border px-2 py-1 truncate max-w-[200px]" title={r.topic}>{r.topic}</td>
                            <td className="border px-2 py-1 text-gray-400">{r.journal_id || "—"}</td>
                            <td className="border px-2 py-1 text-gray-500">{r.template || "default"}</td>
                            <td className="border px-2 py-1 text-gray-500">{r.priority || "3"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {totalRows > 0 && !parseErr && (
                <div className="bg-purple-50 rounded-lg p-3 text-sm">
                  <div className="text-purple-900">
                    <strong>{totalRows}</strong> 篇 article 待生成 · 预计 <strong>{formatTime(Math.ceil(estSec))}</strong>
                  </div>
                  <div className="text-xs text-purple-600 mt-1">每篇 ~30s · concurrency 5（5 篇并行）</div>
                </div>
              )}

              {uploadErr && <div className="text-sm text-red-600 mt-3">❌ {uploadErr}</div>}
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t bg-gray-50 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded">取消</button>
          <button
            onClick={handleUpload}
            disabled={!file || !!parseErr || uploading || totalRows === 0}
            className={`px-4 py-1.5 text-sm font-medium rounded ${!file || !!parseErr || uploading || totalRows === 0
              ? "bg-gray-200 text-gray-400 cursor-not-allowed"
              : "bg-purple-600 text-white hover:bg-purple-700"}`}
          >
            {uploading ? "⏳ 上传中..." : "🚀 开始批量生成"}
          </button>
        </div>
      </div>
    </div>
  );
}
