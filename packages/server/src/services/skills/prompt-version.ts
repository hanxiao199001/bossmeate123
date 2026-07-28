/**
 * Prompt 版本号 —— 阶段1-C。
 *
 * ## 为什么需要
 *
 * article-skill 的主 prompt 被 22 个 PR 层层改过, 但**落库的内容里没有任何"这篇是哪版 prompt 写的"的痕迹**。
 * 后果:
 *   - 质量突然下滑时完全无法归因: 是上周改的密度规则? 是钩子轮换? 还是模型那边变了? 只能猜。
 *   - 无法回滚到"上周那版" —— 因为没人知道上周那版长什么样、覆盖了哪些文章。
 *   - 阶段4 反馈闭环的**硬前置**: 即使把阅读量/完读率接进来, 没有版本号也判断不了
 *     "某次改动是让文章变好还是变差"(样本混着两版 prompt, 均值毫无意义)。
 *
 * ## bump 规则(改 prompt 的人必须照做)
 *
 * 版本号格式 `<major>.<minor>`, **手动 bump**, 语义如下:
 *
 *   - **major +1**: prompt 的**结构**变了 —— 增删了一个有名字的块(角色/任务/已知数据/禁写清单/
 *     密度要求/排版/标题约束/videoScript/输出 JSON schema), 或输出字段增删。
 *     这类改动会让新旧文章不可直接比较, 效果数据要分开统计。
 *   - **minor +1**: 块内措辞/阈值/清单项变化 —— 例如加一条禁止词、把字数从 600-800 改成 800-1000、
 *     调整密度要求的措辞。同结构可比, 效果数据可以放一起看趋势。
 *   - **不 bump**: 纯注释、纯格式、变量重命名等**不改变最终 prompt 文本**的改动。
 *
 * 判据很简单: **同一本期刊、同一份数据, 渲染出的 prompt 字符串变了没有?** 变了就 bump。
 *
 * ## 落库位置
 *
 * `contents.metadata.promptVersion`。
 *   - ArticleSkill 写进 `artifact.metadata`(主版本 + 各副版本);
 *   - batch-worker 的 metaMerge 白名单里已加 `promptVersion`, 会 merge 进 contents.metadata。
 * 查询示例: `SELECT metadata->>'promptVersion' v, count(*), avg((metadata->>'sixDimTotal')::numeric)
 *            FROM contents WHERE type='article' GROUP BY 1;`
 *
 * ## 变更履历(bump 时在这里追一行, 别删旧的)
 *
 *   7.0  2026-07-28  阶段1-C 首次引入版本号。同批改动: 字段契约收口(##已知期刊数据##/##未公开字段##/
 *                    ##禁止字段##/密度要求 四块改由 journal-prompt-fields.ts 同源生成),
 *                    修掉国际刊分支写死的密度规则(不再点名 DB 里没有的字段)。
 *                    起始号取 7.0 是为了对齐 prompt 里长期自称的 "V7 深度分析"结构。
 */

/** article-skill 主 prompt 版本。改 prompt 内容时按上方规则手动 bump。 */
export const ARTICLE_PROMPT_VERSION = "7.0";
