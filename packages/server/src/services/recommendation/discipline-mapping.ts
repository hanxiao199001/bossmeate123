/**
 * 7-20 学科码映射 — 治"国内刊 discipline 存中文、选刊器按英文码 ILIKE 匹配"的错配。
 *
 * 背景(生产实测): 国内 verified active 刊 2379 本, 只有 137 本(5.8%)的 discipline 能被
 *   ALL_DISC_CODES 的英文码匹配上; 其余 2242 本存的是北大核心/CSCD 的中文分类名
 *   (如 "临床医学" / "综合性人文、社会科学" / "中国政治(除公安管理、公安工作）")。
 *   `discipline ILIKE '%medicine%'` 永远匹配不上 "临床医学" → 选刊只能靠不带学科的兜底层,
 *   国内选刊实际在 137 本里打转(近30天全库只用到 231 本不同刊, 平均每本被用 4 次)。
 *
 * ⚠️ 本文件是规则的**唯一真相源**。`journals.discipline_code` 是 Postgres **生成列**
 *   (`GENERATED ALWAYS AS ... STORED`), 其表达式由 `buildDisciplineCodeSql()` 从同一份
 *   RULES 生成(见 migrations.ts 的 026), 不存在第二份规则。
 *
 *   选生成列而非"普通列+回填"的理由: crawler(openalex/arxiv)会新插期刊、enricher 会改
 *   discipline, 普通列必须在每个写入点都记得调 toDisciplineCode(), 漏一处就静默错码;
 *   生成列由 DB 保证 discipline 一变 code 立刻跟着变, **永不漂**。
 *
 *   ⚠️ **改了 RULES 不会自动生效** —— 生成列的表达式在建列时就固化进了 DDL。
 *   改规则后必须新加一条 migration 走 `DROP COLUMN discipline_code` +
 *   重新 `ADD COLUMN ... GENERATED`(8744 行重写是毫秒级, 成本可忽略)。
 *   TS 侧的 toDisciplineCode() 会立刻生效, 若不同步重建列, 两边就会不一致。
 *
 * 匹配顺序即优先级, 首个命中即返回。顺序上的几处刻意安排:
 *   - 英文码原样透传放最前 —— 国际刊本就是英文码(4699/4828 可匹配), 不进中文规则。
 *   - "宽综合"(综合性理工农医/高校学报)在具体学科之前 —— 否则 "综合性理工农医" 会被
 *     medicine 的 `医` 抢走, 而它是真·跨学科刊。
 *   - agriculture 在 medicine 之前 —— 否则 `兽医`/`农药` 会被 medicine 的 `医`/`药` 抢走。
 *   - education 在 computer 之前 —— 否则 "图书情报" 会被 computer 的 `信息` 抢走。
 *   - engineering 放在靠后 —— `工程`/`材料` 太宽, 让更具体的学科先命中。
 *   - 其余"具体学科"里的 `综合性XX`(综合性医药卫生/综合性经济科学/综合性农业科学)
 *     会正确落到对应学科, 而不是笼统 generic。
 */

/** 通配学科码: 综合刊/学报/规则未覆盖者。在任何学科槽位都算命中(综合刊本就通吃)。 */
export const GENERIC_DISCIPLINE_CODE = "generic";

/** 与 daily-cron 的 ALL_DISC_CODES 保持一致(7-20 新增 humanities)。 */
export const DISCIPLINE_CODES = [
  "medicine", "education", "economics", "engineering", "computer", "agriculture",
  "environment", "law", "psychology", "biology", "chemistry", "physics", "humanities",
] as const;
export type DisciplineCode = (typeof DISCIPLINE_CODES)[number] | typeof GENERIC_DISCIPLINE_CODE;

/**
 * 规则表: 有序, 首个命中即返回。
 * pattern 只用「字面量 + |」, 保证 JS RegExp 与 Postgres ERE(`~`) 两边语义一致
 * —— 不要引入前后瞻/反向引用/\d\w 等方言差异写法, 否则 TS 与回填 SQL 会漂。
 */
export const RULES: ReadonlyArray<{ code: DisciplineCode; pattern: string; note?: string }> = [
  // ① 真·跨学科(必须先于具体学科, 否则被 医/农 等单字抢走)
  { code: GENERIC_DISCIPLINE_CODE, pattern: "综合性理工农医|高校学报|大学学报|自然科学综合|综合性科学技术", note: "跨学科刊, 任何槽位通吃" },

  // ② 具体学科 —— 顺序敏感, 勿随意调换(见文件头说明)
  { code: "psychology",  pattern: "心理" },
  { code: "agriculture", pattern: "农业|农学|农艺|农机|农药|林业|林学|畜牧|兽医|水产|渔业|园艺|土壤|作物|饲料|种子|茶叶|蚕|果树|植保" },
  { code: "medicine",    pattern: "医|药|临床|外科|内科|卫生|护理|口腔|儿科|肿瘤|针灸|病理|眼科|耳鼻|皮肤|精神病|神经病|影像|检验|麻醉|骨科|妇产|解剖|免疫|传染|康复|保健|营养" },
  { code: "education",   pattern: "教育|师范|教师|体育|图书|情报|档案|出版|课程|教学" },
  { code: "humanities",  pattern: "文学|语言|文字|语文|艺术|美术|音乐|舞蹈|戏剧|戏曲|电影|新闻|传播|编辑|历史|考古|文物|哲学|宗教|民族|社会学|文化|人文|汉学|伦理|逻辑" },
  { code: "law",         pattern: "法律|法学|法制|司法|政治|公安|警察|党建|纪检|行政管理|人大|统战" },
  { code: "economics",   pattern: "经济|金融|贸易|会计|管理|财政|财务|统计|商业|旅游|保险|审计|市场|物流|人力资源" },
  { code: "environment", pattern: "环境|生态|气象|气候|地质|地理|海洋|水利|水文|水土|资源|测绘|灾害|地震|极地" },
  { code: "computer",    pattern: "计算机|自动化|信息|软件|网络|人工智能|数据|电子|无线电|电信|通信|遥感|控制|仿真|密码" },
  { code: "chemistry",   pattern: "化学|化工|燃料|涂料|橡胶|塑料|催化|分析测试" },
  { code: "physics",     pattern: "物理|光学|力学|核科学|核技术|核工业|天文|声学|晶体|激光|真空" },
  { code: "biology",     pattern: "生物|植物|动物|微生物|遗传|细胞|生理|生化|昆虫|菌物" },
  { code: "engineering", pattern: "工业|工程|机械|仪表|仪器|电工|电力|电气|冶金|钢铁|建筑|建材|材料|能源|石油|天然气|煤炭|矿|纺织|服装|交通|运输|铁道|公路|船舶|航空|航天|汽车|轻工|印刷|包装|制造|焊接|锅炉|水泥|玻璃|陶瓷|皮革|造纸|食品" },

  // ③ 兜底"窄综合" —— 走到这里说明没命中任何具体学科
  { code: GENERIC_DISCIPLINE_CODE, pattern: "综合性|学报|科学技术|科技|军事|论丛|集刊" },
];

