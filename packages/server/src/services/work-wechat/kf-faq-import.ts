/**
 * FAQ 批量导入解析 + 规范化（纯函数，供 routes/work-wechat-kf.ts 的 /admin/kf/faqs/import 端点复用，可单测）。
 *
 * 让老板"自己教客服"：粘贴文本或上传 CSV/Excel（前端解析预览）→ 归一到 ParsedFaqItem[] → 端点去重入库。
 *
 * 支持两种粘贴文本格式：
 *   1) 竖线分隔：每行 "问题 | 答案"（半角 | / 全角 ｜ / 制表符 均可；答案里含 | 时只按首个分隔符切）
 *   2) Q/A 成对：以 Q:/问:/问题: 开头行为问题，紧随 A:/答:/答案: 开头行为答案（答案可跨多行到下个 Q）
 * CSV/Excel 解析在前端做（预览用），最终都归一到 ParsedFaqItem[] 走本模块 normalize + 端点去重。
 */

export interface ParsedFaqItem {
  question: string;
  answer: string;
  enabled: boolean;
  sort: number;
}

const Q_PREFIX = /^\s*(?:Q|问|问题)\s*[:：.、]\s*/i;
const A_PREFIX = /^\s*(?:A|答|答案)\s*[:：.、]\s*/i;
const PIPE_CHARS = ["|", "｜", "\t"];

export const FAQ_QUESTION_MAX = 500;
export const FAQ_ANSWER_MAX = 4000;

function truncate(s: string, n = 30): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function clampItem(question: string, answer: string): ParsedFaqItem {
  return {
    question: question.slice(0, FAQ_QUESTION_MAX),
    answer: answer.slice(0, FAQ_ANSWER_MAX),
    enabled: true,
    sort: 0,
  };
}

function parsePipeFormat(lines: string[]): { items: ParsedFaqItem[]; errors: string[] } {
  const items: ParsedFaqItem[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return; // 空行跳过
    let idx = -1;
    for (const ch of PIPE_CHARS) {
      const at = t.indexOf(ch);
      if (at >= 0 && (idx < 0 || at < idx)) idx = at;
    }
    if (idx < 0) {
      errors.push(`第 ${i + 1} 行缺少分隔符「|」：${truncate(t)}`);
      return;
    }
    const question = t.slice(0, idx).trim();
    const answer = t.slice(idx + 1).trim();
    if (!question || !answer) {
      errors.push(`第 ${i + 1} 行问题或答案为空：${truncate(t)}`);
      return;
    }
    items.push(clampItem(question, answer));
  });
  return { items, errors };
}

function parseQaFormat(lines: string[]): { items: ParsedFaqItem[]; errors: string[] } {
  const items: ParsedFaqItem[] = [];
  const errors: string[] = [];
  let curQ: string | null = null;
  let curA: string[] = [];
  let inAnswer = false;

  const flush = () => {
    if (curQ !== null) {
      const answer = curA.join("\n").trim();
      if (answer) items.push(clampItem(curQ, answer));
      else errors.push(`问题「${truncate(curQ)}」缺少答案`);
    }
    curQ = null;
    curA = [];
    inAnswer = false;
  };

  for (const line of lines) {
    if (Q_PREFIX.test(line)) {
      flush();
      curQ = line.replace(Q_PREFIX, "").trim();
      inAnswer = false;
    } else if (A_PREFIX.test(line)) {
      curA.push(line.replace(A_PREFIX, "").trim());
      inAnswer = true;
    } else if (inAnswer && line.trim()) {
      curA.push(line.trim()); // 答案跨多行
    }
    // 首个 Q 之前的游离行忽略
  }
  flush();
  return { items, errors };
}

/** 解析粘贴文本 → ParsedFaqItem[]（自动识别 Q/A 格式 vs 竖线格式） */
export function parseFaqText(text: string): { items: ParsedFaqItem[]; errors: string[] } {
  const raw = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const hasQa = lines.some((l) => Q_PREFIX.test(l));
  return hasQa ? parseQaFormat(lines) : parsePipeFormat(lines);
}

/**
 * 规范化前端传来的数组（CSV/Excel/文本解析后的 items）：
 * 校验非空、截断超长、补默认 enabled/sort；无效行计数返回。
 */
export function normalizeImportItems(raw: unknown): { items: ParsedFaqItem[]; invalid: number } {
  const arr = Array.isArray(raw) ? raw : [];
  const items: ParsedFaqItem[] = [];
  let invalid = 0;
  for (const r of arr) {
    if (!r || typeof r !== "object") { invalid++; continue; }
    const rec = r as Record<string, unknown>;
    const q = String(rec.question ?? "").trim();
    const a = String(rec.answer ?? "").trim();
    if (!q || !a) { invalid++; continue; }
    const enabledRaw = rec.enabled;
    const sortNum = Number(rec.sort);
    items.push({
      question: q.slice(0, FAQ_QUESTION_MAX),
      answer: a.slice(0, FAQ_ANSWER_MAX),
      enabled: typeof enabledRaw === "boolean" ? enabledRaw : true,
      sort: Number.isFinite(sortNum) ? Math.trunc(sortNum) : 0,
    });
  }
  return { items, invalid };
}

/** 归一化 question 作去重键（小写 + 去掉所有空白）—— 中文无空格，去空白后中英文去重都稳定 */
export function faqDedupKey(question: string): string {
  return question.toLowerCase().replace(/\s+/g, "");
}

/** 批内按 question 去重（保留首条），返回去重后数组 + 批内重复条数 */
export function dedupWithinBatch(items: ParsedFaqItem[]): { items: ParsedFaqItem[]; duplicated: number } {
  const seen = new Set<string>();
  const out: ParsedFaqItem[] = [];
  let duplicated = 0;
  for (const it of items) {
    const key = faqDedupKey(it.question);
    if (seen.has(key)) { duplicated++; continue; }
    seen.add(key);
    out.push(it);
  }
  return { items: out, duplicated };
}
