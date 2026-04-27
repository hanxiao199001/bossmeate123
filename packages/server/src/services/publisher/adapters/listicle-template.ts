/**
 * 清单点评型期刊推荐模板（T4-3-3）
 *
 * 风格定位：与前两个模板形成第三种鲜明差异 —
 *   - data-card    数据驱动决策、信息密度大、正式
 *   - storytelling 叙事驱动、痛点带入、新手向
 *   - listicle     扫读友好、结构化、决策清单
 *
 * 设计调整说明：原 spec "对比清单型（本刊 vs 同类期刊）" 需要查 DB / 让 LLM 编同类
 * 期刊数据，违反"不让 LLM 编"原则。改为「清单点评型」—— 同样结构化、和前两个差距足够大。
 *
 * 结构（按渲染顺序）：
 *   1. 钩子标题            "X 期刊：5 大优势 + 3 个避雷"
 *   2. 4 格速览数据卡       (与 storytelling 同款简化 IF / 分区 / 录用率 / 审稿)
 *   3. ✅ 5 大优势         (clip-style item，每条加粗短句 + 描述)
 *   4. ⚠️ 3 个注意事项     (warning-style item)
 *   5. 🎯 适合人群（3 条）
 *   6. ❌ 不适合的情况（2 条）
 *   7. CTA + 底部封面图（如有）
 *
 * 微信兼容性约束：inline style only / table 布局 / ≥14px / 不用 flex/grid。
 *
 * 与 'data-card' / 'storytelling' 互换性：签名完全一致。
 */

import type { JournalInfo, CollectionResult } from "../../data-collection/journal-content-collector.js";
import type { AIGeneratedContent } from "../../skills/journal-template.js";
import { esc } from "../../skills/journal-template.js";

type Abstracts = CollectionResult["abstracts"];

// ============ 工具：从 AI recommendation + journal 数据派生清单条目 ============

/**
 * 从 AI recommendation 切句（句号/分号/换行/、）返回 8-80 字、非空、不重复的短句。
 */
function splitToShortItems(text: string): string[] {
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(/[。；;\n、]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && s.length <= 80)
    )
  );
}

/** 派生 5 大优势（清单永远不少于 5 条，不足时用 journal 数据合成） */
function deriveAdvantages(journal: JournalInfo, aiContent: AIGeneratedContent): string[] {
  const items: string[] = [];
  const aiItems = splitToShortItems(aiContent.recommendation || "");

  // 优先用正向语气的 AI 句子（包含"快/稳/广/高/友好/易/优/适合"等正向词）
  for (const s of aiItems) {
    if (/快|稳|广|高|友好|易|优|适合|推荐|质量|权威|学界|认可|被引/.test(s)) {
      items.push(s);
      if (items.length >= 5) break;
    }
  }

  // fallback：用 journal 数据合成
  if (items.length < 5) {
    const fb: string[] = [];
    if (journal.acceptanceRate && journal.acceptanceRate >= 0.4) {
      fb.push(`录用率约 ${(journal.acceptanceRate * 100).toFixed(0)}%，相对友好`);
    }
    if (journal.reviewCycle && /周|month|月/i.test(journal.reviewCycle)) {
      fb.push(`审稿周期 ${journal.reviewCycle}，进度可控`);
    }
    if (journal.casPartition || journal.partition) {
      fb.push(`属于 ${journal.casPartition || journal.partition} 区，学界认可度有保障`);
    }
    if (journal.impactFactor) {
      fb.push(`IF ${journal.impactFactor}，影响因子稳定`);
    }
    if (journal.discipline) {
      fb.push(`专注 ${journal.discipline} 方向，匹配度高`);
    }
    fb.push("发文范围广，覆盖多个细分方向");
    fb.push("国际可见度高，被引活跃");
    while (items.length < 5 && fb.length > 0) {
      const next = fb.shift()!;
      if (!items.includes(next)) items.push(next);
    }
  }

  return items.slice(0, 5);
}

