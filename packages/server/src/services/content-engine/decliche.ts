/**
 * P0四件套③：AI 腔检测与段落级清洗
 *
 * detectCliches(text)  —— 纯函数，返回命中列表+位置（零 LLM 成本，可高频调用）
 * removeCliches(text)  —— 只把"命中句子所在段落"批量发给 LLM 改写（去 AI 腔、信息不变）。
 *   为什么段落级：整文重写贵且容易改丢事实；只送命中段落，token 省 70%+，
 *   且未命中段落物理上不可能被改坏。LLM 失败/输出异常一律返回原文（绝不阻塞生成）。
 */
import { logger } from "../../config/logger.js";
import { chat } from "../ai/chat-service.js";
import { AI_CLICHE_PATTERNS } from "../../data/ai-cliche.js";

// ============ 类型 ============

export interface ClicheHit {
  /** 命中的模式名 */
  name: string;
  /** 命中的原文片段 */
  match: string;
  /** 在全文中的起始位置 */
  index: number;
}

export interface ProseSegment {
  /** 段落在全文中的 [start, end) 偏移 */
  start: number;
  end: number;
  /** 段落原文（HTML 模式下含内层标签） */
  text: string;
}

export interface RemoveClichesResult {
  text: string;
  hits: ClicheHit[];
  /** 是否真的做了 LLM 改写 */
  rewritten: boolean;
  llmCalls: number;
}

// ============ 检测（纯函数） ============

/**
 * 检测 AI 腔命中：单点模式（黑名单表）+ 两条组合模式（连排/滥用）。
 */
