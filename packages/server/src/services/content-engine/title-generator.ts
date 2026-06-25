/**
 * 6-25 标题生成器 —— 按「Paper咨询与发表-SCI期刊推荐」的标题 DNA 产候选标题。
 *   标题是一张"利益清单",不卖文采卖确定性。喂期刊真实数据 → LLM 产 N 个候选。
 *   红线: 只用传入的真实数据, 绝不编造 IF/分区/审稿/录用率 等任何数字。
 */
import { chat } from "../ai/chat-service.js";
import { logger } from "../../config/logger.js";

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
}

const TITLE_DNA = `你是"Paper咨询与发表-SCI期刊推荐"公众号的标题手。你的标题是一张"利益清单",不卖文采,卖"投这本能得到什么"的确定性。

【硬性规则】
1. 以"钩子型"为主(卖点机关枪式堆叠、带感叹号、无"期刊解读"前缀);5个里可给1个"解读型"(以「期刊解读:中科院X区《英文名》…」开头,理性权威)。
2. 钩子型公式: 〔痛点 或 一个具体数字开头〕→〔3-4个硬卖点,用逗号/顿号串起来〕→〔身份召唤(毕业党/评职称/青椒/硕博生)〕→〔行动指令(闭眼冲/必看/值得冲)〕+ 感叹号。
3. 指标必须用阿拉伯数字写具体: IF X.X、审稿X天、录用率X%、版面费$X —— 不说"快"说"X天",不说"高"说"X%"。
4. 长度 30-45 字。
5. 六个利益维度按需打中3-4个: 分区/IF权威、低门槛好发、审稿快、免版面费、毕业评职痛点、低风险(无预警/自引率低)。
6. 语感口语化+适度夸张标签(可用: 毕业神刊/闭眼投/水刊/天花板/救命稻草/捡漏/灌水神刊/青椒/沾边就收/有手就发/光速审稿/黑马),自然为主,别每个标题都堆满。

【红线】只能用下面给你的真实数据。绝不编造 IF/分区/审稿周期/录用率/自引率/版面费 等任何数字或事实。某维度没给数据就不写它,严禁瞎填。

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
  count?: number;
}): Promise<string[]> {
  const { tenantId, userId, journal } = opts;
  const count = opts.count ?? 5;
  const data =
    fmt("期刊名称", journal.name) + fmt("英文名", journal.nameEn) + fmt("出版社", journal.publisher) +
    fmt("中科院分区", journal.casPartition) + fmt("JCR分区", journal.jcrPartition) +
    fmt("影响因子", journal.impactFactor) + fmt("IF趋势", journal.ifTrend) +
    fmt("审稿周期", journal.reviewCycle) + fmt("录用率", journal.acceptanceRate) +
    fmt("自引率", journal.selfCitationRate) + fmt("版面费", journal.apc) +
    fmt("预警情况", journal.warning) + fmt("领域", journal.discipline) +
    fmt("年发文量", journal.yearPublished) + fmt("其它卖点", journal.extra);

  const system = opts.styleProfile ? `${TITLE_DNA}\n\n【该号补充风格】\n${opts.styleProfile}` : TITLE_DNA;
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
  return titles.map((t) => String(t).trim()).filter(Boolean).slice(0, count);
}
