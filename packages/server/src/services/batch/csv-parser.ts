/**
 * P4 csv-parser（5-12 backend Day 1）。
 *
 * 输入：utf-8 BOM csv string（来自 multipart upload）
 * 输出：解析后 row 数组 + 校验错误
 *
 * Spec CSV schema:
 *   topic       (必, string ≤100 字)
 *   journal_id  (选, UUID)
 *   template    (选, A/B/C/E)
 *   priority    (选, 1-5)
 */
import Papa from "papaparse";
import { logger } from "../../config/logger.js";

export interface CsvRow {
  rowIndex: number;
  topic: string;
  journalId: string | null;
  template: "A" | "B" | "C" | "E" | null;
  priority: number;
  accountId?: string | null; // PR-X1: 独家生成时绑定账号(注入人设)
  templateId?: string | null; // PR-Q2: 直接指定排版模板id(覆盖letter映射, 用于每日轮换真模板)
}

export interface CsvParseResult {
  rows: CsvRow[];
  errors: Array<{ rowIndex: number; message: string }>;
  totalRaw: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE_VALUES = new Set(["A", "B", "C", "E"]);

/** 解析 utf-8 (含 BOM) csv 字符串 → CsvRow[] + errors */
export function parseCsv(input: string): CsvParseResult {
  // 去 BOM
  const csv = input.replace(/^﻿/, "");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    logger.warn({ errors: parsed.errors.slice(0, 3) }, "P4 csv parser papaparse error");
  }

  const rows: CsvRow[] = [];
  const errors: Array<{ rowIndex: number; message: string }> = [];

  parsed.data.forEach((raw, i) => {
    const rowIndex = i + 1; // csv 第 1 行（header 之后）
    const topic = (raw.topic ?? "").trim();
    if (!topic) {
      errors.push({ rowIndex, message: "topic 必填" });
      return;
    }
    if (topic.length > 100) {
      errors.push({ rowIndex, message: "topic 超过 100 字" });
      return;
    }

    const journalIdRaw = (raw.journal_id ?? "").trim();
    let journalId: string | null = null;
    if (journalIdRaw) {
      if (!UUID_RE.test(journalIdRaw)) {
        errors.push({ rowIndex, message: `journal_id 不是合法 UUID: ${journalIdRaw}` });
        return;
      }
      journalId = journalIdRaw;
    }

    const templateRaw = (raw.template ?? "").trim().toUpperCase();
    let template: CsvRow["template"] = null;
    if (templateRaw) {
      if (!TEMPLATE_VALUES.has(templateRaw)) {
        errors.push({ rowIndex, message: `template 必须 A/B/C/E，得到: ${templateRaw}` });
        return;
      }
      template = templateRaw as CsvRow["template"];
    }

    const priorityRaw = (raw.priority ?? "").trim();
    let priority = 3; // default normal
    if (priorityRaw) {
      const n = parseInt(priorityRaw, 10);
      if (Number.isNaN(n) || n < 1 || n > 5) {
        errors.push({ rowIndex, message: `priority 必须 1-5 整数，得到: ${priorityRaw}` });
        return;
      }
      priority = n;
    }

    rows.push({ rowIndex, topic, journalId, template, priority });
  });

  return { rows, errors, totalRaw: parsed.data.length };
}

/** 生成 CSV 报告（utf-8 BOM）— batch 完成后下载 */
export function buildReportCsv(items: Array<{
  rowIndex: number;
  topic: string;
  status: string;
  articleId: string | null;
  errorMessage: string | null;
}>): string {
  const headers = ["row", "topic", "status", "article_id", "error"];
  const rows = items.map((it) =>
    [
      it.rowIndex,
      `"${(it.topic || "").replace(/"/g, '""')}"`,
      it.status,
      it.articleId ?? "",
      `"${(it.errorMessage || "").replace(/"/g, '""')}"`,
    ].join(","),
  );
  return "﻿" + [headers.join(","), ...rows].join("\n");
}
