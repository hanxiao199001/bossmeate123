/**
 * html-text 回归锁。8-20。
 *
 * 红线 #15：锁**行为**不锁写法 —— 全部断言都是「输入 → 输出」，
 * 不匹配源码字面，重构实现不会把这些测试变红。
 */
import { describe, it, expect } from "vitest";
import { decodeEntities, htmlToPlainText } from "./html-text";

describe("htmlToPlainText — 事故复现", () => {
  it("内容工坊预览区那条：&amp; 必须显示成 &", () => {
    // 8-20 老韩截图的原句
    const body = '<p style="color:#2C5F8D">🔍 Statistics &amp; Probability</p>';
    expect(htmlToPlainText(body)).toBe("🔍 Statistics & Probability");
  });

  it("真实语料里的两个刊名", () => {
    expect(htmlToPlainText("<p>Computers &amp; Education</p>")).toBe("Computers & Education");
    expect(htmlToPlainText("<p>Arthritis &amp; Rheumatism</p>")).toBe("Arthritis & Rheumatism");
  });
});

describe("decodeEntities — 单次扫描（这条是判据不是实现细节）", () => {
  it("&amp;lt; 解成 &lt;，不许再解成 <", () => {
    // 反复解到收敛就会得到 "<" —— 那是把已经转义过的内容又剥了一层
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("&amp;amp; 解成 &amp;", () => {
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });
});

describe("decodeEntities — 不认识的原样保留（红线 #14 同族：不许静默吞掉）", () => {
  it("未知实体名不变", () => {
    expect(decodeEntities("a &foo; b")).toBe("a &foo; b");
  });

  it("码点越界不变", () => {
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeEntities("&#0;")).toBe("&#0;");
  });

  it("代理区码点不变（String.fromCodePoint 会抛）", () => {
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
  });

  it("裸 & 不动", () => {
    expect(decodeEntities("A & B")).toBe("A & B");
  });
});

describe("decodeEntities — 数字实体", () => {
  it("十进制", () => {
    expect(decodeEntities("&#38;")).toBe("&");
    expect(decodeEntities("&#20013;&#25991;")).toBe("中文");
  });

  it("十六进制，大小写 x 都认", () => {
    expect(decodeEntities("&#x26;")).toBe("&");
    expect(decodeEntities("&#X26;")).toBe("&");
  });

  it("BMP 外的码点（emoji）", () => {
    expect(decodeEntities("&#x1F600;")).toBe("😀");
  });
});

describe("htmlToPlainText — 顺序：先剥标签后解实体", () => {
  it("被转义的尖括号必须活下来，不能当标签剥掉", () => {
    // 顺序反了的话 &lt;p&gt; 先变 <p> 再被剥 → 输出空
    expect(htmlToPlainText("原文写的是 &lt;p&gt; 标签")).toBe("原文写的是 <p> 标签");
  });

  it("真标签剥掉", () => {
    expect(htmlToPlainText('<div class="x"><span>abc</span></div>')).toBe("abc");
  });
});

describe("htmlToPlainText — 空白与常见实体", () => {
  it("&nbsp; 变普通空格并被折叠", () => {
    expect(htmlToPlainText("a&nbsp;&nbsp;&nbsp;b")).toBe("a b");
  });

  it("换行与多空格折叠成一个空格", () => {
    // 标签之间的空白**保留为一个空格**：那是原文里真实存在的分隔
    expect(htmlToPlainText("<p>a</p>\n\n   <p>b</p>")).toBe("a b");
  });

  it("标签之间没有空白时不凭空插空格", () => {
    // 剥标签用的是空串不是空格，所以这里粘在一起 —— 这是当前行为，钉住它
    expect(htmlToPlainText("<b>前</b><b>后</b>")).toBe("前后");
  });

  it("中文排版实体", () => {
    expect(htmlToPlainText("<p>他说&ldquo;好&rdquo;&hellip;</p>")).toBe("他说“好”…");
  });

  it("空串", () => {
    expect(htmlToPlainText("")).toBe("");
  });
});
