/**
 * LLM 输出里把 JSON 捞出来 —— 纯函数, 零依赖, 不联网不问 LLM (7-30)。
 *
 * ## 为什么需要
 *
 * 六维评分要模型吐固定结构 JSON, 而生产实测(7-30 单日)主评分模型 deepseek-v4-pro
 * **28 次输出不可解析**, 每次都触发一次原模型重打(= 一次真金白银的推理调用),
 * 12 次重打后仍失败升级到 qwen-plus, 2 次连 qwen-plus 也没救回来 → 整篇没评上分。
 * 历史累计 `六维评分输出无 JSON` 已 192 次。
 *
 * 原解析只有一行 `content.match(/\{[\s\S]*\}/)` + `JSON.parse`。这对**推理型模型**不够:
 * 它在正式输出前会跑思维链, reasoning_content / markdown 围栏 / 中途插解释文字都会混进来。
 * 报错位置分布很散(实测 position 89/140/191/237/941/972/990)正是这个特征 ——
 * 不是某个固定格式问题, 是随机混入非 JSON 内容。
 *
 * ## 修的是什么, 不修什么
 *
 * 只做**确定性的字符串整形**, 一律不猜语义:
 *   ① 剥 ```json / ``` 围栏
 *   ② 剥推理型模型常见的前导段(<think>…</think> / "思考过程:" 之类)
 *   ③ 用**括号配平**取第一个完整的 JSON 对象(原来的贪婪 `\{[\s\S]*\}` 会把正文里后面
 *      任何一个 `}` 也吞进来, 一旦模型在 JSON 后面又说了两句话就必炸)
 *   ④ 去尾逗号 `,}` / `,]`
 *   ⑤ 中文全角引号 → 半角(模型偶发)
 *   ⑥ 以上都不行时: 截到**最后一个能配平的位置**再试(救"输出被截断"那一类)
 *
 * **不做**: 补缺失字段、猜数值、把非 JSON 强行拼成 JSON。修不出来就老实返回 null,
 * 让上层走重打/降级 —— 猜出来的分比没有分更危险。
 */

/** 提取结果。repairs 记录用了哪些手段, 便于日后统计"哪种坏法最多"。 */
export interface JsonExtractResult {
  value: unknown | null;
  /** 用到的修复手段(空数组 = 原样就能解析) */
  repairs: string[];
}

