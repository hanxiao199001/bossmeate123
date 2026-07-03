/**
 * P0四件套②：开头钩子模式库
 *
 * 为什么：老韩六维评分里"选题与钩子"占 20%，AI 默认写法是"背景介绍式"平铺开头，
 * 直接丢分。这里维护 8 个经过公众号验证的钩子结构，生成大纲/开头时随机注入 3 个，
 * 强制 LLM 选一种，禁止平铺直叙。
 *
 * 双层来源：
 *   1. 静态种子库（下方 SEED_HOOK_PATTERNS，人工写的 SCI 投稿场景例句）
 *   2. 学习库 data/hook-patterns-learned.json（scripts/extract-hook-patterns.ts
 *      从客户真实语料提炼），存在则合并且**学到的优先**（更贴该号口吻）。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { exhaustedKeys, recordUsage, usageCount } from "../services/content-engine/usage-rotation.js";

export interface HookPattern {
  /** 模式名 */
  name: string;
  /** 结构说明（给 LLM 看的"怎么搭这个开头"） */
  structure: string;
  /** 2 条 SCI 投稿场景例句（真人公众号口吻） */
  examples: string[];
  /** 适配的文章类型（空=通用）。articleType 匹配时优先被抽中 */
  articleTypes?: string[];
}

export const SEED_HOOK_PATTERNS: HookPattern[] = [
  {
    name: "痛点提问",
    structure: "第一句直接用读者的真实处境提问（卡审稿/被拒/赶毕业/选刊纠结），第二句给出本文能解决什么。",
    examples: [
      "投出去三个月，系统里还挂着 Under Review，你是不是也刷到心态崩了？今天说一本首次决定只要两周的刊。",
      "还差一篇 SCI 就能送审毕业，导师又不给方向？这篇帮你把选刊这步直接搞定。",
    ],
  },
  {
    name: "数字冲击",
    structure: "开头第一句甩一个具体硬数字（IF/录用率/审稿天数/版面费），用数字反差制造停留。数字必须真实。",
    examples: [
      "录用率接近 40%，IF 还在涨，这样的 2 区刊现在不多了。",
      "审稿 28 天，版面费一分不收——我第一次看到这组数据也以为标错了。",
    ],
  },
  {
    name: "反常识",
    structure: "先说一个和读者固有认知相反的结论（别再迷信高分刊/水刊反而难中），再用事实圆回来。",
    examples: [
      "说句得罪人的：多数人毕业延期，不是文章不行，是刊选错了。",
      "别再盯着 1 区大刊了，对赶时间的人来说，一本审稿稳定的 3 区刊才是真答案。",
    ],
  },
  {
    name: "身份代入",
    structure: "第一句直接点名读者身份（硕博生/青椒/临床医生/评职称的），让目标读者觉得'这是写给我的'。",
    examples: [
      "临床医生想发 SCI 的注意了，这本刊对病例报告是真友好。",
      "写给每一个白天上课、晚上改稿的青椒：评职称的这篇文章，别投错地方。",
    ],
  },
  {
    name: "避坑警示",
    structure: "开头先亮风险（预警名单/自引率高/分区跳水），营造'先看这篇再投，能少走弯路'的紧迫感。",
    examples: [
      "投稿前先停一下：这本刊去年刚上过预警名单，现在到底能不能投，看完再决定。",
      "有个坑我必须提前说——这本刊分区去年掉了一档，评职称认不认，你得先问清楚。",
    ],
  },
  {
    name: "对比悬念",
    structure: "把两个选择摆在一起制造纠结（A 刊还是 B 刊/快但贵 vs 慢但免费），答案压到正文再给。",
    examples: [
      "同样是免疫学 2 区，一本审稿快但要 2000 刀，一本免费但排队半年——换你怎么选？",
      "手里这篇数据，投稳一点的 3 区还是赌一把 2 区？我把两条路的账都算给你看。",
    ],
  },
  {
    name: "结果前置",
    structure: "把读者最想要的结论放第一句（这刊值得投/这三本闭眼冲），先给答案再给论据，不绕弯子。",
    examples: [
      "先说结论：手里有材料方向的稿子，这本刊现在就值得投。",
      "直接上答案——环境科学赶毕业，就在这三本里挑，往下看理由。",
    ],
  },
  {
    name: "时效紧迫",
    structure: "绑定一个真实的时间节点（IF 即将更新/特刊截稿/毕业送审季），提示'现在看正是时候'。",
    examples: [
      "六月新 IF 马上公布，这本被预测要涨的刊，趁现在投还不算晚。",
      "距离春季送审只剩四个月，现在投什么刊还来得及录用？这篇按时间倒推给你算了一遍。",
    ],
  },
];

