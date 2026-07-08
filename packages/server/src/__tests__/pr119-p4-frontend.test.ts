/**
 * PR #119 P4 frontend Day 2 防回归测试。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
function readWeb(rel: string): string {
  return readFileSync(join(__dirname, "../../../../apps/web/src", rel), "utf8");
}

describe("PR #119 BatchUploadModal", () => {
  it("文件存在", () => {
    expect(existsSync(join(__dirname, "../../../../apps/web/src/components/BatchUploadModal.tsx"))).toBe(true);
  });

  const src = readWeb("components/BatchUploadModal.tsx");

  it("含拖拽 onDragOver/onDrop + click 选文件", () => {
    expect(src).toMatch(/onDragOver/);
    expect(src).toMatch(/onDrop/);
    expect(src).toMatch(/inputRef\.current\?\.click/);
    expect(src).toMatch(/accept=".csv"/);
  });

  it("解析 csv + 预览前 5 行", () => {
    expect(src).toMatch(/header\.includes\("topic"\)/);
    expect(src).toMatch(/dataLines\.slice\(0,\s*5\)/);
  });

  it("校验：topic 必填 + ≤5MB + ≤500 行（500 在 backend）", () => {
    expect(src).toMatch(/MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
    expect(src).toMatch(/必须含 topic 列|csv 至少需要/);
  });

  it("估时基于 30s/篇 + concurrency 5", () => {
    expect(src).toMatch(/ESTIMATE_SECONDS_PER_ROW\s*=\s*30/);
    expect(src).toMatch(/totalRows\s*\*\s*ESTIMATE_SECONDS_PER_ROW\s*\/\s*5/);
  });

  it("上传 multipart fetch /batch/upload + 跳 /batch/:id", () => {
    expect(src).toMatch(/POST/);
    expect(src).toMatch(/\/api\/v1\/batch\/upload/);
    expect(src).toMatch(/navigate\(`\/batch\/\$\{batchId\}`\)/);
  });
});

describe("PR #119 BatchProgressPage", () => {
  it("文件存在", () => {
    expect(existsSync(join(__dirname, "../../../../apps/web/src/pages/BatchProgressPage.tsx"))).toBe(true);
  });

  const src = readWeb("pages/BatchProgressPage.tsx");

  it("URL: /batch/:id（useParams 拿 id）", () => {
    expect(src).toMatch(/useParams<\{\s*id:\s*string\s*\}>/);
  });

  it("4 stats: 总 / 完成 / 失败 / 预计剩", () => {
    expect(src).toMatch(/总篇数/);
    expect(src).toMatch(/已完成/);
    expect(src).toMatch(/失败/);
    expect(src).toMatch(/预计剩余/);
  });

  it("进度条 + 进度百分比", () => {
    expect(src).toMatch(/progressPct/);
    expect(src).toMatch(/style=\{\{\s*width:\s*`\$\{progressPct\}%`/);
  });

  it("4 status badge（pending/generating/generated/failed）", () => {
    expect(src).toMatch(/STATUS_BADGE/);
    expect(src).toMatch(/pending:/);
    expect(src).toMatch(/generating:/);
    expect(src).toMatch(/generated:/);
    expect(src).toMatch(/failed:/);
  });

  it("失败行 [🔄 重试] 按钮 → POST /batch/:id/retry/:rowId", () => {
    expect(src).toMatch(/🔄 重试/);
    expect(src).toMatch(/api\.post[\s\S]{0,80}\/batch\/\$\{id\}\/retry\/\$\{rowId\}/);
  });

  it("完成后 [📥 下载 CSV 报告] 按钮 → GET /batch/:id/report", () => {
    expect(src).toMatch(/📥 下载 CSV 报告/);
    expect(src).toMatch(/\/api\/v1\/batch\/\$\{id\}\/report/);
  });

  it("5s polling 仅 status='running' 时；完成后停（spec）", () => {
    expect(src).toMatch(/setInterval\(fetchData,\s*5000\)/);
    expect(src).toMatch(/status\s*!==\s*"running"\s*&&\s*data\.batch\.status\s*!==\s*"pending"/);
  });

  it("article 列：articleId 时跳 /content/:id", () => {
    expect(src).toMatch(/<Link to=\{`\/content\/\$\{r\.articleId\}`\}/);
  });
});

describe("PR #119 ContentPage 入口 + App.tsx 路由", () => {
  // 7-08 死测试清理 (确死: 读已删文件): 删 "ContentPage import BatchUploadModal + state + 按钮" it —
  //   目标 apps/web/src/pages/ContentPage.tsx 已删 (/content 整页下线, 批量导入入口随之下线)。readWeb → ENOENT。
  //   BatchUploadModal 组件本身仍存活 (上方 describe 验证) + /batch/:id 路由仍在 (下方 it 验证)。
  //   ⚠️ 缓刑 (未删, 待过目): 上方 "上传 multipart fetch /batch/upload" + "完成后 下载 CSV 报告" 两个 it 读活文件
  //      (BatchUploadModal.tsx / BatchProgressPage.tsx) 但失败 — 属"活文件内容漂移", 可能是真行为变化, 需你判 (非读已删文件, 未擅动)。

  it("App.tsx 含 /batch/:id 路由 → BatchProgressPage", () => {
    const src = readWeb("App.tsx");
    expect(src).toMatch(/import\s+BatchProgressPage/);
    expect(src).toMatch(/path="\/batch\/:id"/);
    expect(src).toMatch(/<BatchProgressPage\s*\/>/);
  });
});
