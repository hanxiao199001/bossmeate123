import { describe, it, expect } from "vitest";
import {
  checkOutputHealth,
  detectRepetition,
  detectTruncation,
  toPlainText,
  TITLE_MIN_CHARS,
  BODY_MIN_PLAIN_CHARS,
  OUTPUT_UNHEALTHY_REASON,
} from "../services/publisher/output-health.js";
import {
  AI_FALLBACK_UNAVAILABLE,
  AI_FALLBACK_NO_MODEL,
  AI_FALLBACK_MESSAGES,
  findAiFallbackText,
  isAiFallbackText,
} from "../services/ai/fallback-messages.js";

/**
 * 7-27 出稿健康闸 —— 纯函数, 零 LLM/零网络/零 DB, 直接单测。
 *
 * 头号用例就是当天的真实事故稿: 标题 = "抱歉，AI暂时无法响应，请稍后重试。", 正文正常,
 * 六维 80 分, status=generated —— 所有"只查 needs_review"的闸对它全部空转, 它一路进了
 * 公众号草稿箱。这道闸必须拦下它。
 */

// ---- 生产形态的正常文章(模板 HTML: 含 SVG 图表 + 内联样式) ----
const NORMAL_TITLE = "北大核心+CSSCI双收录！管理学方向对口，评职称硬通货，青椒毕业党值得重点关注！";
const NORMAL_BODY = `<section style="font-size:15px">
<h2>一、这本刊适合谁投</h2>
<p>如果你是管理学方向的青年教师或在读硕博，正在为评职称、毕业发文发愁，这本期刊值得认真看一看。它同时被北大核心与CSSCI来源期刊目录收录，在国内学术评价体系里属于硬通货级别的身份。</p>
<svg viewBox="0 0 100 40"><rect width="100" height="40"/></svg>
<h2>二、栏目与选题偏好</h2>
<p>该刊常设栏目覆盖企业管理、公共治理、数字经济三大方向，对实证类论文接受度较高，尤其偏好有一手调研数据、方法交代清楚的稿件。纯思辨、无数据支撑的稿件命中率明显偏低。</p>
<p>从近两年的目录看，数字化转型、平台治理、共同富裕相关选题出现频次较高，属于编辑部当前关注的方向。选题贴近这几条线，初审通过的概率会更高一些。</p>
<h2>三、投稿实操建议</h2>
<p>投稿前务必按官网最新格式要求排版，摘要控制在三百字以内，关键词三到五个，参考文献格式要统一。格式不规范是形式审查阶段最常见的退稿原因，而这完全是可以避免的。</p>
<p>另外建议先在知网检索该刊近一年的同方向论文，确认自己的选题没有与已刊发文章高度重合，再决定是否投稿。</p>
</section>`;

describe("① 今天的真实事故稿: 标题被占位文覆盖", () => {
  it("标题=「抱歉，AI暂时无法响应，请稍后重试。」+ 正文正常 → 必须拦", () => {
    const r = checkOutputHealth({ title: AI_FALLBACK_UNAVAILABLE, body: NORMAL_BODY, type: "article" });
    expect(r.healthy).toBe(false);
    expect(r.codes).toContain("ai_fallback_text");
    expect(r.summary).toContain("兜底文案");
  });

  it("即使 status=generated / 六维 80 分, 判据也与状态和分数无关(闸不看 status)", () => {
    // checkOutputHealth 的入参里压根没有 status/score —— 结构上就不可能被 generated 绕过
    const r = checkOutputHealth({ title: AI_FALLBACK_UNAVAILABLE, body: NORMAL_BODY, type: "article" });
    expect(r.healthy).toBe(false);
    expect(OUTPUT_UNHEALTHY_REASON).toBe("output_unhealthy");
  });

  it("另一句兜底文案(无可用模型)同样被拦", () => {
    expect(checkOutputHealth({ title: AI_FALLBACK_NO_MODEL, body: NORMAL_BODY, type: "article" }).healthy).toBe(false);
  });

  it("正文里混进兜底文案(标题正常) → 也拦", () => {
    const body = NORMAL_BODY.replace("</section>", `<p>${AI_FALLBACK_UNAVAILABLE}</p></section>`);
    const r = checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" });
    expect(r.healthy).toBe(false);
    expect(r.codes).toContain("ai_fallback_text");
  });
});

