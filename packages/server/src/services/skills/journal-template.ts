/**
 * 期刊推荐文章模板 V6 —— 顺仕美途风格
 *
 * 参照"顺仕美途科研服务平台"公众号的期刊推荐文章格式，
 * 生成完整的期刊推荐文章 HTML。
 *
 * 数据来源：journals 表真实数据 + AI 生成（标题、收稿范围、推荐语）
 *
 * 文章结构：
 * 1. 今日期刊推荐标题头
 * 2. 基本信息表（名称、简称、ISSN、出版商、官网等）
 * 3. 影响因子趋势 + 分区信息
 * 4. 期刊分区详情（JCR + 中科院）
 * 5. 发文情况（年发文量、录用率、投稿机构）
 * 6. 收稿范围（AI 生成）
 * 7. 版面费
 * 8. 审稿周期
 * 9. 自引率
 * 10. 预警名单状态
 * 11. 推荐指数 + 总结（AI 生成）
 */

import type { JournalInfo, CollectionResult } from "../data-collection/journal-content-collector.js";

// ============ AI 生成内容接口 ============

export interface AIGeneratedContent {
  title: string;           // 吸引眼球的文章标题
  scopeDescription: string; // 收稿范围描述
  recommendation: string;   // 推荐指数+总结
  ifPrediction?: string;    // IF 预测语句（如 "预测今年涨至15"）
  rating?: number;          // 推荐星级 1-5
}

// ============ 主入口 ============

/**
 * 生成完整的期刊推荐文章 HTML
 */
export function generateJournalArticleHtml(
  journal: JournalInfo,
  aiContent: AIGeneratedContent,
  abstracts?: CollectionResult["abstracts"]
): string {
  const sections: string[] = [];

  // 1. 今日期刊推荐头部
  sections.push(buildHeader(journal));

  // 2. 基本信息表
  sections.push(buildBasicInfoTable(journal));

  // 3. 影响因子 + 分区概览
  sections.push(buildIFAndPartitionOverview(journal, aiContent));

  // 4. 期刊分区详情
  sections.push(buildPartitionDetail(journal));

  // 5. 发文情况
  sections.push(buildPublicationStats(journal));

  // 6. 收稿范围
  if (aiContent.scopeDescription) {
    sections.push(buildScopeSection(journal, aiContent.scopeDescription));
  }

  // 7. 版面费
  sections.push(buildAPCSection(journal));

  // 8. 审稿周期
  sections.push(buildReviewCycleSection(journal));

  // 9. 自引率
  if (journal.selfCitationRate != null) {
    sections.push(buildSelfCitationSection(journal));
  }

  // 10. 预警名单
  sections.push(buildWarningSection(journal));

  // 11. 推荐指数 + 总结
  sections.push(buildRecommendationSection(journal, aiContent));

  // 12. 尾部签名
  sections.push(buildFooter());

  return `<div style="max-width:680px;margin:0 auto;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;color:#333;line-height:1.8;font-size:15px;">\n${sections.filter(Boolean).join("\n")}\n</div>`;
}

// ============ 兼容旧接口 ============

export function generateJournalSectionHtml(
  journalData: CollectionResult,
  options?: { showAbstracts?: boolean; maxAbstracts?: number }
): string {
  if (!journalData || journalData.journals.length === 0) return "";
  // 旧接口降级：用默认 AI 内容
  const journal = journalData.journals[0];
  const defaultAI: AIGeneratedContent = {
    title: `期刊推荐：${journal.name}`,
    scopeDescription: "",
    recommendation: "",
  };
  return generateJournalArticleHtml(journal, defaultAI, journalData.abstracts);
}

// ============ 各段落构建 ============

function buildHeader(j: JournalInfo): string {
  const displayName = j.nameEn || j.name;
  return `
<div style="text-align:center;padding:28px 20px 20px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:12px;margin-bottom:24px;">
  <p style="font-size:14px;color:rgba(255,255,255,0.85);margin:0 0 8px;letter-spacing:2px;">今 日 期 刊 推 荐</p>
  <h1 style="font-size:24px;color:#fff;margin:0 0 6px;font-weight:bold;">${esc(displayName)}</h1>
  ${j.abbreviation ? `<p style="font-size:14px;color:rgba(255,255,255,0.8);margin:0;">简称：${esc(j.abbreviation)}</p>` : ""}
</div>`;
}

function buildBasicInfoTable(j: JournalInfo): string {
  const displayName = j.nameEn || j.name;
  const rows: string[] = [];

  rows.push(infoRow("期刊全称", displayName));
  if (j.nameEn && j.name !== j.nameEn) rows.push(infoRow("中文名称", j.name));
  if (j.abbreviation) rows.push(infoRow("简称", j.abbreviation));
  if (j.foundingYear) rows.push(infoRow("创刊时间", `${j.foundingYear}年`));
  if (j.country) rows.push(infoRow("出版国家", j.country));
  if (j.publisher) rows.push(infoRow("出版商", j.publisher));
  if (j.issn) rows.push(infoRow("ISSN", j.issn));
  if (j.website) rows.push(infoRow("期刊官网", `<a href="${esc(j.website)}" style="color:#4f46e5;text-decoration:underline;">${esc(j.website)}</a>`));

  return `
<div style="margin-bottom:24px;">
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>
</div>`;
}

