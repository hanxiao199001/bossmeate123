/**
 * 故事叙述型期刊推荐模板（T4-3-2）
 *
 * 风格定位：与 'data-card'（数据驱动决策）形成鲜明对照——叙事驱动，适合新手投稿者。
 *
 * 结构（按渲染顺序）：
 *   1. 痛点开场      (大字 blockquote 引文)
 *   2. 故事背景      (一段引出期刊登场的研究者故事)
 *   3. 4 格小数据卡  (IF / 分区 / 录用率 / 审稿周期)
 *   4. 案例分析      (引用 1 条 PubMed 摘要，无则退化)
 *   5. 投稿建议      (• 项目符号列表，从 recommendation 派生)
 *   6. CTA           (灰背景居中行动号召)
 *   7. 底部封面图    (如 journal.coverUrl 存在)
 *
 * 微信兼容性约束（与 wechat-article-template 相同）：
 *   ✅ inline style only, section/p/table/img/blockquote
 *   ❌ flex / grid / class / id / position / @media
 *   ✅ ≥14px 字号，深色文字浅色背景
 *
 * 与 'data-card' 互换性：签名完全一致，registry 可无缝替换。
 */

import type { JournalInfo, CollectionResult } from "../../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "../../skills/journal-template.js";
import { esc } from "../../skills/journal-template.js";

type Abstracts = CollectionResult["abstracts"];

// ============ 工具：从 recommendation 文本派生项目符号清单 ============

/**
 * 把 AI 生成的 recommendation（自由文本，常含 1-3 句）拆成 3-5 条 actionable 短句。
 * - 优先按句号 / 分号切分
 * - 取前 5 条非空、非过短的
 * - 若不足 3 条，补默认 fallback 提示
 */