describe("② 正常文章必须放行(零误伤是这道闸的生死线)", () => {
  it("生产形态的模板 HTML 文章 → 放行", () => {
    const r = checkOutputHealth({ title: NORMAL_TITLE, body: NORMAL_BODY, type: "article" });
    expect(r.issues).toEqual([]);
    expect(r.healthy).toBe(true);
  });

  it("正文里合理出现「抱歉」二字 → 放行(不能只匹配两个字)", () => {
    const body = NORMAL_BODY.replace("</section>", "<p>很抱歉地通知各位，该刊已被移出最新版目录，投稿前请再确认一次。</p></section>");
    expect(checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" }).healthy).toBe(true);
  });

  it("正文结尾是无句号的短语(数据来源/落款) → 放行(截断判据刻意收紧)", () => {
    const body = NORMAL_BODY.replace("</section>", "<p>数据来源：期刊官网</p></section>");
    expect(checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" }).healthy).toBe(true);
  });

  it("video 内容(body 是 mp4 URL) → 只查标题, 不因 body 短而误伤", () => {
    const r = checkOutputHealth({ title: NORMAL_TITLE, body: "https://oss.example.com/a/b/c.mp4", type: "video" });
    expect(r.healthy).toBe(true);
  });
});

describe("③ 空/异常短", () => {
  it("标题为空 → 拦", () => {
    const r = checkOutputHealth({ title: "", body: NORMAL_BODY, type: "article" });
    expect(r.codes).toContain("title_empty");
  });
  it("标题 5 字(<6) → 拦; 6 字 → 放行", () => {
    expect(checkOutputHealth({ title: "期刊推荐啊", body: NORMAL_BODY, type: "article" }).codes).toContain("title_too_short");
    expect(TITLE_MIN_CHARS).toBe(6);
    expect(checkOutputHealth({ title: "北大核心期刊推荐", body: NORMAL_BODY, type: "article" }).healthy).toBe(true);
  });
  it("正文过短(生成中断) → 拦", () => {
    const r = checkOutputHealth({ title: NORMAL_TITLE, body: "<p>这本刊是北大核心，</p>", type: "article" });
    expect(r.codes).toContain("body_too_short");
    expect(BODY_MIN_PLAIN_CHARS).toBe(300);
  });
  it("正文为空 → 拦", () => {
    expect(checkOutputHealth({ title: NORMAL_TITLE, body: "", type: "article" }).healthy).toBe(false);
  });
});

describe("④ 明显截断", () => {
  // 够长(>300 字), 否则会先被 body_too_short 拦下(短稿已由 ⑤ 报过, 不重复报截断)
  const long = "这本期刊在管理学领域有较稳定的影响力，栏目设置覆盖企业管理与公共治理两大方向，对实证类稿件接受度较高。".repeat(8);

  it("正文以逗号结束 → 拦", () => {
    const r = checkOutputHealth({ title: NORMAL_TITLE, body: `<p>${long}</p><p>另外需要提醒的是，</p>`, type: "article" });
    expect(r.codes).toContain("body_truncated");
  });
  it("正文以连接词「以及」结束 → 拦", () => {
    const r = checkOutputHealth({ title: NORMAL_TITLE, body: `<p>${long}</p><p>投稿前要确认格式、字数以及</p>`, type: "article" });
    expect(r.codes).toContain("body_truncated");
  });
  it("markdown 代码块未闭合 → 拦", () => {
    expect(detectTruncation("正常收尾。", "正文\n```\ncode\n正常收尾。")).toMatch(/未闭合/);
  });
  it("正文以 ** 残留结尾 → 拦", () => {
    expect(detectTruncation("三、投稿建议", "<p>正文…</p>\n**")).toMatch(/markdown/);
  });
  it("正常句号收尾 → 放行", () => {
    expect(detectTruncation("投稿前请以官网最新要求为准。", "<p>投稿前请以官网最新要求为准。</p>")).toBeNull();
  });
});

describe("⑤ 异常重复(LLM 退化)", () => {
  const seg = "该刊对实证类论文接受度较高，尤其偏好有一手调研数据的稿件。";
  it("同一段落重复 3 次 → 拦", () => {
    const plain = [seg, seg, seg, "其他内容其他内容其他内容其他内容其他内容"].join("\n");
    expect(detectRepetition(plain)).toMatch(/重复 3 次/);
  });
  it("重复 2 次但吃掉大半篇幅 → 拦(比例兜底)", () => {
    const plain = [seg, seg, "短一点的另一段内容，字数不多但满足二十字门槛。"].join("\n");
    expect(detectRepetition(plain)).toMatch(/重复段落占正文/);
  });
  it("模板里的短句重复(<20 字) → 放行", () => {
    const plain = ["点击关注不迷路", "点击关注不迷路", "点击关注不迷路", "正文内容正文内容正文内容正文内容正文内容正文内容"].join("\n");
    expect(detectRepetition(plain)).toBeNull();
  });
  it("端到端: 复读正文 → checkOutputHealth 判不健康", () => {
    const body = `<p>${seg}</p>`.repeat(12); // >300 字, 保证走到重复判据而不是先被"过短"拦下
    const r = checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" });
    expect(r.codes).toContain("body_repetition");
  });
});

describe("⑥ 占位符 / 模板残留", () => {
  it("标题含 'IF X.X'(7-14 生产事故形态) → 拦", () => {
    const r = checkOutputHealth({ title: "IF X.X+1区化学，审稿2.8个月，毕业党闭眼冲！", body: NORMAL_BODY, type: "article" });
    expect(r.codes).toContain("title_placeholder");
  });
  it("标题含 <真实分区> → 拦", () => {
    const r = checkOutputHealth({ title: "期刊解读：中科院<真实分区>《Journal of Test》值得关注", body: NORMAL_BODY, type: "article" });
    expect(r.codes).toContain("title_placeholder");
  });
  it("正文含未替换的 {{IMG:cover}} → 拦", () => {
    const body = NORMAL_BODY.replace("</section>", "<p>{{IMG:cover}}</p></section>");
    expect(checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" }).codes).toContain("template_residue");
  });
  it("正文含 [object Object] → 拦", () => {
    const body = NORMAL_BODY.replace("</section>", "<p>影响因子 [object Object]</p></section>");
    expect(checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" }).codes).toContain("template_residue");
  });
  it("正文含字面量 undefined → 拦", () => {
    const body = NORMAL_BODY.replace("</section>", "<p>审稿周期 undefined 天</p></section>");
    expect(checkOutputHealth({ title: NORMAL_TITLE, body, type: "article" }).codes).toContain("template_residue");
  });
});

describe("⑦ 兜底文案常量集: 单一来源, 加新文案自动被闸覆盖", () => {
  it("AI_FALLBACK_MESSAGES 里的每一句都能被闸认出来", () => {
    for (const msg of AI_FALLBACK_MESSAGES) {
      expect(findAiFallbackText(msg)).toBe(msg);
      expect(checkOutputHealth({ title: msg, body: NORMAL_BODY, type: "article" }).healthy).toBe(false);
    }
  });
  it("归一化: HTML 包裹 / 半角标点 / 中间插空格 都能认出", () => {
    expect(findAiFallbackText("<p>抱歉，AI暂时无法响应，请稍后重试。</p>")).toBe(AI_FALLBACK_UNAVAILABLE);
    expect(findAiFallbackText("抱歉,AI暂时无法响应,请稍后重试.")).toBe(AI_FALLBACK_UNAVAILABLE);
    expect(findAiFallbackText("抱歉， AI 暂时无法响应， 请稍后重试。")).toBe(AI_FALLBACK_UNAVAILABLE);
  });
  it("isAiFallbackText: 整体是兜底文案 vs 正常内容里夹一句", () => {
    expect(isAiFallbackText(AI_FALLBACK_UNAVAILABLE)).toBe(true);
    expect(isAiFallbackText("```\n抱歉，AI暂时无法响应，请稍后重试。\n```")).toBe(true);
    expect(isAiFallbackText(NORMAL_BODY + AI_FALLBACK_UNAVAILABLE)).toBe(false); // 长正文夹一句 ≠ "调用没返回"
    expect(isAiFallbackText("")).toBe(false);
  });
  it("正常内容不会被误判", () => {
    expect(findAiFallbackText(NORMAL_BODY)).toBeNull();
    expect(findAiFallbackText("很抱歉，该刊今年已被剔除，请另选期刊，稍后我们会重试推荐。")).toBeNull();
  });
});

describe("⑧ toPlainText: 剥 SVG/style 后才算字数(模板 92% 是图表噪声)", () => {
  it("SVG/style/注释被剥掉", () => {
    const p = toPlainText(`<style>.a{color:red}</style><svg><path d="M0 0"/></svg><!--c--><p>正文可读文字</p>`);
    expect(p).toBe("正文可读文字");
  });
});