// 学习库缓存：进程内只读一次盘（学习文件由脚本离线生成，不会热更）
let learnedCache: HookPattern[] | null | undefined;

/**
 * 读学习库 data/hook-patterns-learned.json（extract-hook-patterns.ts 产出）。
 * 路径可用 HOOK_PATTERNS_LEARNED_PATH 覆盖；文件缺失/损坏一律静默回退种子库。
 */
function loadLearnedPatterns(): HookPattern[] {
  if (learnedCache !== undefined) return learnedCache ?? [];
  learnedCache = null;
  try {
    const p = process.env.HOOK_PATTERNS_LEARNED_PATH
      || resolve(process.cwd(), "data/hook-patterns-learned.json");
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      const arr = Array.isArray(parsed) ? parsed : parsed?.patterns;
      if (Array.isArray(arr)) {
        learnedCache = arr.filter(
          (x: HookPattern) => x && typeof x.name === "string" && typeof x.structure === "string"
        );
      }
    }
  } catch {
    // 学习库损坏不致命：静默用种子库
    learnedCache = null;
  }
  return learnedCache ?? [];
}

/**
 * 合并后的可用模式：学到的优先（同名去重，学习版覆盖种子版）。
 */
export function getHookPatterns(): HookPattern[] {
  const learned = loadLearnedPatterns();
  if (learned.length === 0) return SEED_HOOK_PATTERNS;
  const names = new Set(learned.map((p) => p.name));
  return [...learned, ...SEED_HOOK_PATTERNS.filter((p) => !names.has(p.name))];
}

/**
 * 按 articleType 优先 + 随机挑 n 个模式（默认 3）。
 * 为什么随机：固定模式会让同一账号的开头同质化，随机 3 选 1 保证多样性。
 */
export function pickHookPatterns(articleType?: string, n: number = 3): HookPattern[] {
  const all = getHookPatterns();
  const preferred = articleType
    ? all.filter((p) => p.articleTypes?.some((t) => articleType.includes(t)))
    : [];
  const rest = all.filter((p) => !preferred.includes(p));
  // Fisher-Yates 抽样
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return [...preferred, ...shuffled].slice(0, Math.max(1, n));
}

/**
 * 生成注入 prompt 的钩子块：3 个候选模式 + 硬性要求。
 * 供 article-pipeline / format-generators 的大纲与开头 prompt 直接拼接。
 */
export function buildHookPromptBlock(articleType?: string, n: number = 3, rotationScope?: string): string {
  // 7-03 ④: 传 rotationScope 时按"同 scope 当天每模式限用 2 次"过滤候选 + 注入禁选清单。
  // LLM 自选型注入无法精确知道最终选中哪个, 按"候选第一个"近似记账（LLM 强倾向选首项）。
  const HOOK_LIMIT = 2;
  let picks = pickHookPatterns(articleType, rotationScope ? Math.max(n, 6) : n);
  let banLine = "";
  if (rotationScope) {
    const banned = exhaustedKeys(rotationScope, picks.map((p) => p.name), HOOK_LIMIT);
    const fresh = picks.filter((p) => usageCount(rotationScope, p.name) < HOOK_LIMIT);
    picks = (fresh.length > 0 ? fresh : picks).slice(0, n);
    if (banned.length > 0) {
      banLine = `\n（以下模式今天已用满，禁选：${banned.join("、")}）`;
    }
    if (picks[0]) recordUsage(rotationScope, picks[0].name);
  }
  const lines = picks.map(
    (p, i) => `${i + 1}. 【${p.name}】${p.structure}\n   例：${p.examples[0] ?? ""}`
  );
  return `\n【开头钩子要求】从以下钩子模式中任选一种写开头（前两句必须完成钩子），🚫 禁止平铺直叙介绍背景、禁止"随着…的发展"式开场：${banLine}\n${lines.join("\n")}`;
}
