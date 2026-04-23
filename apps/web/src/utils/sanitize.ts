/**
 * 轻量前端 XSS 防护工具
 *
 * 这里没有引入 DOMPurify，而是基于浏览器原生 DOMParser 做白名单清洗。
 * 后续如果要接入更严格/更复杂的模板，再考虑切换到 DOMPurify。
 */

/** HTML 实体转义（用于把任意用户文本放进 HTML 字符串时的第一道防线） */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只允许 http(s)、相对路径、mailto、tel；拒绝 javascript:/data: 等协议 */
export function isSafeUrl(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  // 相对路径
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?")) return true;
  // 绝对 URL
  try {
    const u = new URL(trimmed, window.location.origin);
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol);
  } catch {
    return false;
  }
}

// 允许渲染的标签白名单
const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

// 每个标签允许保留的属性白名单（style 只在少量场景下保留，避免 expression/behavior/url()）
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  "*": ["class", "id", "style"],
};

const STYLE_DENYLIST = /(expression|javascript:|behavior:|@import|url\s*\()/i;

function sanitizeStyle(value: string): string {
  if (STYLE_DENYLIST.test(value)) return "";
  return value;
}

function isAllowedAttr(tagName: string, attrName: string): boolean {
  const tagAttrs = ALLOWED_ATTRS[tagName] || [];
  const globalAttrs = ALLOWED_ATTRS["*"] || [];
  return tagAttrs.includes(attrName) || globalAttrs.includes(attrName);
}

/**
 * 使用浏览器 DOMParser 清洗 HTML —— 移除标签/属性白名单外的所有内容、
 * 移除所有 on* 事件属性、验证 href/src 协议、清洗 style。
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    // SSR 或测试环境退化：直接做 HTML 实体转义
    return escapeHtml(html);
  }

  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return "";

  walk(root);
  return root.innerHTML;
}

function walk(node: Element): void {
  // 倒序遍历：清洗过程会移除节点
  const children = Array.from(node.children);
  for (const child of children) {
    const tag = child.tagName.toLowerCase();

    // 1. 非白名单标签直接移除
    if (!ALLOWED_TAGS.has(tag)) {
      child.remove();
      continue;
    }

    // 2. 清洗属性
    const attrs = Array.from(child.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();

      // on* 事件属性一律清掉
      if (name.startsWith("on")) {
        child.removeAttribute(attr.name);
        continue;
      }

      // 非白名单属性清掉
      if (!isAllowedAttr(tag, name)) {
        child.removeAttribute(attr.name);
        continue;
      }

      // href / src 协议校验
      if ((name === "href" || name === "src") && !isSafeUrl(attr.value)) {
        child.removeAttribute(attr.name);
        continue;
      }

      // style 过滤危险内容
      if (name === "style") {
        const cleaned = sanitizeStyle(attr.value);
        if (cleaned) child.setAttribute("style", cleaned);
        else child.removeAttribute("style");
        continue;
      }
    }

    // 3. a 标签强制加 rel="noopener noreferrer"（target=_blank 场景必备）
    if (tag === "a" && child.getAttribute("target") === "_blank") {
      child.setAttribute("rel", "noopener noreferrer");
    }

    // 4. 递归清洗子节点
    walk(child);
  }
}