function deriveSubmissionTips(recommendation: string, journal: JournalInfo): string[] {
  const sentences = (recommendation || "")
    .split(/[。；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 80);

  const tips = sentences.slice(0, 5);

  if (tips.length < 3) {
    // fallback：用 journal 数据合成几条
    const fb: string[] = [];
    if (journal.acceptanceRate) {
      fb.push(`录用率约 ${(journal.acceptanceRate * 100).toFixed(0)}%，准备充分再投`);
    }
    if (journal.reviewCycle) {
      fb.push(`审稿周期 ${journal.reviewCycle}，注意时间规划`);
    }
    if (journal.casPartition || journal.partition) {
      fb.push(`属于 ${journal.casPartition || journal.partition} 区，匹配自己研究层次`);
    }
    fb.push("严格按目标期刊的格式规范排版，避免格式退稿");
    while (tips.length < 3 && fb.length > 0) {
      tips.push(fb.shift()!);
    }
  }

  return tips.slice(0, 5);
}

// ============ 区块 1: 痛点开场 ============

function renderPainPointHook(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  // 优先用 AI 给的 editorComment（口语化），否则按 journal 学科生成痛点
  const hook = aiContent.editorComment ||
    `还在为 ${journal.discipline || "学术"} 投稿屡屡被拒发愁？花了几个月写的论文，到底该投哪本期刊？`;

  return `<section style="margin:16px 0 20px 0;padding:18px 20px;background:#FFF8F0;border-left:4px solid #FF9800;border-radius:6px;">` +
    `<p style="margin:0;font-size:18px;line-height:1.7;color:#5D4037;font-weight:500;">💭 ${esc(hook)}</p>` +
    `</section>`;
}

// ============ 区块 2: 故事背景 + 期刊登场 ============

function renderStoryIntro(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  const journalName = esc(journal.nameEn || journal.name);
  const ifText = journal.impactFactor ? `IF ${journal.impactFactor}` : "高影响力";
  const partition = journal.casPartition || journal.partition;
  const partitionText = partition ? `${esc(partition)} 区期刊` : "权威期刊";

  // 用 scopeDescription 作为故事背景（如有），fallback 为合成开场
  const scope = aiContent.scopeDescription
    ? esc(aiContent.scopeDescription).slice(0, 150)
    : `专注于${esc(journal.discipline || "本领域")}前沿研究`;

  return `<section style="margin:0 0 20px 0;font-size:15px;line-height:1.8;color:#333;">` +
    `<p style="margin:0 0 10px 0;">某博士在选刊上犹豫半年，最终把目光锁定在一本叫 <strong style="color:#FF9800;">${journalName}</strong> 的${partitionText}（${ifText}）。</p>` +
    `<p style="margin:0;">这本期刊${scope}。今天我们就来看看，它凭什么值得投。</p>` +
    `</section>`;
}

// ============ 区块 3: 4 格小数据卡 ============

function renderCompactDataCard(journal: JournalInfo): string {
  const cells: Array<{ label: string; value: string; color: string }> = [
    {
      label: "IF",
      value: journal.impactFactor ? journal.impactFactor.toString() : "—",
      color: "#FF9800",
    },
    {
      label: "分区",
      value: journal.casPartition || journal.partition || "—",
      color: "#4CAF50",
    },
    {
      label: "录用率",
      value: journal.acceptanceRate ? `${(journal.acceptanceRate * 100).toFixed(0)}%` : "—",
      color: "#2196F3",
    },
    {
      label: "审稿周期",
      value: journal.reviewCycle || "—",
      color: "#9C27B0",
    },
  ];

  // 4 列 table，每格 25% 宽
  const tds = cells
    .map(
      (c) =>
        `<td style="width:25%;text-align:center;padding:14px 6px;background:#FAFAFA;border-radius:6px;vertical-align:top;">` +
          `<p style="margin:0 0 6px 0;font-size:13px;color:#999;">${esc(c.label)}</p>` +
          `<p style="margin:0;font-size:18px;font-weight:bold;color:${c.color};line-height:1.3;">${esc(c.value)}</p>` +
        `</td>`
    )
    .join(`<td style="width:6px;"></td>`);

  return `<section style="margin:0 0 24px 0;">` +
    `<table style="width:100%;border-collapse:collapse;table-layout:fixed;">` +
      `<tr>${tds}</tr>` +
    `</table>` +
    `</section>`;
}

// ============ 区块 4: 案例分析（PubMed 摘要引用） ============

function renderCaseAnalysis(abstracts: Abstracts | undefined): string {
  if (!abstracts || abstracts.length === 0) return "";

  const a = abstracts[0];
  const text = (a.abstractText || "").trim();
  if (!text || text.length < 60) return "";

  // 截到 200 字以内（避免太长破坏阅读节奏）
  const excerpt = text.length > 200 ? text.slice(0, 200) + "…" : text;

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 8px 0;font-size:15px;font-weight:600;color:#333;">📚 该刊近期发文样例</p>` +
    `<blockquote style="margin:0;padding:14px 18px;background:#F5F5F5;border-left:3px solid #BDBDBD;border-radius:4px;font-size:14px;line-height:1.7;color:#555;font-style:italic;">` +
      `<p style="margin:0 0 6px 0;font-weight:500;color:#333;font-style:normal;">${esc(a.title || "（未提供标题）")}</p>` +
      `<p style="margin:0;">${esc(excerpt)}</p>` +
    `</blockquote>` +
    `</section>`;
}

// ============ 区块 5: 投稿建议（• 项目符号） ============

function renderSubmissionTips(journal: JournalInfo, aiContent: AIGeneratedContent): string {
  const tips = deriveSubmissionTips(aiContent.recommendation || "", journal);

  const items = tips
    .map(
      (tip) =>
        `<p style="margin:0 0 8px 0;padding-left:18px;text-indent:-18px;font-size:15px;line-height:1.7;color:#333;">` +
          `<span style="color:#FF9800;font-weight:bold;">• </span>${esc(tip)}` +
        `</p>`
    )
    .join("");

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:15px;font-weight:600;color:#333;">✍️ 投稿建议</p>` +
    items +
    `</section>`;
}

// ============ 区块 6: CTA 行动号召 ============

function renderCTA(journal: JournalInfo): string {
  const journalName = esc(journal.nameEn || journal.name);

  return `<section style="margin:0 0 20px 0;padding:18px 20px;background:#F5F5F5;border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 6px 0;font-size:16px;font-weight:600;color:#333;">如果你正在准备投稿</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.7;color:#666;"><strong style="color:#FF9800;">${journalName}</strong> 值得列入第一梯队</p>` +
    `</section>`;
}

// ============ 区块 7: 底部封面图（可选） ============

function renderFooterCover(journal: JournalInfo): string {
  const cover = (journal as any).coverUrl || (journal as any).coverImageUrl;
  if (!cover) return "";

  const journalName = esc(journal.nameEn || journal.name);

  return `<section style="margin:0 0 20px 0;text-align:center;">` +
    `<img src="${esc(cover)}" style="max-width:160px;height:auto;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,0.12);display:block;margin:0 auto;" />` +
    `<p style="margin:8px 0 0 0;font-size:12px;color:#999;">${journalName} 期刊封面</p>` +
    `</section>`;
}

// ============ 主入口 ============

export async function generateStorytellingHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  abstracts?: Abstracts
): Promise<string> {
  const sections: string[] = [];

  sections.push(renderPainPointHook(journal, aiContent));
  sections.push(renderStoryIntro(journal, aiContent));
  sections.push(renderCompactDataCard(journal));

  const caseHtml = renderCaseAnalysis(abstracts);
  if (caseHtml) sections.push(caseHtml);

  sections.push(renderSubmissionTips(journal, aiContent));
  sections.push(renderCTA(journal));
  sections.push(renderFooterCover(journal));

  return sections.join("\n");
}