/** 派生 3 个注意事项 */
function deriveCautions(journal: JournalInfo, aiContent: AIGeneratedContent): string[] {
  const items: string[] = [];
  const aiItems = splitToShortItems(aiContent.recommendation || "");

  // 负向语气句子
  for (const s of aiItems) {
    if (/慢|长|低|严|拒|高费|APC|风险|注意|避免|警惕|偏低|拒稿|退修/.test(s)) {
      items.push(s);
      if (items.length >= 3) break;
    }
  }

  // fallback
  if (items.length < 3) {
    const fb: string[] = [];
    if (journal.acceptanceRate && journal.acceptanceRate < 0.25) {
      fb.push(`录用率仅 ${(journal.acceptanceRate * 100).toFixed(0)}%，需准备充分`);
    }
    if (journal.apcFee && journal.apcFee > 1500) {
      fb.push(`APC 费用约 ${journal.apcFee} 美元，注意预算`);
    }
    if (journal.selfCitationRate && journal.selfCitationRate > 0.2) {
      fb.push(`自引率偏高，引用本刊文献时酌情把控`);
    }
    if (journal.isWarningList) {
      fb.push(`已被列入预警名单（${journal.warningYear || "近期"}），慎重投稿`);
    }
    fb.push("严格遵守目标期刊格式规范，避免格式退稿");
    fb.push("Cover Letter 要突出与该刊 scope 的契合");
    fb.push("数据完整性 / 伦理声明审核较严，提前准备好附件");
    while (items.length < 3 && fb.length > 0) {
      const next = fb.shift()!;
      if (!items.includes(next)) items.push(next);
    }
  }

  return items.slice(0, 3);
}

/** 派生 3 个适合人群 */
function deriveAudience(journal: JournalInfo): string[] {
  const items: string[] = [];

  if (journal.casPartition === "3" || journal.partition === "Q3" || journal.partition === "Q2") {
    items.push("即将毕业、需要稳妥发表的硕博生");
  } else if (journal.casPartition === "1" || journal.casPartition === "2" || journal.partition === "Q1") {
    items.push("追求高影响力、评职称需高分文章的科研工作者");
  }

  if (journal.acceptanceRate && journal.acceptanceRate >= 0.4) {
    items.push("初次投 SCI 想累积成功经验的青年作者");
  }
  if (journal.reviewCycle && /(2|3).*月|6.*周/i.test(journal.reviewCycle)) {
    items.push("时间紧张需要快速见刊的作者");
  }
  if (journal.discipline) {
    items.push(`专注 ${journal.discipline} 方向、需要对口期刊的研究者`);
  }
  // 兜底
  items.push("国基资助文章发表的科研团队");
  items.push("希望国际同行可见、提升学术影响力的作者");

  // 去重 + 限 3 条
  return Array.from(new Set(items)).slice(0, 3);
}

/** 派生 2 个不适合的情况 */
function deriveNotFor(journal: JournalInfo): string[] {
  const items: string[] = [];

  if (journal.impactFactor && journal.impactFactor >= 6) {
    items.push("数据量小、创新点不强的早期工作");
  }
  if (journal.casPartition === "1" || journal.partition === "Q1") {
    items.push("方法学层面不严谨、缺乏对照实验的稿件");
  }
  if (journal.discipline) {
    items.push(`非 ${journal.discipline} 主流方向、跨学科性过强的工作`);
  }
  items.push("时间紧迫但稿件还需要重大修改的情况");

  return Array.from(new Set(items)).slice(0, 2);
}

// ============ 区块 1: 钩子标题 ============

function renderHookTitle(journal: JournalInfo): string {
  const journalName = esc(journal.nameEn || journal.name);
  return `<section style="margin:16px 0 18px 0;padding:14px 18px;background:linear-gradient(135deg,#1976D2,#42A5F5);border-radius:8px;text-align:center;">` +
    `<p style="margin:0;font-size:18px;font-weight:bold;color:#FFFFFF;line-height:1.5;">📋 ${journalName}：5 大优势 + 3 个避雷</p>` +
    `</section>`;
}

