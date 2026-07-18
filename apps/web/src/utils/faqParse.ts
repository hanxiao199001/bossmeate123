/**
 * FAQ 导入前端解析（预览用）——镜像后端 kf-faq-import.ts 的粘贴文本格式，另加轻量 CSV 解析。
 * 不引第三方依赖（无 papaparse/xlsx）：Excel 请另存为 CSV 再上传。最终归一到 ParsedFaq[]。
 */

export interface ParsedFaq {
  question: string;
  answer: string;
}

const Q_PREFIX = /^\s*(?:Q|问|问题)\s*[:：.、]\s*/i;
const A_PREFIX = /^\s*(?:A|答|答案)\s*[:：.、]\s*/i;
const PIPE_CHARS = ["|", "｜", "\t"];

/** 粘贴文本 → ParsedFaq[]（自动识别 Q/A vs 竖线格式），与后端一致 */
export function parseFaqText(text: string): { items: ParsedFaq[]; errors: string[] } {
  const raw = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const hasQa = lines.some((l) => Q_PREFIX.test(l));
  return hasQa ? parseQa(lines) : parsePipe(lines);
}

function parsePipe(lines: string[]): { items: ParsedFaq[]; errors: string[] } {
  const items: ParsedFaq[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let idx = -1;
    for (const ch of PIPE_CHARS) {
      const at = t.indexOf(ch);
      if (at >= 0 && (idx < 0 || at < idx)) idx = at;
    }
    if (idx < 0) { errors.push(`第 ${i + 1} 行缺少分隔符「|」`); return; }
    const question = t.slice(0, idx).trim();
    const answer = t.slice(idx + 1).trim();
    if (!question || !answer) { errors.push(`第 ${i + 1} 行问题或答案为空`); return; }
    items.push({ question, answer });
  });
  return { items, errors };
}

function parseQa(lines: string[]): { items: ParsedFaq[]; errors: string[] } {
  const items: ParsedFaq[] = [];
  const errors: string[] = [];
  let curQ: string | null = null;
  let curA: string[] = [];
  let inAnswer = false;
  const flush = () => {
    if (curQ !== null) {
      const answer = curA.join("\n").trim();
      if (answer) items.push({ question: curQ, answer });
      else errors.push(`问题「${curQ.slice(0, 20)}」缺少答案`);
    }
    curQ = null; curA = []; inAnswer = false;
  };
  for (const line of lines) {
    if (Q_PREFIX.test(line)) { flush(); curQ = line.replace(Q_PREFIX, "").trim(); inAnswer = false; }
    else if (A_PREFIX.test(line)) { curA.push(line.replace(A_PREFIX, "").trim()); inAnswer = true; }
    else if (inAnswer && line.trim()) { curA.push(line.trim()); }
  }
  flush();
  return { items, errors };
}

/** 解析一行 CSV（支持双引号包裹字段、字段内逗号、"" 转义引号） */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const HEADER_WORDS = new Set(["问题", "答案", "question", "answer", "q", "a", "faq"]);

/** CSV 文本 → ParsedFaq[]（取前两列 问题/答案；自动跳过表头行；去 BOM） */
export function parseFaqCsv(csv: string): { items: ParsedFaq[]; errors: string[] } {
  const raw = (csv ?? "").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n").filter((l) => l.trim());
  const items: ParsedFaq[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const cells = parseCsvLine(line).map((c) => c.trim());
    const question = cells[0] ?? "";
    const answer = cells[1] ?? "";
    // 跳过表头行（首行且两列都像表头词）
    if (i === 0 && HEADER_WORDS.has(question.toLowerCase()) && HEADER_WORDS.has(answer.toLowerCase())) return;
    if (!question || !answer) { errors.push(`第 ${i + 1} 行问题或答案为空`); return; }
    items.push({ question, answer });
  });
  return { items, errors };
}
