/**
 * discipline_code 生成列「漂移守卫」—— 交接护栏 (7-25)。
 *
 * ## 守什么
 * `journals.discipline_code` 是 Postgres **生成列**(`GENERATED ALWAYS AS (...) STORED`),
 * 它的 CASE 表达式由 `discipline-mapping.ts` 的 `buildDisciplineCodeSql()` 从 RULES 生成,
 * 并在 migration `026_journals_discipline_code` 建列时**固化进了 DDL**。
 *
 * 生成列的表达式一旦建好就不再回看 TS 代码。于是有这么个静默陷阱:
 *   改了 `RULES`(加学科码 / 改 pattern / 调顺序) → TS 的 `toDisciplineCode()` 立刻生效,
 *   但**数据库里那一列纹丝不动** → 两边规则不一致。
 *
 * 后果是纯静默的:
 *   选刊器 `pickScopedFreshJournal` 按 `discipline_code` 过滤, 新加的学科码在库里一条都没有
 *   → 该学科永远选不出刊 → 日志只打一句「目标学科对口刊已枯竭」(一句正常业务话, 没人会去查),
 *   最后表现为"某个学科的号一直不出内容", 排查要走很远才想到是生成列没重建。
 *
 * `discipline-mapping.ts` 头部已经用注释写明了这条规矩, 但**注释拦不住人**。
 * 这个测试就是那个机制: RULES 一动, 这里立刻红。
 *
 * ## 怎么守
 * 下面的 FROZEN_DISCIPLINE_CODE_SQL 是 migration 026 应用到生产库时那一刻的 SQL 快照
 * (= 现在生产库 discipline_code 列里真正跑着的表达式)。
 * 测试把 `buildDisciplineCodeSql("discipline")` 的**当前**输出跟它对比, 不一致即红。
 *
 * ## 红了怎么办 —— 不要直接改快照让它变绿
 * 见下方 DRIFT_HOWTO。
 */
import { describe, it, expect } from "vitest";
import { buildDisciplineCodeSql } from "../services/recommendation/discipline-mapping.js";
import { MIGRATIONS } from "../models/migrations.js";

/**
 * 快照来源 migration。新加重建列的 migration 后, 这里要一起改成新版本号。
 */
const SNAPSHOT_SOURCE_MIGRATION = "026_journals_discipline_code";

/**
 * 🧊 冻结快照 —— migration 026 固化进生产库的 discipline_code 生成列表达式。
 *
 * ⚠️ 这不是"期望值", 是"生产库现状"。**不要为了让测试变绿而重新生成它**,
 *    那等于把 DB 已经漂了的事实抹掉, 守卫就白装了。改法见 DRIFT_HOWTO。
 */
const FROZEN_DISCIPLINE_CODE_SQL = `CASE
    WHEN discipline IS NULL OR btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) = '' THEN 'generic'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~* '^(medicine|education|economics|engineering|computer|agriculture|environment|law|psychology|biology|chemistry|physics|humanities)$' THEN lower(btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')))
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '综合性理工农医|高校学报|大学学报|自然科学综合|综合性科学技术' THEN 'generic'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '心理' THEN 'psychology'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '农业|农学|农艺|农机|农药|林业|林学|畜牧|兽医|水产|渔业|园艺|土壤|作物|饲料|种子|茶叶|蚕|果树|植保' THEN 'agriculture'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '医|药|临床|外科|内科|卫生|护理|口腔|儿科|肿瘤|针灸|病理|眼科|耳鼻|皮肤|精神病|神经病|影像|检验|麻醉|骨科|妇产|解剖|免疫|传染|康复|保健|营养' THEN 'medicine'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '教育|师范|教师|体育|图书|情报|档案|出版|课程|教学' THEN 'education'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '文学|语言|文字|语文|艺术|美术|音乐|舞蹈|戏剧|戏曲|电影|新闻|传播|编辑|历史|考古|文物|哲学|宗教|民族|社会学|文化|人文|汉学|伦理|逻辑' THEN 'humanities'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '法律|法学|法制|司法|政治|公安|警察|党建|纪检|行政管理|人大|统战' THEN 'law'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '经济|金融|贸易|会计|管理|财政|财务|统计|商业|旅游|保险|审计|市场|物流|人力资源' THEN 'economics'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '环境|生态|气象|气候|地质|地理|海洋|水利|水文|水土|资源|测绘|灾害|地震|极地' THEN 'environment'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '计算机|自动化|信息|软件|网络|人工智能|数据|电子|无线电|电信|通信|遥感|控制|仿真|密码' THEN 'computer'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '化学|化工|燃料|涂料|橡胶|塑料|催化|分析测试' THEN 'chemistry'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '物理|光学|力学|核科学|核技术|核工业|天文|声学|晶体|激光|真空' THEN 'physics'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '生物|植物|动物|微生物|遗传|细胞|生理|生化|昆虫|菌物' THEN 'biology'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '工业|工程|机械|仪表|仪器|电工|电力|电气|冶金|钢铁|建筑|建材|材料|能源|石油|天然气|煤炭|矿|纺织|服装|交通|运输|铁道|公路|船舶|航空|航天|汽车|轻工|印刷|包装|制造|焊接|锅炉|水泥|玻璃|陶瓷|皮革|造纸|食品' THEN 'engineering'
    WHEN btrim(regexp_replace(btrim(discipline), '[(（]除[^)）]*[)）]', '', 'g')) ~ '综合性|学报|科学技术|科技|军事|论丛|集刊' THEN 'generic'
    ELSE 'generic'
  END`;