const FENCE_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;
/** 推理型模型的前导思考段 */
const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const LEAD_NOISE_RE = /^[\s\S]{0,400}?(?=\{)/;

/** 括号配平: 从 start 处的 `{` 出发找到与之匹配的 `}`, 找不到返回 -1。跳过字符串字面量与转义。 */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 去掉对象/数组里的尾逗号 —— 只在字符串字面量之外替换 */
function stripTrailingCommas(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ",") {
      // 向后看第一个非空白字符, 是 } 或 ] 就丢掉这个逗号
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 扫一遍, 返回末尾未闭合的结构(供截断修复补齐)。
 * `inStr` = 扫到结尾还在字符串里(说明截断发生在字符串中间, 要先补一个引号)。
 */
function unclosedTail(s: string): { stack: string[]; inStr: boolean } {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  return { stack, inStr };
}

/**
 * 修复出来的结果必须**有实质内容**(至少一个键)。
 *
 * 反例: 输入只有 `"{"`, 补齐右括号后是 `{}` —— 语法合法但语义上是凭空造的空对象。
 * 下游六维评分拿到 `{}` 会把六个维度全算成 0 分, 正是项目一直在消灭的
 * "没评上分被当成评了 0 分"。修不出内容就该返回 null 让上层走重打/降级。
 */
function hasSubstance(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v as Record<string, unknown>).length > 0;
}

function tryParse(text: string): unknown | null {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 从 LLM 原始输出里提取 JSON 对象。修不出来返回 `{ value: null }`。
 *
 * @param raw 模型返回的 content 原文
 */
export function extractJsonObject(raw: string | null | undefined): JsonExtractResult {
  const repairs: string[] = [];
  if (!raw || typeof raw !== "string") return { value: null, repairs };

  let s = raw.trim();

  // ② 先剥推理段(它可能整段包含 `{`, 不剥会把思考里的伪 JSON 当成结果)
  if (THINK_RE.test(s)) { s = s.replace(THINK_RE, "").trim(); repairs.push("strip_think"); }

  // ① markdown 围栏
  const fence = s.match(FENCE_RE);
  if (fence?.[1]) { s = fence[1].trim(); repairs.push("strip_fence"); }

  // 原样能解析就直接回(最常见路径, 不做任何加工)
  const direct = tryParse(s);
  if (direct && typeof direct === "object") return { value: direct, repairs };

  // ③ 括号配平取第一个完整对象
  const first = s.indexOf("{");
  if (first === -1) return { value: null, repairs };
  const end = matchBrace(s, first);
  let candidate: string;
  if (end !== -1) {
    candidate = s.slice(first, end + 1);
    if (first > 0 || end < s.length - 1) repairs.push("brace_match");
  } else {
    // ⑥ 配不平 = 多半被截断。**先按未闭合深度补齐**, 而不是往前找已有的 `}` ——
    //   `{"a":{"score":8},"b":{"score":7` 这种缺两层右括号的, 往前找只能截到 `{"a":{...}`
    //   (自己也不配平, 照样解析不了), 而补齐能把已经吐出来的 b 也保住。这个 bug 是测试抓到的。
    const body = s.slice(first);
    const { stack, inStr } = unclosedTail(body);
    if (stack.length > 0) {
      const closed = body + (inStr ? '"' : "") + stack.reverse().join("");
      const p = tryParse(stripTrailingCommas(closed));
      if (hasSubstance(p)) {
        repairs.push(inStr ? "close_unterminated_string" : "close_unbalanced");
        return { value: p, repairs };
      }
    }
    // 补齐也不行(截断位置太靠前/结构already坏) → 退回"往前找最后一个 }"
    const last = s.lastIndexOf("}");
    if (last <= first) return { value: null, repairs };
    candidate = s.slice(first, last + 1);
    repairs.push("truncated_tail");
  }

  let parsed = tryParse(candidate);
  if (parsed && typeof parsed === "object") return { value: parsed, repairs };

  // ④ 尾逗号
  const noTrailing = stripTrailingCommas(candidate);
  if (noTrailing !== candidate) {
    parsed = tryParse(noTrailing);
    if (parsed && typeof parsed === "object") { repairs.push("trailing_comma"); return { value: parsed, repairs }; }
    candidate = noTrailing;
  }

  // ⑤ 全角引号 → 半角。**必须用 unicode 转义**: 直接在源码里写全角引号, 会被编辑器/格式化
  //   工具归一成 ASCII, 于是 replace 变成"ASCII 换 ASCII"的空操作 —— 这个 bug 是测试抓到的。
  const FULLWIDTH_DQ = /[\u201c\u201d]/g;   // “ ”
  const FULLWIDTH_SQ = /[\u2018\u2019]/g;   // ‘ ’
  if (FULLWIDTH_DQ.test(candidate) || FULLWIDTH_SQ.test(candidate)) {
    const ascii = candidate.replace(FULLWIDTH_DQ, '"').replace(FULLWIDTH_SQ, "'");
    parsed = tryParse(ascii);
    if (parsed && typeof parsed === "object") { repairs.push("fullwidth_quote"); return { value: parsed, repairs }; }
    candidate = ascii;
  }

  // ⑥ 逐段回退: 从最后一个 `}` 往前逐个试, 救"尾部被截断且中间有完整子对象"的情况
  for (let i = candidate.lastIndexOf("}"); i > first; i = candidate.lastIndexOf("}", i - 1)) {
    const attempt = stripTrailingCommas(candidate.slice(0, i + 1));
    const p = tryParse(attempt);
    if (hasSubstance(p)) { repairs.push("progressive_truncate"); return { value: p, repairs }; }
  }

  return { value: null, repairs };
}

/** 便捷版: 只要值, 修不出来返回 null */
export function parseLlmJson<T = unknown>(raw: string | null | undefined): T | null {
  return extractJsonObject(raw).value as T | null;
}