function buildIFAndPartitionOverview(j: JournalInfo, ai: AIGeneratedContent): string {
  const ifText = j.impactFactor != null ? j.impactFactor.toFixed(1) : "暂无";
  const ifColor = getIfColor(j.impactFactor);

  let content = `《${esc(j.nameEn || j.name)}》`;
  if (j.impactFactor != null) {
    content += `最新影响因子为 <strong style="color:${ifColor};font-size:18px;">${ifText}</strong> 分`;
    if (ai.ifPrediction) content += `（${esc(ai.ifPrediction)}）`;
    content += `！`;
  }

  if (j.casPartition) {
    content += `中科院分区 <strong>${esc(j.casPartition)}</strong>`;
    if (j.casPartitionNew) content += `（新锐分区 <strong>${esc(j.casPartitionNew)}</strong>）`;
    content += `。`;
  } else if (j.partition) {
    content += `JCR 分区 <strong style="color:${getPartitionColor(j.partition)};">${esc(j.partition)}</strong>。`;
  }

  if (j.discipline) {
    content += `是${esc(j.discipline)}领域的`;
    if (j.impactFactor && j.impactFactor >= 10) content += `国际权威期刊`;
    else if (j.impactFactor && j.impactFactor >= 5) content += `高水平期刊`;
    else content += `重要学术期刊`;
  }

  if (j.publisher) content += `，由 ${esc(j.publisher)} 出版。`;

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("影响因子与分区")}
  <div style="padding:16px;background:#fffbeb;border-radius:8px;border-left:4px solid ${ifColor};">
    <p style="margin:0;line-height:1.8;">${content}</p>
  </div>
</div>`;
}

function buildPartitionDetail(j: JournalInfo): string {
  const items: string[] = [];

  // JCR 分区
  if (j.partition) {
    items.push(`<strong>JCR 分区：</strong><span style="color:${getPartitionColor(j.partition)};font-weight:bold;">${esc(j.partition)}</span>`);
  }

  // JCR 学科详情
  if (j.jcrSubjects) {
    try {
      const subjects = JSON.parse(j.jcrSubjects) as Array<{ subject: string; rank: string; position?: string }>;
      for (const s of subjects) {
        const posText = s.position ? `（${s.position}）` : "";
        items.push(`${esc(s.subject)}：<strong style="color:${getPartitionColor(s.rank)};">${esc(s.rank)}</strong>${posText}`);
      }
    } catch { /* skip */ }
  }

  // 中科院分区
  if (j.casPartition) {
    items.push(`<strong>中科院分区：</strong>${esc(j.casPartition)}`);
  }
  if (j.casPartitionNew) {
    items.push(`<strong>新锐分区：</strong>${esc(j.casPartitionNew)}`);
  }

  if (items.length === 0) return "";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("期刊分区")}
  <div style="padding:16px;background:#f8fafc;border-radius:8px;">
    ${items.map(item => `<p style="margin:0 0 6px;font-size:14px;">${item}</p>`).join("\n    ")}
  </div>
</div>`;
}

function buildPublicationStats(j: JournalInfo): string {
  const parts: string[] = [];

  parts.push(`《${esc(j.nameEn || j.name)}》`);

  if (j.annualVolume) {
    parts.push(`近年年发文量约 <strong>${j.annualVolume}</strong> 篇`);
  }

  if (j.acceptanceRate != null) {
    const ratePercent = j.acceptanceRate >= 1 ? j.acceptanceRate : j.acceptanceRate * 100;
    parts.push(`整体录用率约为 <strong>${ratePercent.toFixed(0)}%</strong>`);
  }

  // 投稿机构
  let institutionsHtml = "";
  if (j.topInstitutions) {
    try {
      const institutions = JSON.parse(j.topInstitutions) as string[];
      if (institutions.length > 0) {
        institutionsHtml = `<p style="margin:8px 0 0;font-size:14px;color:#555;">国内投稿活跃机构：${institutions.map(i => esc(i)).join("、")}等。</p>`;
      }
    } catch { /* skip */ }
  }

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("发文情况")}
  <div style="padding:16px;background:#f8fafc;border-radius:8px;">
    <p style="margin:0;line-height:1.8;">${parts.join("，")}。</p>
    ${institutionsHtml}
  </div>
</div>`;
}

function buildScopeSection(_j: JournalInfo, scopeDescription: string): string {
  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("收稿范围")}
  <div style="padding:16px;background:#f8fafc;border-radius:8px;line-height:2;">
    ${scopeDescription}
  </div>
</div>`;
}