const DRIFT_HOWTO = [
  "",
  "════════════════════════════════════════════════════════════════════════",
  " discipline_code 生成列漂移 —— 你改了 discipline-mapping.ts 的 RULES,",
  " 但数据库里的 journals.discipline_code 生成列**不会自动重算**。",
  "════════════════════════════════════════════════════════════════════════",
  "",
  " 为什么: discipline_code 是 GENERATED ALWAYS AS (...) STORED 列,",
  "         CASE 表达式在建列时(migration " + SNAPSHOT_SOURCE_MIGRATION + ")就固化进 DDL 了。",
  "         TS 侧 toDisciplineCode() 会立刻生效, DB 侧纹丝不动 → 两边规则不一致。",
  "         失败是**静默**的: 新学科码在库里一条都没有 → 选刊永远选不出对口刊,",
  "         日志只会打一句「目标学科对口刊已枯竭」(看起来完全正常), 没人会发现。",
  "",
  " 正确改法(两步都要做, 缺一不可):",
  "   1) 在 packages/server/src/models/migrations.ts 数组**末尾追加**一条新 migration:",
  "        {",
  "          version: \"0NN_journals_discipline_code_rebuild\",",
  "          description: \"RULES 变更后重建 discipline_code 生成列(说明改了什么)\",",
  "          sql: `",
  "            ALTER TABLE journals DROP COLUMN IF EXISTS discipline_code;",
  "            ALTER TABLE journals ADD COLUMN discipline_code varchar(20)",
  "              GENERATED ALWAYS AS (${buildDisciplineCodeSql(\"discipline\")}) STORED;",
  "            CREATE INDEX IF NOT EXISTS idx_journals_disc_code ON journals (discipline_code);",
  "            CREATE INDEX IF NOT EXISTS idx_journals_pick ON journals (status, discipline_code, confidence);",
  "          `,",
  "        }",
  "      (8744 行全表重写是毫秒级, 成本可忽略; 别改已发布的 026, 改了也不会重跑)",
  "   2) 回到本文件, 把 FROZEN_DISCIPLINE_CODE_SQL 更新为新表达式,",
  "      并把 SNAPSHOT_SOURCE_MIGRATION 改成你新加的 version。",
  "   3) 部署后跑 `pnpm db:migrate`, 确认新 migration 真的应用到生产库。",
  "",
  " 背景注释见 packages/server/src/services/recommendation/discipline-mapping.ts 文件头。",
  "════════════════════════════════════════════════════════════════════════",
].join("\n");

describe("discipline_code 生成列漂移守卫", () => {
  it("buildDisciplineCodeSql() 当前输出 == migration 固化进生产库的表达式", () => {
    expect(buildDisciplineCodeSql("discipline"), DRIFT_HOWTO).toBe(FROZEN_DISCIPLINE_CODE_SQL);
  });

  it("快照来源 migration 仍是最后一条重建 discipline_code 生成列的迁移", () => {
    const rebuilds = MIGRATIONS.filter(
      (m) => /discipline_code/.test(m.sql) && /GENERATED ALWAYS AS/.test(m.sql),
    );
    expect(rebuilds.length, "找不到任何重建 discipline_code 生成列的 migration —— 026 被删了?").toBeGreaterThan(0);
    expect(
      rebuilds[rebuilds.length - 1].version,
      "新加了重建 discipline_code 的 migration, 但本文件的 SNAPSHOT_SOURCE_MIGRATION / FROZEN_DISCIPLINE_CODE_SQL 没跟着更新。" +
        DRIFT_HOWTO,
    ).toBe(SNAPSHOT_SOURCE_MIGRATION);
  });

  it("该 migration 里写进 DDL 的确实是这份表达式(防有人手改 migration 文本)", () => {
    const m = MIGRATIONS.find((x) => x.version === SNAPSHOT_SOURCE_MIGRATION);
    expect(m, `migrations.ts 里找不到 ${SNAPSHOT_SOURCE_MIGRATION}`).toBeDefined();
    expect(m!.sql).toContain(FROZEN_DISCIPLINE_CODE_SQL);
    expect(m!.sql).toMatch(/GENERATED ALWAYS AS \(/);
  });
});