export function detectCliches(text: string): ClicheHit[] {
  if (!text) return [];
  const hits: ClicheHit[] = [];

  for (const p of AI_CLICHE_PATTERNS) {
    const re = new RegExp(p.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits.push({ name: p.name, match: m[0], index: m.index });
      // 防呆：零宽匹配死循环保护
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // 组合模式 1：首先/其次/最后 连排（三者都出现且按序 → AI 分点腔）
  const first = text.indexOf("首先");
  const second = text.indexOf("其次");
  const last = Math.max(text.indexOf("最后"), text.indexOf("最終"));
  if (first >= 0 && second > first && last > second) {
    hits.push({ name: "首先/其次/最后连排", match: "首先…其次…最后", index: first });
  }

  // 组合模式 2："不仅…还/而且" 滥用（≥3 次即算，1-2 次属正常表达不误伤）
  const bujinRe = /不仅[^，。！？]{1,30}[，,]?(?:还|而且|更)/g;
  const bujinMatches: RegExpExecArray[] = [];
  let bm: RegExpExecArray | null;
  while ((bm = bujinRe.exec(text)) !== null) bujinMatches.push(bm);
  if (bujinMatches.length >= 3) {
    hits.push({ name: "不仅…还…滥用", match: `不仅…还（出现${bujinMatches.length}次）`, index: bujinMatches[0].index });
  }

  return hits.sort((a, b) => a.index - b.index);
}

// ============ 段落切分（markdown / HTML 双模式） ============

/** 粗判 body 是否 HTML（模板文章是整段 HTML，markdown 文章基本无标签） */
export function looksLikeHtml(body: string): boolean {
  if (!body) return false;
  const sample = body.slice(0, 2000);
  return /<(article|section|div|p|h[1-6])[\s>]/i.test(sample);
}

/**
 * 抽取"承载正文文字"的段落段：
 * - markdown：按空行切段（保留偏移）
 * - HTML：只取 <p>/<li>/<h3>/<h4> 块（数据卡/图表/样式块不碰，改写不会破排版）
 */
export function extractProseSegments(body: string): ProseSegment[] {
  if (!body) return [];
  const segs: ProseSegment[] = [];
  if (looksLikeHtml(body)) {
    const re = /<(p|li|h3|h4)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      // 图位/图表块（<img> / <!--img-slot-->）不是"承载正文文字"的段，排除在改写候选外(7-03):
      // 否则段落级重写/去AI腔会把 base64 <img> 当普通段送进 LLM → 图文交替排版被吞。
      // replaceSegments 按偏移替换, 未入选段原样留在 body → 图位保住。
      if (/<img\b|<!--\s*img-slot/i.test(m[0])) continue;
      segs.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  } else {
    const re = /[^\n]+(?:\n(?!\n)[^\n]+)*/g; // 连续非空行 = 一段
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      segs.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  }
  return segs;
}

/** 用改写后的段落替换回原文（按偏移从后往前替换，避免位移串位） */
export function replaceSegments(
  body: string,
  replacements: Array<{ seg: ProseSegment; newText: string }>
): string {
  let out = body;
  const sorted = [...replacements].sort((a, b) => b.seg.start - a.seg.start);
  for (const { seg, newText } of sorted) {
    out = out.slice(0, seg.start) + newText + out.slice(seg.end);
  }
  return out;
}

// ============ 清洗（LLM 段落级改写） ============

/**
 * 命中 >0 时，把命中句子所在段落批量（单次 LLM 调用）改写为"无 AI 腔、信息不变"。
 * 兜底铁律：任何异常（LLM 挂/JSON 解析失败/改写后长度异常）→ 返回原文。
 */
export async function removeCliches(
  text: string,
  opts: { tenantId: string; userId?: string }
): Promise<RemoveClichesResult> {
  const hits = detectCliches(text);
  if (hits.length === 0) {
    return { text, hits, rewritten: false, llmCalls: 0 };
  }

  // 找到命中所在的段落（去重）
  const segments = extractProseSegments(text);
  const hitSegs = segments.filter((s) => hits.some((h) => h.index >= s.start && h.index < s.end));
  if (hitSegs.length === 0) {
    // 命中落在非正文区（如 HTML 属性/数据卡），不改写
    return { text, hits, rewritten: false, llmCalls: 0 };
  }

  // 成本护栏：单次最多送 12 段 / 6000 字，超出部分留给下轮（低频场景，不值得多花一次调用）
  const capped: typeof hitSegs = [];
  let budget = 6000;
  for (const s of hitSegs) {
    if (capped.length >= 12 || s.text.length > budget) break;
    capped.push(s);
    budget -= s.text.length;
  }

  const numbered = capped.map((s, i) => `【段${i + 1}】${s.text}`).join("\n\n");
  const hitNames = [...new Set(hits.map((h) => h.name))].join("、");

  try {
    const resp = await chat({
      tenantId: opts.tenantId,
      userId: opts.userId || "system",
      conversationId: `decliche-${Date.now()}`,
      skillType: "content_generation",
      message: `以下段落被检测出"AI 腔"套话（命中：${hitNames}）。请逐段改写：
1. 去掉所有 AI 腔套话，改成真人自然表达；信息、数据、事实一个都不能丢、不能改
2. 保留段内所有 HTML/Markdown 标记（<p>/<strong>/加粗/列表符号等）原样不动
3. 字数与原段接近（±25%），一句能说清的不用两句
4. 只输出 JSON：{"1":"改写后的段1","2":"改写后的段2",...}，不要解释

${numbered}`,
    });

    const jsonMatch = resp.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("decliche LLM 输出无 JSON");
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;

    const replacements: Array<{ seg: ProseSegment; newText: string }> = [];
    capped.forEach((seg, i) => {
      const nt = parsed[String(i + 1)];
      // 逐段校验：非空 + 长度在原段 40%-250% 内才采用（防 LLM 吞段/注水）
      if (typeof nt === "string" && nt.trim().length >= seg.text.length * 0.4 && nt.length <= seg.text.length * 2.5) {
        replacements.push({ seg, newText: nt.trim() });
      }
    });
    if (replacements.length === 0) {
      return { text, hits, rewritten: false, llmCalls: 1 };
    }
    const newText = replaceSegments(text, replacements);
    logger.info(
      { hits: hits.length, segsRewritten: replacements.length, segsTotal: hitSegs.length },
      "P0③ 去AI腔：段落级清洗完成"
    );
    return { text: newText, hits, rewritten: true, llmCalls: 1 };
  } catch (err) {
    // 兜底：LLM 失败返回原文，绝不阻塞生成
    logger.warn({ err: err instanceof Error ? err.message : err }, "P0③ 去AI腔 LLM 失败，保留原文");
    return { text, hits, rewritten: false, llmCalls: 1 };
  }
}