/**
 * 归一化: 剥掉北大核心分类名里的「排除子句」再匹配。
 *
 * 7-20 实测抓到的真 bug: "哲学(除心理学)" 被 `心理` 规则抓成 psychology —— 它是哲学刊,
 *   "(除心理学)" 是排除条款, 不是主题。生产库里带此类子句的有 16 种分类名 / 317 本刊
 *   (会计(除审计) / 文学(除中国文学作品) / 自动化技术、计算机技术(除计算机网络、安全保密) …)。
 *   不剥离就会拿排除项当主题匹配, 越靠前的规则越容易误抢。
 * 中英文括号都要处理(库里两种都有: "(除审计)" 与 "（除电化教育）")。
 */
const EXCLUSION_PATTERN = "[(（]除[^)）]*[)）]";
const EXCLUSION_RE = new RegExp(EXCLUSION_PATTERN, "g");
const normalize = (s: string) => s.replace(EXCLUSION_RE, "");

/** 预编译的英文码正则(整词优先, 避免 "law" 命中 "lawn" 之类) */
const ENGLISH_CODE_RE = new RegExp(`^(${DISCIPLINE_CODES.join("|")})$`, "i");

/**
 * 把期刊的 discipline 原始值归一成学科码。
 * - 英文码原样返回(国际刊本就是英文, 约 4699/4828 命中) —— 大小写不敏感, 统一转小写。
 * - 中文分类名走 RULES。
 * - 空值 / 全部规则未命中 → GENERIC(约束③: 100% 覆盖, 绝不让它们掉回 137 本小池)。
 */
export function toDisciplineCode(raw: string | null | undefined): DisciplineCode {
  const s = normalize((raw ?? "").trim()).trim();
  if (!s) return GENERIC_DISCIPLINE_CODE;
  const m = s.match(ENGLISH_CODE_RE);
  if (m) return m[1].toLowerCase() as DisciplineCode;
  for (const r of RULES) {
    if (new RegExp(r.pattern).test(s)) return r.code;
  }
  return GENERIC_DISCIPLINE_CODE;
}

/**
 * 归一到**具体**学科码; 归一不出具体学科(空值 / 只匹配到综合刊兜底)时返回 null。
 *
 * 为什么要有这个而不是直接用 toDisciplineCode(): toDisciplineCode 的契约是"100% 覆盖",
 * 任何输入都会落到一个码, 兜不住就给 generic。这个契约对**选刊槽位**是对的(综合刊通吃),
 * 但对**自由文本**(用户输入的主题词 / 热词, 如 "糖尿病" / "元宇宙")就成了陷阱 ——
 * 它们不该被当成"综合学科", 照单全收会让 `discipline_code = 'generic'` 匹配到全部 1139 本
 * 综合刊, 噪声比不加学科条件还大。
 *
 * 铁律: **入参是学科槽位/下拉框值** → 用 toDisciplineCode(要 generic 兜底);
 *       **入参是自由文本** → 用 resolveDisciplineCode, 拿到 null 就**不加学科条件**。
 */
export function resolveDisciplineCode(raw: string | null | undefined): DisciplineCode | null {
  const code = toDisciplineCode(raw);
  return code === GENERIC_DISCIPLINE_CODE ? null : code;
}

/**
 * 由 RULES 生成等价的 Postgres CASE 表达式 —— migration 回填与 TS 共用这一份规则。
 * @param col 期刊 discipline 列的 SQL 引用(如 `discipline` 或 `j.discipline`)
 */
export function buildDisciplineCodeSql(col = "discipline"): string {
  const esc = (p: string) => p.replace(/'/g, "''");
  // 与 TS 侧 normalize() 等价: 先剥排除子句再 btrim, 后续所有分支都基于 n
  const n = `btrim(regexp_replace(btrim(${col}), '${esc(EXCLUSION_PATTERN)}', '', 'g'))`;
  const lines = [
    `    WHEN ${col} IS NULL OR ${n} = '' THEN '${GENERIC_DISCIPLINE_CODE}'`,
    `    WHEN ${n} ~* '^(${DISCIPLINE_CODES.join("|")})$' THEN lower(${n})`,
    ...RULES.map((r) => `    WHEN ${n} ~ '${esc(r.pattern)}' THEN '${r.code}'`),
  ];
  return `CASE\n${lines.join("\n")}\n    ELSE '${GENERIC_DISCIPLINE_CODE}'\n  END`;
}
