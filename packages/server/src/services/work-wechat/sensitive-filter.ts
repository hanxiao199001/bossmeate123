/**
 * 敏感词 DFA 匹配器 —— 企微 AI 客服「出站硬闸」的纯函数层（B-kf 合规）。
 *
 * 词库：同目录 sensitive-lexicon.txt（一行一词，# 注释；来源/许可/剔除规则见该文件头）。
 * 设计：
 *   - buildDfaTree 纯函数构树；模块内 lazy 单例只在首次 matchSensitive 时读文件构建一次
 *   - 归一化：全角→半角、大写→小写、去空白（词与文本同规则，防"敏 感 词"式简单绕过）
 *   - 不做拼音/形近/简繁变体对抗（v2 再说，硬闸先保底线）
 *   - 词库文件缺失 = 部署事故：logger.error 后放行（fail-open）——闸失效必须让人看到，
 *     但不能让全部 AI 回复被误杀成转人工（fail-closed 等于客服瘫痪）
 * 性能：DFA 单次匹配 O(文本长 × 最长词深)，2000 字文本 <1ms 量级。
 *
 * 红线：命中词只进服务端日志/落库打标，绝不能出现在发给客户的任何文案里。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../config/logger.js";

export interface SensitiveMatch {
  hit: boolean;
  /** 命中的词（归一化形态，去重）。仅供日志/打标，禁止外发。 */
  words: string[];
}

interface DfaNode {
  /** 到本节点构成完整敏感词时 = 该词（归一化）；否则 undefined */
  word?: string;
  next: Map<string, DfaNode>;
}

/** 归一化：全角→半角 + 小写 + 去所有空白。词与文本共用同一规则，保证对齐。 */
export function normalizeForMatch(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    let c = ch;
    if (code === 0x3000) c = " ";                                    // 全角空格
    else if (code >= 0xff01 && code <= 0xff5e) c = String.fromCodePoint(code - 0xfee0); // 全角 ASCII 区
    if (/\s/.test(c)) continue;                                      // 去空白（含归一后的全角空格）
    out += c.toLowerCase();
  }
  return out;
}

/** 构建 DFA 词树（纯函数）。词会先归一化；空词/单字丢弃（单字误伤率极高，词库层也不收）。 */
export function buildDfaTree(words: Iterable<string>): DfaNode {
  const root: DfaNode = { next: new Map() };
  for (const raw of words) {
    const w = normalizeForMatch(raw);
    if (w.length < 2) continue;
    let node = root;
    for (const ch of w) {
      let child = node.next.get(ch);
      if (!child) {
        child = { next: new Map() };
        node.next.set(ch, child);
      }
      node = child;
    }
    node.word = w;
  }
  return root;
}

/** 用指定词树匹配文本（纯函数，测试友好）。返回命中的词（去重，最多 20 个防日志爆炸）。 */
export function matchWithTree(tree: DfaNode, text: string): SensitiveMatch {
  const t = normalizeForMatch(text ?? "");
  const found = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    let node: DfaNode | undefined = tree;
    for (let j = i; j < t.length; j++) {
      node = node.next.get(t[j]);
      if (!node) break;
      if (node.word) found.add(node.word); // 同起点继续走，长词也要记（如"法轮"与"法轮功"）
      if (found.size >= 20) return { hit: true, words: [...found] };
    }
  }
  return { hit: found.size > 0, words: [...found] };
}

// ============ 词库文件加载 + lazy 单例 ============

/**
 * 词库路径解析：dev（tsx 跑 src/）直接同目录；prod（node dist/）tsc 不拷贝 txt 资产，
 * 回退到部署目录里的 src/ 同路径（服务器是 git checkout，src 始终在）。
 */
function resolveLexiconPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "sensitive-lexicon.txt"),
    join(here.replace(/([\\/])dist([\\/])/, "$1src$2"), "sensitive-lexicon.txt"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 读词库文件 → 词数组（跳过空行与 # 注释）。导出供测试/审计脚本用。 */
export function loadLexiconWords(): string[] {
  const path = resolveLexiconPath();
  if (!path) {
    // 部署事故级：闸形同虚设。error 级日志确保被看到；返回空表 = fail-open（见文件头权衡）。
    logger.error({}, "敏感词库文件 sensitive-lexicon.txt 缺失，出站敏感词硬闸未生效！请检查部署（src 目录需随 git 部署）");
    return [];
  }
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

let singleton: { tree: DfaNode; size: number } | null = null;

function getSingleton(): { tree: DfaNode; size: number } {
  if (!singleton) {
    const words = loadLexiconWords();
    singleton = { tree: buildDfaTree(words), size: words.length };
    logger.info({ lexiconSize: words.length }, "kf 敏感词 DFA 词树构建完成（出站硬闸就绪）");
  }
  return singleton;
}

/** 已加载词库词数（0 = 词库缺失，闸未生效）。 */
export function getLexiconSize(): number {
  return getSingleton().size;
}

/**
 * 出站文本敏感词匹配（业务入口）。首次调用构建词树，之后纯内存匹配。
 * 任何内部异常按"未命中"返回并记 error —— 匹配器故障不应把全部客服回复打死，
 * 但必须在日志里可见（与词库缺失同一 fail-open 权衡）。
 */
export function matchSensitive(text: string): SensitiveMatch {
  try {
    return matchWithTree(getSingleton().tree, text);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, "敏感词匹配异常（按未命中放行，需排查）");
    return { hit: false, words: [] };
  }
}
