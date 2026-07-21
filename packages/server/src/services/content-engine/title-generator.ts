/**
 * 6-25 标题生成器 —— 按「Paper咨询与发表-SCI期刊推荐」的标题 DNA 产候选标题。
 *   标题是一张"利益清单",不卖文采卖确定性。喂期刊真实数据 → LLM 产 N 个候选。
 *   红线: 只用传入的真实数据, 绝不编造 IF/分区/审稿/录用率 等任何数字。
 */
import { chat } from "../ai/chat-service.js";
import { logger } from "../../config/logger.js";
import { exhaustedKeys, recordUsage, usageCount } from "./usage-rotation.js";

// 7-03 ④: 标题"狠话"标签 — 按人设分级 + 批次内轮换（治"全员闭眼冲"）
const AGGRESSIVE_TITLE_TAGS = ["闭眼冲", "闭眼投", "沾边就收", "有手就发", "水刊", "灌水神刊", "捡漏"] as const;

/** 人设分级: strict(编辑/老师/学术号)禁狠话; aggressive(营销/研究生党号)放开; default(无人设)允许但降频 */
export function classifyPersonaTone(persona?: string | null): "strict" | "aggressive" | "default" {
  if (!persona || !persona.trim()) return "default";
  if (/编辑|老师|导师|教授|审稿|学术顾问|严谨|权威|专业机构/.test(persona)) return "strict";
  if (/营销|研究生|硕博|学生|毕业党|接地气|爆款|狠|带货/.test(persona)) return "aggressive";
  return "default";
}

export interface TitleJournalData {
  name?: string | null;        // 中文名/英文名
  nameEn?: string | null;
  publisher?: string | null;
  casPartition?: string | null; // 中科院分区(如 "工程技术2区")
  jcrPartition?: string | null; // JCR(如 "ENGINEERING Q1")
  impactFactor?: number | string | null;
  ifTrend?: string | null;      // 趋势(如 "预测今年涨至8.5")
  reviewCycle?: string | null;  // 审稿周期(如 "首次决定约3天")
  acceptanceRate?: number | string | null; // 录用率
  selfCitationRate?: number | string | null; // 自引率
  apc?: string | null;          // 版面费(如 "约$2120" / "免版面费")
  warning?: string | null;      // 预警(如 "无预警" / "曾预警已整改")
  discipline?: string | null;
  yearPublished?: number | string | null; // 年发文量
  extra?: string | null;        // 其它卖点(国人友好/创刊年等)
  catalogs?: string[] | null;   // 7-21: 中文核心目录标签(pku-core/cssci/cscd..) — 判国内刊 + 身份卖点
  cscdLevel?: string | null;    // CSCD 核心库/扩展库
}

const TITLE_DNA = `你是"Paper咨询与发表-SCI期刊推荐"公众号的标题手。你的标题是一张"利益清单",不卖文采,卖"投这本能得到什么"的确定性。

【硬性规则】
1. 以"钩子型"为主(卖点机关枪式堆叠、带感叹号、无"期刊解读"前缀);5个里可给1个"解读型"(以「期刊解读:中科院<真实分区>《英文名》…」开头,理性权威;<真实分区>必须替换成下方数据里的"中科院分区"原文,如"数学2区",严禁原样输出占位符)。
2. 钩子型公式: 〔痛点 或 一个具体数字开头〕→〔3-4个硬卖点,用逗号/顿号串起来〕→〔身份召唤(毕业党/评职称/青椒/硕博生)〕→〔行动指令(闭眼冲/必看/值得冲)〕+ 感叹号。
3. 指标必须写成下方数据里的**真实数值本身**: 把"影响因子高"换成该刊真实 IF 数字, 把"审稿快"换成该刊真实审稿天数, 把"录用率高"换成该刊真实录用率。禁止用形容词代替数字, 更禁止写出任何没被真实数值替换掉的占位形式。
4. 长度 30-45 字。
5. 六个利益维度按需打中3-4个: 分区/IF权威、低门槛好发、审稿快、免版面费、毕业评职痛点、低风险(无预警/自引率低)。
6. 语感口语化+适度夸张标签(可用: 毕业神刊/闭眼投/水刊/天花板/救命稻草/捡漏/灌水神刊/青椒/沾边就收/有手就发/光速审稿/黑马),自然为主,别每个标题都堆满。

【红线】只能用下面给你的真实数据。绝不编造 IF/分区/审稿周期/录用率/自引率/版面费 等任何数字或事实。某维度没给数据就不写它,严禁瞎填。
🚫 标题里严禁出现**任何**字面占位符 —— 包括但不限于 "X.X"/"X天"/"X%"/"$X"/"N天"/"X区"/"N区"/"<真实分区>"/"<分区>"。
   所有指标一律用下方数据的真实数值原文(分区如"数学2区", IF 如"3.2");某项没给数据, 就整个卖点不写, 绝不留占位符。
   (7-14/6-30 生产事故: 标题"IF X.X+1区化学,审稿2.8个月"直接带着占位符流到可发布状态, 共 4 条。)

【输出】严格输出 JSON 数组,N 个标题字符串,不要任何解释或多余文字。例: ["标题1","标题2", ...]`;

