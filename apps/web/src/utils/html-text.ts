/**
 * HTML → 纯文本摘要（前端预览用）。8-20 建。
 *
 * ═══ 为什么单独一个文件 ═══
 *
 * 事故：内容工坊预览区显示「Statistics &amp;amp; Probability」。
 *
 * 正文 body 是 HTML，`&` 在里面**正确地**存成 `&amp;` —— 公众号侧走
 * `dangerouslySetInnerHTML`，浏览器解实体，渲染成 `&`，没有任何问题。
 *
 * 坏的是预览侧：剥掉标签后把结果交给 JSX 当**纯文本**渲染
 * （`{preview}`），React 不解实体，`&amp;` 就原样显示给运营看。
 *
 * ▎ 同一份数据，一条路径正确一条路径错误 —— 区别不在数据，在**谁负责解实体**。
 *   innerHTML 路径由浏览器解；text 路径没人解，必须在这里补上。
 *
 * 当时同样的实现被复制在两处（ContentPreviewPane / RecommendationCard），
 * 所以收口成一个函数：以后再有「剥标签当文本显示」的需求一律用它，
 * 不要再写第三份 `replace(/<[^>]+>/g, "")`。
 *
 * ═══ 安全性 ═══
 *
 * 本函数的输出**只可用于文本渲染**（JSX `{}`、title 属性、textContent）。
 * 它会把 `&lt;script&gt;` 解成 `<script>` —— 那在文本上下文里是无害的字面量，
 * 但塞进 `dangerouslySetInnerHTML` 就是 XSS。要渲染 HTML 请走 `utils/sanitize.ts`。
 */

/** 实体名 → 字符。只收常见的；不认识的原样保留，见 decodeEntities 的注释。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  times: "×",
  divide: "÷",
};

/**
 * 解 HTML 实体。**单次扫描**，这一点是判据不是实现细节：
 *
 *   `&amp;lt;`  单次扫描 → `&lt;`   ✅ 原文想显示的就是 "&lt;" 这五个字符
 *   `&amp;lt;`  反复解直到不变 → `<` ❌ 把转义过一次的内容又解了一层
 *
 * 所以**不要**改成 while 循环解到收敛。
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent: string) => {
    if (ent.charCodeAt(0) === 35 /* # */) {
      const hex = ent[1] === "x" || ent[1] === "X";
      const code = parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      // 代理区单独码点 String.fromCodePoint 会抛，挡在这里
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    // 🔴 不认识的实体**原样返回**，不返回空串。
    //   吞掉的话「&foo;」会静默消失，读的人无从知道那里本来有东西 —— 红线 #14 同族。
    return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

/**
 * 剥标签 + 解实体 + 折叠空白，得到可直接放进 JSX 文本位的字符串。
 *
 * **顺序不可换**：先剥标签，后解实体。
 * 反过来的话 `&lt;p&gt;` 会先变成 `<p>`，再被当成真标签剥掉 ——
 * 原文里本来要展示给人看的尖括号就凭空消失了。
 */
export function htmlToPlainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