function buildAPCSection(j: JournalInfo): string {
  if (!j.apcFee) return "";

  const cnyEstimate = Math.round(j.apcFee * 7.2); // 估算人民币

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("版面费")}
  <div style="padding:16px;background:#f8fafc;border-radius:8px;">
    <p style="margin:0;line-height:1.8;">
      《${esc(j.nameEn || j.name)}》需支付版面费 <strong>$${j.apcFee.toLocaleString()}</strong>（约合人民币 <strong>${cnyEstimate.toLocaleString()}</strong> 元）。
      作为开放获取期刊，读者可免费访问所有文章，有利于研究成果的广泛传播和引用。
    </p>
  </div>
</div>`;
}

function buildReviewCycleSection(j: JournalInfo): string {
  if (!j.reviewCycle) return "";

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("审稿周期")}
  <div style="padding:16px;background:#f0fdf4;border-radius:8px;border-left:4px solid #22c55e;">
    <p style="margin:0;line-height:1.8;">
      《${esc(j.nameEn || j.name)}》审稿周期：<strong style="color:#16a34a;">${esc(j.reviewCycle)}</strong>。
    </p>
  </div>
</div>`;
}

function buildSelfCitationSection(j: JournalInfo): string {
  if (j.selfCitationRate == null) return "";

  const rate = j.selfCitationRate;
  const safe = rate < 20;

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("自引率")}
  <div style="padding:16px;background:#f8fafc;border-radius:8px;">
    <p style="margin:0;">
      ${esc(j.nameEn || j.name)} 自引率为 <strong>${rate.toFixed(1)}%</strong>，
      ${safe ? `处于安全范围，可放心投稿。` : `偏高，投稿时需关注。`}
    </p>
  </div>
</div>`;
}

function buildWarningSection(j: JournalInfo): string {
  if (j.isWarningList) {
    return `
<div style="margin-bottom:24px;">
  ${sectionTitle("预警名单")}
  <div style="padding:16px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
    <p style="margin:0;color:#dc2626;font-weight:bold;">
      ⚠️ 该期刊在中科院《国际期刊预警名单》中${j.warningYear ? `（${esc(j.warningYear)} 版）` : ""}，投稿需谨慎评估。
    </p>
  </div>
</div>`;
  }

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("预警名单")}
  <div style="padding:16px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
    <p style="margin:0;color:#16a34a;">
      ✅ 中科院《国际期刊预警名单》：<strong>不在预警名单中</strong>，可放心投稿。
    </p>
  </div>
</div>`;
}

function buildRecommendationSection(j: JournalInfo, ai: AIGeneratedContent): string {
  const rating = ai.rating || 4;
  const stars = "☆".repeat(rating);
  const emptyStars = "☆".repeat(5 - rating);

  return `
<div style="margin-bottom:24px;">
  ${sectionTitle("推荐指数")}
  <div style="padding:20px;background:linear-gradient(135deg,#fef3c7 0%,#fde68a 100%);border-radius:8px;">
    <p style="font-size:20px;margin:0 0 12px;text-align:center;">
      <span style="color:#f59e0b;">${stars}</span><span style="color:#d1d5db;">${emptyStars}</span>
    </p>
    <div style="font-size:14px;line-height:2;color:#44403c;">
      ${ai.recommendation || ""}
    </div>
  </div>
</div>`;
}

function buildFooter(): string {
  return `
<div style="text-align:center;padding:20px 0;border-top:1px solid #e5e7eb;margin-top:8px;">
  <p style="font-size:12px;color:#9ca3af;margin:0;">以上分析仅供参考，数据来源：LetPub、Springer Nature、PubMed</p>
  <p style="font-size:12px;color:#9ca3af;margin:4px 0 0;">由 BossMate AI 超级员工自动生成</p>
</div>`;
}

// ============ 工具函数 ============

function sectionTitle(title: string): string {
  return `<h3 style="font-size:17px;color:#1e293b;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid #e2e8f0;font-weight:bold;">📌 ${esc(title)}</h3>`;
}

function infoRow(label: string, value: string): string {
  return `<tr>
        <td style="padding:10px 14px;font-weight:bold;color:#64748b;white-space:nowrap;border-bottom:1px solid #f1f5f9;width:90px;font-size:13px;">${esc(label)}</td>
        <td style="padding:10px 14px;color:#1e293b;border-bottom:1px solid #f1f5f9;font-size:14px;">${value}</td>
      </tr>`;
}

function getIfColor(impactFactor: number | null): string {
  if (impactFactor == null) return "#6b7280";
  if (impactFactor >= 20) return "#dc2626";
  if (impactFactor >= 10) return "#ea580c";
  if (impactFactor >= 5) return "#059669";
  return "#2563eb";
}

function getPartitionColor(partition: string): string {
  if (partition.includes("Q1") || partition.includes("1区")) return "#dc2626";
  if (partition.includes("Q2") || partition.includes("2区")) return "#ea580c";
  if (partition.includes("Q3") || partition.includes("3区")) return "#ca8a04";
  return "#6b7280";
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