// ============ 区块 2: 4 格速览数据卡（同 storytelling 模板风格保持一致性） ============

function renderQuickGlanceCard(journal: JournalInfo): string {
  const cells: Array<{ label: string; value: string; color: string }> = [
    { label: "IF", value: journal.impactFactor ? journal.impactFactor.toString() : "—", color: "#1976D2" },
    { label: "分区", value: journal.casPartition || journal.partition || "—", color: "#388E3C" },
    { label: "录用率", value: journal.acceptanceRate ? `${(journal.acceptanceRate * 100).toFixed(0)}%` : "—", color: "#F57C00" },
    { label: "审稿周期", value: journal.reviewCycle || "—", color: "#7B1FA2" },
  ];

  const tds = cells
    .map(
      (c) =>
        `<td style="width:25%;text-align:center;padding:14px 6px;background:#FAFAFA;border-radius:6px;vertical-align:top;">` +
          `<p style="margin:0 0 6px 0;font-size:13px;color:#999;">${esc(c.label)}</p>` +
          `<p style="margin:0;font-size:18px;font-weight:bold;color:${c.color};line-height:1.3;">${esc(c.value)}</p>` +
        `</td>`
    )
    .join(`<td style="width:6px;"></td>`);

  return `<section style="margin:0 0 22px 0;">` +
    `<table style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>${tds}</tr></table>` +
    `</section>`;
}

// ============ 通用清单条目渲染 ============

function renderListBlock(
  emoji: string,
  heading: string,
  items: string[],
  accentColor: string
): string {
  if (items.length === 0) return "";

  const liItems = items
    .map(
      (text, idx) =>
        `<p style="margin:0 0 10px 0;padding:10px 14px;background:#FAFAFA;border-left:3px solid ${accentColor};border-radius:4px;font-size:15px;line-height:1.7;color:#333;">` +
          `<span style="display:inline-block;min-width:22px;font-weight:bold;color:${accentColor};">${idx + 1}.</span>` +
          esc(text) +
        `</p>`
    )
    .join("");

  return `<section style="margin:0 0 22px 0;">` +
    `<p style="margin:0 0 10px 0;font-size:16px;font-weight:600;color:#333;">${emoji} ${esc(heading)}</p>` +
    liItems +
    `</section>`;
}

// ============ 区块 7: CTA + 底部封面 ============

function renderCTA(journal: JournalInfo, audience: string[]): string {
  const journalName = esc(journal.nameEn || journal.name);
  const audienceHint = audience[0] ? esc(audience[0]) : "目标投稿人";

  return `<section style="margin:0 0 16px 0;padding:16px 18px;background:#F5F5F5;border-radius:8px;text-align:center;">` +
    `<p style="margin:0 0 6px 0;font-size:15px;font-weight:600;color:#333;">综合来看</p>` +
    `<p style="margin:0;font-size:14px;line-height:1.7;color:#555;">` +
      `<strong style="color:#1976D2;">${journalName}</strong> 适合：${audienceHint}` +
    `</p>` +
    `</section>`;
}

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

export async function generateListicleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  _abstracts?: Abstracts
): Promise<string> {
  const sections: string[] = [];

  const advantages = deriveAdvantages(journal, aiContent);
  const cautions = deriveCautions(journal, aiContent);
  const audience = deriveAudience(journal);
  const notFor = deriveNotFor(journal);

  sections.push(renderHookTitle(journal));
  sections.push(renderQuickGlanceCard(journal));
  sections.push(renderListBlock("✅", "5 大优势", advantages, "#388E3C"));
  sections.push(renderListBlock("⚠️", "3 个注意事项", cautions, "#F57C00"));
  sections.push(renderListBlock("🎯", "适合人群", audience, "#1976D2"));
  sections.push(renderListBlock("❌", "不适合的情况", notFor, "#D32F2F"));
  sections.push(renderCTA(journal, audience));
  sections.push(renderFooterCover(journal));

  return sections.join("\n");
}
