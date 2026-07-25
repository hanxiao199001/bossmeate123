#!/usr/bin/env node
/**
 * build 后置步骤: 把 src/ 下的**非 TS 资产**镜像拷进 dist/。
 *
 * 为什么需要它(7-25 交接前补):
 *   `pnpm --filter @bossmate/server build` 就是一句 `tsc`, 而 tsc **只输出 .js/.d.ts**,
 *   src 里的 .txt 资产一个都不进 dist。目前唯一的资产是
 *     src/services/work-wechat/sensitive-lexicon.txt   ← AI 客服出站敏感词硬闸的词库
 *   它现在能在生产跑起来, 靠的是 sensitive-filter.ts:resolveLexiconPath() 的
 *   "dist 路径找不到就把 /dist/ 换成 /src/ 再试一次"回退 —— 这个回退成立的前提是
 *   **部署目录里 src/ 还在**(现服务器是 git checkout, 所以在)。
 *
 *   但仓库根有 Dockerfile, 且它是 dist-only 部署(只 COPY packages/server/dist)。
 *   一旦接手方切容器/精简部署, src/ 不在了 → 词库文件找不到 → loadLexiconWords()
 *   返回空表 → **敏感词硬闸 fail-open(静默放行)**, 线上只留一行 error 日志。
 *   合规闸静默失效是最贵的一类事故, 所以把资产拷进 dist 做成 build 的一部分。
 *
 * 设计取舍:
 *   - 用 node 脚本而不是 `cp src/**\/*.txt dist/...`:
 *     ① 跨平台 —— 仓库有 Windows Agent 便携包, 接手人可能在 Windows 上 build,
 *        cmd/PowerShell 没有 cp, 且 shell 通配符展开行为不一致;
 *     ② 自动发现 —— 递归找所有 ASSET_EXTS 资产, 以后新增词库/模板不用再改 build 脚本;
 *     ③ 能失败得响 —— 见下面的 fail-loud。
 *   - fail-loud: 一个资产都没找到就 exit(1) 让 build 红掉。资产消失 = 合规闸失效,
 *     宁可构建期炸, 不要运行期静默。
 *   - 保留 sensitive-filter.ts 里的 src 回退兜底不动 —— 双保险, 互不冲突。
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const DIST = join(here, "..", "dist");

/** 需要随 build 进 dist 的资产扩展名。新增类型在这里加。 */
const ASSET_EXTS = new Set([".txt"]);

/** 必须存在的关键资产(相对 src 的路径)。缺了直接让 build 失败, 不允许静默。 */
const REQUIRED_ASSETS = ["services/work-wechat/sensitive-lexicon.txt"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (ASSET_EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

if (!existsSync(SRC)) {
  console.error(`[copy-assets] ❌ 找不到 src 目录: ${SRC}`);
  process.exit(1);
}
if (!existsSync(DIST)) {
  console.error(`[copy-assets] ❌ 找不到 dist 目录: ${DIST}（应先跑 tsc）`);
  process.exit(1);
}

const files = walk(SRC);
const copied = [];
for (const file of files) {
  const rel = relative(SRC, file);
  const target = join(DIST, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  copied.push(rel);
}

const missing = REQUIRED_ASSETS.filter((rel) => !existsSync(join(DIST, rel)));
if (missing.length > 0) {
  console.error(
    `[copy-assets] ❌ 关键资产未能进 dist: ${missing.join(", ")}\n` +
      `   这些文件是运行时硬依赖（如企微出站敏感词硬闸的词库）。缺失会导致合规闸 fail-open 静默失效。\n` +
      `   若确实移动/重命名了资产, 请同步改 packages/server/scripts/copy-assets.mjs 的 REQUIRED_ASSETS。`,
  );
  process.exit(1);
}

console.log(
  `[copy-assets] ✅ 已拷贝 ${copied.length} 个资产到 dist/：${copied.join(", ") || "(无)"}`,
);