function fmt(label: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  return `${label}: ${v}\n`;
}

/** 产 count 个候选标题。journal 只填有真实数据的字段, 缺的留空(不会被瞎编)。 */
export async function generateTitles(opts: {
  tenantId: string;
  userId: string;
  journal: TitleJournalData;
  styleProfile?: string | null;
  /** 7-03 ④: 账号人设原文 — 决定狠话标签是否可用（编辑/学术号禁, 营销/学生号放开） */
  persona?: string | null;
  /** 7-03 ④: 措辞轮换 scope（batchId/accountId）— 同 scope 当天每个狠话标签限用, 防全批"闭眼冲" */
  rotationScope?: string | null;
  count?: number;
}): Promise<string[]> {
  const { tenantId, userId, journal } = opts;
  const count = opts.count ?? 5;
  // 7-21 改动3: 国内刊 = 有中文核心目录标签 且 无国际 IF。国际刊完全不进此分支。
  const cats = journal.catalogs || [];
  const hasIf = journal.impactFactor != null && journal.impactFactor !== "" && !String(journal.impactFactor).includes("未知");
  const isDomestic = cats.length > 0 && !hasIf;

  // 国内刊: 只喂身份/学科(它真有的), 不喂 IF/分区/审稿/录用率(它没有, 喂了标题就编)
  const idTags: string[] = [];
  if (cats.includes("pku-core")) idTags.push("北大核心");
  if (cats.includes("cssci")) idTags.push("CSSCI来源期刊");
  if (cats.includes("cssci-ext")) idTags.push("CSSCI扩展版");
  if (cats.includes("cscd")) idTags.push(`CSCD${journal.cscdLevel ? journal.cscdLevel : ""}`);
  const data = isDomestic
    ? fmt("期刊名称", journal.name) + fmt("核心收录身份", idTags.join("、")) +
      fmt("学科", journal.discipline) + fmt("出版社", journal.publisher) + fmt("其它卖点", journal.extra)
    : fmt("期刊名称", journal.name) + fmt("英文名", journal.nameEn) + fmt("出版社", journal.publisher) +
      fmt("中科院分区", journal.casPartition) + fmt("JCR分区", journal.jcrPartition) +
      fmt("影响因子", journal.impactFactor) + fmt("IF趋势", journal.ifTrend) +
      fmt("审稿周期", journal.reviewCycle) + fmt("录用率", journal.acceptanceRate) +
      // 7-03 选B: 自引率(OpenAlex派生)PR#210已从正文下线为不可靠 → 标题也不再用, 避免标题吹正文兑现不了的数
      fmt("版面费", journal.apc) +
      fmt("预警情况", journal.warning) + fmt("领域", journal.discipline) +
      fmt("年发文量", journal.yearPublished) + fmt("其它卖点", journal.extra);

  // 7-03 ④: 人设分级 + 批次内措辞轮换
  const tone = classifyPersonaTone(opts.persona);
  const scope = opts.rotationScope || "";
  let toneSuffix = "";
  if (tone === "strict") {
    toneSuffix = `\n\n【人设约束(优先级最高)】本账号是编辑/学术型人设: 🚫 严禁使用"${AGGRESSIVE_TITLE_TAGS.join("/")}/毕业神刊/有手就发"等夸张狠话标签; 行动指令改用"值得认真考虑/建议重点关注/可列入备选"等稳健表述。仍要有钩子和具体数字, 但语气克制专业。`;
  } else {
    // aggressive(营销/学生号)限用 2 次/天/scope; default(无人设)允许但降频 1 次/天/scope
    const limit = tone === "aggressive" ? 2 : 1;
    const banned = scope ? exhaustedKeys(scope, [...AGGRESSIVE_TITLE_TAGS], limit) : [];
    if (banned.length > 0) {
      toneSuffix = `\n\n【措辞轮换】以下夸张措辞今天本批次已用满, 本次标题严禁出现: ${banned.join("、")}。换其它卖点表述, 别的规则不变。`;
    }
  }
  // 7-21 改动3: 国内刊标题禁用 IF/分区/录用率钩子(它没有这些数据), 改用真钩子: 权威身份+学科+投稿友好
  const domesticTitleRule = isDomestic ? `\n\n## ⚠️ 本刊是国内核心期刊 — 标题口径特殊
本刊**没有** IF、中科院分区、JCR分区、精确录用率、精确审稿天数。🚫 标题里**绝对禁止**出现 IF 数字、"X区"/"中科院X区"/"JCR Qx"、录用率百分比、审稿天数 —— 这些本刊没有, 写了就是编造, 会被校验拦下转人工, 这个标题白做。
国内核心刊标题用**真钩子**: ①权威身份(${idTags.join("、") || "国内核心"}, 是评职称/毕业的硬通货) ②学科对口(${journal.discipline || "本学科"}方向) ③投稿友好(适合谁投/毕业评职称适用)。
公式仍是"痛点/身份切入 → 硬卖点 → 身份召唤 → 行动指令", 只是硬卖点换成身份+学科, 不用数字。` : "";
  const system = (opts.styleProfile ? `${TITLE_DNA}\n\n【该号补充风格】\n${opts.styleProfile}` : TITLE_DNA) + domesticTitleRule + toneSuffix;
  const message = `期刊真实数据(只用这些, 缺的不写):\n${data}\n请按上述风格产 ${count} 个候选标题, 严格 JSON 数组输出。`;

  const resp = await chat({ tenantId, userId, conversationId: `title-gen-${Date.now()}`, message, skillType: "content_generation", systemPrompt: system } as any);
  const content = (resp as { content?: string }).content ?? "";
  // 解析 JSON 数组(容错: 抽第一个 [...] )
  let titles: string[] = [];
  try {
    const m = content.match(/\[[\s\S]*\]/);
    if (m) titles = JSON.parse(m[0]);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, content: content.slice(0, 200) }, "标题生成解析失败, 退回按行拆");
  }
  if (!Array.isArray(titles) || titles.length === 0) {
    // 兜底: 按行拆, 去编号/引号
    titles = content.split("\n").map((l) => l.replace(/^\s*\d+[\.、)]\s*/, "").replace(/^["'，、]+|["'，、]+$/g, "").trim()).filter((l) => l.length >= 8);
  }
  // 7-20 占位符泄漏兜底(确定性, 不指望模型自觉): prompt 里的格式示意"IF X.X/审稿X天"曾被原样
  //   抄进标题流到可发布状态(生产 4 条: "IF X.X+1区化学,审稿2.8个月,毕业党闭眼冲！")。
  //   prompt 已改成不给可抄的占位符, 这里再加一道硬过滤 —— 与评分器"代码罚而非LLM自罚"同一思路。
  //   全部候选都被判占位符时不强行清空(否则整批无标题), 退回原列表并告警, 由下游标题校验兜住。
  const PLACEHOLDER_RE = /(?:IF|影响因子)\s*[:：]?\s*[XxNn](?:\.[XxNn])?|[XxNn]\s*(?:天|个月|月|%|区)|\$\s*[XxNn]|<[^>]{0,8}(?:分区|真实|数值)[^>]{0,8}>/;
  const cleaned = titles.map((t) => String(t).trim()).filter(Boolean);
  const noPlaceholder = cleaned.filter((t) => !PLACEHOLDER_RE.test(t));
  if (noPlaceholder.length < cleaned.length) {
    logger.warn({ dropped: cleaned.filter((t) => PLACEHOLDER_RE.test(t)), kept: noPlaceholder.length },
      "标题生成: 丢弃含未替换占位符的候选");
  }
  const finalTitles = (noPlaceholder.length > 0 ? noPlaceholder : cleaned).slice(0, count);
  // 7-03 ④: 记账 — 调用方(batch-worker/sample-article)只用 finalTitles[0], 按它计狠话用量
  if (scope && finalTitles[0]) {
    for (const tag of AGGRESSIVE_TITLE_TAGS) {
      if (finalTitles[0].includes(tag)) recordUsage(scope, tag);
    }
  }
  void usageCount; // usageCount 供调用方/测试直查, 保留导出链路
  return finalTitles;
}

/**
 * 7-06 ② 标题反馈飞轮 — 运营改标题正例读取。
 * 效果回流 (wechat-stats-collector) 发现"我们推送的标题 ≠ 运营实际群发的标题"时, 会落
 * contents.metadata.titleFeedback = { pushed, published, at, accountId } — 运营改标题 = 最真实的标题课。
 *
 * TODO(标题飞轮接通): generateTitles 的 TITLE_DNA 目前是静态规则 prompt;
 *   攒够 ≥10 条 titleFeedback 后, 在 generateTitles 里调本函数, 把 published 标题以
 *   "【运营改后正例, 风格参照不逐字抄】" 块注入 system prompt (few-shot)。本 PR 先把数据攒起来。
 */
export async function getOperatorTitleExamples(
  tenantId: string,
  limit = 10,
): Promise<Array<{ pushed: string; published: string; at: string }>> {
  try {
    const { db } = await import("../../models/db.js");
    const { sql } = await import("drizzle-orm");
    const { SYSTEM_RECOMMENDATION_TENANT_ID } = await import("../../config/system-recommendation.js");
    // 共享推荐池 (SYSTEM tenant) 的内容也算 — 草稿分发推的多来自共享池
    const res = await db.execute(sql`
      SELECT metadata->'titleFeedback' AS fb
      FROM contents
      WHERE (tenant_id = ${tenantId} OR tenant_id = ${SYSTEM_RECOMMENDATION_TENANT_ID}::uuid)
        AND metadata->'titleFeedback' IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT ${Math.max(1, Math.min(50, limit))}`);
    return (((res as any).rows ?? []) as Array<{ fb: any }>)
      .map((r) => r.fb)
      .filter((fb) => fb && typeof fb.pushed === "string" && typeof fb.published === "string")
      .map((fb) => ({ pushed: fb.pushed, published: fb.published, at: String(fb.at ?? "") }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "7-06 ② 读取运营改标题正例失败");
    return [];
  }
}
