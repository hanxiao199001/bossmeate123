/**
 * B.4-2 trial verify：5-10 条期刊手动跑万方 fetcher + extractor，
 * 看反爬触发情况 + 字段提取成功率 + 邮箱 PIPL 过滤效果。
 *
 * 用法（桌面跑，不在 server）：
 *   pnpm --filter @bossmate/server exec tsx src/scripts/verify-wanfang-trial.ts
 *
 * 节流：每条间隔 10s（mock B.3 BullMQ 的 delayMs=10000±3000）
 * 输出：每条期刊 fetch+extract 结果 + 总览统计
 *
 * 验完即可删（PR merge 前手动跑一次留 console log 给老板看；merge 后服务器
 * 直接跑 batch enrich R6 不需要这个脚本）。
 */
import { fetchWanfangPeriodical } from "../services/journal-enricher/fetchers/wanfang-fetcher.js";
import { extractWanfangPeriodical } from "../services/journal-enricher/extractors/wanfang-extractor.js";

const TRIAL_JOURNALS: Array<{ name: string; perioId: string }> = [
  { name: "中华医学杂志", perioId: "zhyx" },
  { name: "中华内科杂志", perioId: "zhnk" },
  { name: "中华外科杂志", perioId: "zhwk" },
  { name: "中华病理学杂志", perioId: "zhblx" },
  { name: "中华神经科杂志", perioId: "zhsjk" },
  { name: "中华心血管病杂志", perioId: "zhxxgb" },
  { name: "中华肿瘤杂志", perioId: "zhzl" },
  { name: "中华儿科杂志", perioId: "zhek" },
];

interface TrialResult {
  name: string;
  perioId: string;
  fetchOk: boolean;
  htmlSize: number;
  extractOk: boolean;
  fieldsCount: number;
  fieldsPresent: string[];
  emailPresent: boolean;
  cnIfPresent: boolean;
  cscdPresent: boolean;
  pkuPresent: boolean;
  errMsg?: string;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runOne(j: { name: string; perioId: string }): Promise<TrialResult> {
  const start = Date.now();
  try {
    const raw = await fetchWanfangPeriodical({ perioId: j.perioId });
    if (!raw) {
      return {
        name: j.name, perioId: j.perioId, fetchOk: false, htmlSize: 0,
        extractOk: false, fieldsCount: 0, fieldsPresent: [],
        emailPresent: false, cnIfPresent: false, cscdPresent: false, pkuPresent: false,
        errMsg: "fetch returned null（perioId 无效 / 4xx / sanity-size 拦截）",
      };
    }
    const data = extractWanfangPeriodical(raw);
    if (!data) {
      return {
        name: j.name, perioId: j.perioId, fetchOk: true, htmlSize: raw.html.length,
        extractOk: false, fieldsCount: 0, fieldsPresent: [],
        emailPresent: false, cnIfPresent: false, cscdPresent: false, pkuPresent: false,
        errMsg: "extract returned null（页面无字段 / 选择器不匹配）",
      };
    }
    const fields = Object.entries(data).filter(([k, v]) => k !== "fetchedAt" && k !== "sourceUrl" && v != null && v !== "");
    return {
      name: j.name,
      perioId: j.perioId,
      fetchOk: true,
      htmlSize: raw.html.length,
      extractOk: true,
      fieldsCount: fields.length,
      fieldsPresent: fields.map(([k]) => k),
      emailPresent: !!data.editorEmail,
      cnIfPresent: typeof data.cnImpactFactor === "number",
      cscdPresent: !!data.cscdLevelDynamic,
      pkuPresent: !!data.pkuCoreDynamic,
    };
  } catch (err) {
    return {
      name: j.name, perioId: j.perioId, fetchOk: false, htmlSize: 0,
      extractOk: false, fieldsCount: 0, fieldsPresent: [],
      emailPresent: false, cnIfPresent: false, cscdPresent: false, pkuPresent: false,
      errMsg: err instanceof Error ? err.message : String(err),
    };
  } finally {
    const dur = Date.now() - start;
    console.log(`  [${j.name}] ${dur}ms`);
  }
}

async function main() {
  console.log(`🔬 万方 trial verify：${TRIAL_JOURNALS.length} 条期刊（节流 10s 间隔）\n`);
  const results: TrialResult[] = [];
  for (let i = 0; i < TRIAL_JOURNALS.length; i++) {
    const r = await runOne(TRIAL_JOURNALS[i]);
    results.push(r);
    if (i < TRIAL_JOURNALS.length - 1) {
      const jitter = 10000 + Math.floor(Math.random() * 3000);
      console.log(`  ⏱️  下一条间隔 ${jitter}ms...`);
      await sleep(jitter);
    }
  }

  console.log("\n📊 总览：");
  console.log(`  fetch 成功：${results.filter((r) => r.fetchOk).length} / ${results.length}`);
  console.log(`  extract 成功：${results.filter((r) => r.extractOk).length} / ${results.length}`);
  console.log(`  editorEmail 命中：${results.filter((r) => r.emailPresent).length} / ${results.length}`);
  console.log(`  中文 IF 命中：${results.filter((r) => r.cnIfPresent).length} / ${results.length}`);
  console.log(`  CSCD 信号命中：${results.filter((r) => r.cscdPresent).length} / ${results.length}`);
  console.log(`  北大核心 信号命中：${results.filter((r) => r.pkuPresent).length} / ${results.length}`);
  console.log(`\n📋 详情：`);
  for (const r of results) {
    if (r.fetchOk && r.extractOk) {
      console.log(`  ✅ ${r.name} (${r.perioId})  ${r.htmlSize}B  ${r.fieldsCount} 字段  ${r.fieldsPresent.join(",")}`);
    } else {
      console.log(`  ❌ ${r.name} (${r.perioId})  ${r.errMsg ?? "extract failed"}`);
    }
  }
}

main().catch((err) => {
  console.error("verify 脚本崩溃：", err);
  process.exitCode = 1;
});
