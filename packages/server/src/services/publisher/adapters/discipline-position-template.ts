/**
 * 「学科定位」体裁模板（A2 第 6 步，8-10）。**纯函数、不查库、不调 LLM。**
 *
 * ## 数字全部由这里渲染，不由模型写
 *
 * 本数、总数、占比、同类刊清单，一律从 `cohort` 对象直接取值渲染。
 * 模型只写连接叙述（openingHook / positioning / cohortReading / …）。
 * 这样即使模型在叙述里说错，数字块仍然是对的；而 `cohort-fact-check`
 * 会把叙述里那句错的抓出来 —— 两层是互补的，不是重复的。
 *
 * ## 🔴 槽位缺了就整块消失，绝不补占位文案（红线 #14）
 *
 * 这个项目栽过的正是反面：数据缺失时填一句「权威期刊」「高影响力」，
 * 产出的东西**和真稿长得一模一样**，下游任何闸都分不出来。
 * 所以这里的规矩是：`siblings < 3` 整块不出现，`crossDiscipline < 3` 整块不出现，
 * 目录说明未审校整章不出现 —— 少一块无害，多一句假话致命。
 *
 * `discipline-position-template.test.ts` 直接拿 `FALLBACK_PHRASE_PATTERNS`
 * 那张词表断言输出里一个都不许有。
 *
 * ## 微信安全
 *
 * 与既有模板同款约束：`<section>` + inline style，emoji 直接 Unicode，
 * 无 flex / transform / class（微信编辑器会剥掉）。
 */
import { usableSlices, type DisciplineCohort } from "../../journals/discipline-cohort.js";

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 防御：模型偶发把段落字段返成字符串，for-of 会逐字裂段 */
function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

const C = {
  name: "#2F6FB0",
  heading: "#222",
  body: "#333",
  sub: "#888",
  line: "#e6e6e6",
  bg: "#fafafa",
};

/** 模型写的叙述部分。数字**不在**这里 */
export interface DisciplinePositionNarrative {
  title: string;
  openingHook?: string;
  positioning?: string;
  cohortReading?: string;
  siblingNote?: string;
  verifySteps?: string;
  closing?: string;
}

function p(text: string): string {
  return `<p style="margin:14px 0;font-size:16px;line-height:1.9;color:${C.body};">${esc(text)}</p>`;
}

function heading(text: string): string {
  return (
    `<p style="margin:26px 0 10px;font-size:17px;font-weight:600;color:${C.heading};` +
    `border-left:4px solid ${C.name};padding-left:10px;">${esc(text)}</p>`
  );
}

/** 段落组：空数组 → 返回空串（不产生空 <p>） */
function paras(v: unknown): string {
  return arr(v).map(p).join("");
}

/**
 * 事实条：左标签右数值。**只在有值时调用** ——
 * 调用方负责判空，这里不做「暂无」兜底（那正是红线 #14 禁的）。
 */
function factRow(label: string, value: string): string {
  return (
    `<p style="margin:6px 0;font-size:15px;line-height:1.8;color:${C.body};">` +
    `<span style="color:${C.sub};">${esc(label)}</span>　${esc(value)}</p>`
  );
}

/**
 * 渲染整篇。
 *
 * @param cohort 数字的唯一来源
 * @param n      模型写的叙述
 */
