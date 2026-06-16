/**
 * 5-18 P1 — Workbench 中列预览。前 800 字 plain text preview，不可编辑。
 * 点 [✏️ 完整编辑] 跳 /content/:id 走老 ContentDetailPage 编辑全套。
 */
import { Link } from "react-router-dom";

export interface PreviewContent {
  id: string;
  title: string | null;
  body: string | null;
  type?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContentPreviewPaneProps {
  content: PreviewContent | null;
  loading: boolean;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export default function ContentPreviewPane({ content, loading }: ContentPreviewPaneProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">⏳ 加载中…</div>
    );
  }
  if (!content) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        从左侧列表选一篇内容查看预览
      </div>
    );
  }

  const journalName = (content.metadata as { journalName?: string } | null | undefined)?.journalName;
  const isVideo = content.type === "video";
  const coverUrl = (content.metadata as { coverUrl?: string } | null | undefined)?.coverUrl;
  const preview = content.body && !isVideo ? stripHtml(content.body).slice(0, 800) : "";

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-3">{content.title || "(无标题)"}</h2>
        {journalName && (
          <p className="text-sm text-gray-500 mb-4">期刊：{journalName}</p>
        )}
        <div className="border-t border-gray-200 pt-4 mb-4" />
        {isVideo ? (
          <div className="bg-black rounded-xl p-4 flex justify-center">
            <div className="w-full max-w-md">
              {content.body ? (
                <video src={content.body} controls poster={coverUrl} className="w-full rounded-lg" />
              ) : (
                <p className="text-gray-400 text-sm text-center py-10">(视频地址缺失)</p>
              )}
              {content.body && (
                <div className="mt-3 text-center">
                  <a href={content.body} download className="text-xs text-indigo-300 hover:text-indigo-200">⬇ 下载视频</a>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
              {preview || "(暂无正文内容)"}
            </p>
            {content.body && content.body.length > 800 && (
              <p className="text-xs text-gray-400 mt-3">… 前 800 字预览，完整编辑请点下方按钮</p>
            )}
          </>
        )}
        <div className="mt-6">
          <Link
            to={`/content/${content.id}`}
            className="inline-block px-4 py-2 text-sm font-medium rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            ✏️ 完整编辑
          </Link>
        </div>
      </div>
    </div>
  );
}
