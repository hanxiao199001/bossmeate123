/**
 * 多刊盘点型公众号模板 (学同行"顾老论文说"风格).
 * 题材: 人群痛点种草 + N 本刊盘点 + 投稿经验 + 私信 CTA. 与现有"单刊数据权威"模板形成第 5 种鲜明差异.
 * 微信安全: <section> + inline style, emoji 直接 Unicode, 无 flex/transform/class.
 */

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const C = {
  num: "#F2C94C",      // 编号角标 橙黄
  numText: "#fff",
  name: "#2F6FB0",     // 刊名 蓝
  heading: "#222",     // 小标题
  body: "#333",        // 正文
  sub: "#888",         // 次要
  bg: "#fafafa",
};

export interface RoundupJournalItem {
  index: number;
  name: string;                 // 《教育发展研究》(自带书名号或不带都行)
  coverUrl?: string | null;
  intro: string;                // 期刊简介段
  experienceParas: string[];    // 投稿经验段落
  directions?: string[];        // 方向匹配清单 (• )
}
export interface RoundupData {
  title: string;
  authorMeta?: string;          // 原创 · 公众号名 · 日期 · 地点
  openingParas: string[];       // 痛点开场段落
  openingQuestions?: string[];  // 👉 问题
  items: RoundupJournalItem[];
  whyTitle?: string;
  whyParas?: string[];
  whyBullets?: string[];
  pitfallTitle?: string;
  pitfallParas?: string[];
  pitfallPoints?: string[];     // 👉 误区
  reminderTitle?: string;
  reminderParas?: string[];
  ctaLines?: string[];          // ✅ ...
}

function p(text: string): string {
  return `<p style="margin:14px 0;font-size:16px;line-height:1.9;color:${C.body};">${esc(text)}</p>`;
}
function pointer(text: string): string {
  return `<p style="margin:10px 0;font-size:16px;line-height:1.8;color:${C.body};">👉 ${esc(text)}</p>`;
}
function bullets(items: string[]): string {
  return `<section style="margin:10px 0;">` + items.map((b) =>
    `<p style="margin:6px 0;font-size:16px;line-height:1.7;color:${C.body};">• ${esc(b)}</p>`).join("") + `</section>`;
}
function sectionTag(num: number, name: string): string {
  // 编号角标 (橙黄方块, 微信不支持 skew 故用圆角块) + 蓝色刊名居中
  return `<section style="margin:36px 0 16px 0;text-align:center;">` +
    `<span style="display:inline-block;background:${C.num};color:${C.numText};font-size:18px;font-weight:bold;padding:4px 14px;border-radius:3px;letter-spacing:1px;">${String(num).padStart(2, "0")}</span>` +
    `<p style="margin:12px 0 0 0;font-size:20px;font-weight:bold;color:${C.name};">${esc(name)}</p>` +
    `</section>`;
}
function miniHeading(text: string): string {
  return `<p style="margin:18px 0 6px 0;font-size:16px;font-weight:bold;color:${C.heading};">◦ ${esc(text)}</p>`;
}
function cover(url?: string | null): string {
  if (!url) return "";
  return `<section style="margin:12px 0;text-align:center;"><img src="${esc(url)}" style="max-width:100%;width:auto;height:auto;border-radius:8px;display:block;margin:0 auto;" /></section>`;
}

export function generateJournalRoundupHtml(data: RoundupData): string {
  const out: string[] = [];
  out.push(`<section style="font-size:16px;color:${C.body};">`);
  // 大标题
  out.push(`<h1 style="margin:8px 0;font-size:22px;font-weight:bold;line-height:1.5;color:#111;">${esc(data.title)}</h1>`);
  if (data.authorMeta) out.push(`<p style="margin:0 0 18px 0;font-size:13px;color:${C.sub};">${esc(data.authorMeta)}</p>`);
  // 痛点开场
  for (const para of data.openingParas) out.push(p(para));
  if (data.openingQuestions) for (const q of data.openingQuestions) out.push(pointer(q));
  // 各刊盘点
  for (const it of data.items) {
    out.push(sectionTag(it.index, it.name));
    out.push(cover(it.coverUrl));
    out.push(miniHeading("期刊简介"));
    out.push(p(it.intro));
    out.push(miniHeading("投稿经验"));
    for (const para of it.experienceParas) out.push(p(para));
    if (it.directions && it.directions.length) out.push(bullets(it.directions));
  }
  // 为什么适合
  if (data.whyTitle) {
    out.push(sectionTag(data.items.length + 1, data.whyTitle));
    for (const para of data.whyParas ?? []) out.push(p(para));
    if (data.whyBullets?.length) out.push(bullets(data.whyBullets));
  }
  // 误区
  if (data.pitfallTitle) {
    out.push(sectionTag(data.items.length + 2, data.pitfallTitle));
    for (const para of data.pitfallParas ?? []) out.push(p(para));
    for (const pt of data.pitfallPoints ?? []) out.push(pointer(pt));
  }
  // 提醒
  if (data.reminderTitle) {
    out.push(sectionTag(data.items.length + 3, data.reminderTitle));
    for (const para of data.reminderParas ?? []) out.push(p(para));
  }
  // CTA
  if (data.ctaLines?.length) {
    out.push(`<section style="margin:28px 0 8px 0;padding:18px;background:${C.bg};border-radius:10px;">`);
    for (const line of data.ctaLines) out.push(`<p style="margin:8px 0;font-size:15px;line-height:1.7;color:${C.body};">✅ ${esc(line)}</p>`);
    out.push(`</section>`);
  }
  out.push(`</section>`);
  return out.join("\n");
}