export function generateDisciplinePositionHtml(cohort: DisciplineCohort, n: DisciplinePositionNarrative): string {
  const slices = usableSlices(cohort);
  const out: string[] = [];

  out.push(`<section style="background:#fff;padding:4px 2px;">`);

  // ── 1 身份条：刊名 + 目录徽章
  out.push(
    `<p style="margin:8px 0 2px;font-size:20px;font-weight:700;color:${C.name};">《${esc(cohort.name)}》</p>`,
  );
  if (cohort.nameEn) {
    out.push(`<p style="margin:0 0 10px;font-size:13px;color:${C.sub};">${esc(cohort.nameEn)}</p>`);
  }
  const badges = [
    ...slices.map((s) => `${s.label}（${s.catalogYear} 版）`),
    ...(cohort.cscdBadge ? [`CSCD（${cohort.cscdBadge.catalogYear} 版）${cohort.cscdBadge.level ?? ""}`.trim()] : []),
  ];
  if (badges.length > 0) {
    out.push(
      `<p style="margin:0 0 16px;font-size:14px;color:${C.body};">` +
        badges
          .map(
            (b) =>
              `<span style="display:inline-block;background:${C.bg};border:1px solid ${C.line};` +
              `border-radius:3px;padding:2px 8px;margin:0 6px 6px 0;">${esc(b)}</span>`,
          )
          .join("") +
        `</p>`,
    );
  }

  // ── 0 开头钩子
  out.push(paras(n.openingHook));

  // ── 2 学科坐标（主料）。slices 为空时整章不出现 —— 但准入判据已挡在门外，这里是第二道
  if (slices.length > 0) {
    out.push(heading("它在目录里的位置"));
    out.push(paras(n.positioning));
    for (const s of slices) {
      out.push(
        `<section style="background:${C.bg};border:1px solid ${C.line};border-radius:4px;padding:12px 14px;margin:12px 0;">`,
      );
      out.push(
        `<p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${C.heading};">` +
          `${esc(s.label)}（${esc(s.catalogYear)} 版目录）</p>`,
      );
      out.push(factRow("所属分类", s.disciplineOfThisJournal));
      out.push(factRow("该分类收录", `${s.countInDiscipline} 本`));
      out.push(factRow("该版目录合计", `${s.countInCatalogTotal} 本`));
      out.push(factRow("该分类占比", `${s.shareOfCatalogPct}%`));
      out.push(`</section>`);
    }
  }

  // ── 3 同类刊清单。<3 本整块不出现，不凑数、不写"等"
  const withSiblings = slices.filter((s) => s.siblings.length >= 3);
  if (withSiblings.length > 0) {
    out.push(heading("同一分类下的其他期刊"));
    out.push(paras(n.siblingNote));
    for (const s of withSiblings) {
      out.push(
        `<p style="margin:12px 0 6px;font-size:14px;color:${C.sub};">` +
          `${esc(s.label)}「${esc(s.disciplineOfThisJournal)}」分类（部分）</p>`,
      );
      out.push(
        s.siblings
          .map(
            (name) =>
              `<p style="margin:4px 0;font-size:15px;line-height:1.8;color:${C.body};">· 《${esc(name)}》</p>`,
          )
          .join(""),
      );
    }
  }

  // ── 4 横向盘子。<3 个分类整块不出现
  const withCross = slices.filter((s) => s.crossDiscipline.length >= 3);
  if (withCross.length > 0) {
    out.push(heading("这一版目录的分类盘子"));
    out.push(paras(n.cohortReading));
    for (const s of withCross) {
      out.push(
        `<p style="margin:12px 0 6px;font-size:14px;color:${C.sub};">` +
          `${esc(s.label)}（${esc(s.catalogYear)} 版）收录本数最多的 ${s.crossDiscipline.length} 个分类</p>`,
      );
      out.push(
        s.crossDiscipline
          .map(
            (d) =>
              `<p style="margin:4px 0;font-size:15px;line-height:1.8;color:${C.body};">` +
              `${esc(d.discipline)}　<span style="color:${C.name};">${d.count} 本</span></p>`,
          )
          .join(""),
      );
    }
    out.push(
      `<p style="margin:8px 0;font-size:13px;color:${C.sub};">` +
        `（以上是整个目录的分类分布，与本刊所属分类无关）</p>`,
    );
  }

  // ── 6 怎么查证
  if (arr(n.verifySteps).length > 0) {
    out.push(heading("这些数字怎么核对"));
    out.push(paras(n.verifySteps));
  }

  // ── 7 结语
  out.push(paras(n.closing));

  // 版本年落款 —— 可查证性的一半在这里，恒定出现
  const years = [...new Set(slices.map((s) => `${s.label} ${s.catalogYear} 版`))];
  if (years.length > 0) {
    out.push(
      `<p style="margin:22px 0 6px;padding-top:12px;border-top:1px solid ${C.line};` +
        `font-size:13px;color:${C.sub};">数据来源：${esc(years.join("、"))}目录。目录更新后本数会变化。</p>`,
    );
  }

  out.push(`</section>`);
  return out.join("");
}
