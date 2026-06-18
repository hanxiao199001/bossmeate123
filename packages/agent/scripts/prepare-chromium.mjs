/**
 * 6-18: 一次性把 Chromium 下到共享缓存 packages/agent/.chromium-cache/<platform>。
 * 打包脚本(build-portable-*.mjs)只从这个缓存"复制"、绝不联网 —— 否则网页一键下载会卡在"生成中"。
 *
 * 用法(在服务器仓库根跑一次, deploy 后):
 *   node packages/agent/scripts/prepare-chromium.mjs            # 下全部平台(mac_arm + mac + win64)
 *   node packages/agent/scripts/prepare-chromium.mjs win64      # 只下某平台
 *
 * 国内优先 npmmirror 镜像, 失败再用官方 CDN。下成后再让客户网页下载即带 Chromium。
 */
import { execFileSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const repoRoot = join(agentRoot, "..", "..");
const CHROME_CACHE = join(agentRoot, ".chromium-cache");
const CHROME_VERSION = process.env.CHROME_VERSION || "131.0.6778.204";
const MIRROR = process.env.CHROME_MIRROR || "https://cdn.npmmirror.com/binaries/chrome-for-testing";

// 定位 @puppeteer/browsers 的 CLI(pnpm 结构下用 find 最稳)
function findCli() {
  for (const base of [agentRoot, repoRoot]) {
    const cand = join(base, "node_modules", "@puppeteer", "browsers", "lib", "cjs", "main-cli.js");
    if (existsSync(cand)) return cand;
  }
  try {
    const hit = execSync(
      `find ${JSON.stringify(join(repoRoot, "node_modules"))} -path "*@puppeteer/browsers/lib/cjs/main-cli.js" 2>/dev/null | head -1`,
      { encoding: "utf8" },
    ).trim();
    if (hit) return hit;
  } catch { /* noop */ }
  return null;
}

const cli = findCli();
if (!cli) {
  console.error("✗ 找不到 @puppeteer/browsers CLI。请先在仓库根 `pnpm install`。");
  process.exit(1);
}
console.log("用 CLI:", cli);

const platforms = process.argv[2] ? [process.argv[2]] : ["mac_arm", "mac", "win64"];
let failed = 0;
for (const p of platforms) {
  const dest = join(CHROME_CACHE, p);
  console.log(`\n=== 下载 Chromium ${p}@${CHROME_VERSION} → ${dest} ===`);
  const attempts = [
    ["install", `chrome@${CHROME_VERSION}`, "--platform", p, "--path", dest, "--base-url", MIRROR],
    ["install", `chrome@${CHROME_VERSION}`, "--platform", p, "--path", dest],
  ];
  let ok = false;
  for (const args of attempts) {
    const src = args.includes("--base-url") ? "npmmirror 镜像" : "官方 CDN";
    try {
      console.log(`  尝试 ${src} …`);
      execFileSync("node", [cli, ...args], { stdio: "inherit", timeout: 900000 });
      ok = true;
      break;
    } catch (e) {
      console.warn(`  ${src} 失败: ${String(e.message || e).slice(0, 160)}`);
    }
  }
  if (ok) console.log(`  ✓ ${p} 完成`);
  else { failed++; console.error(`  ✗ ${p} 两个源都失败`); }
}

console.log(failed === 0
  ? "\n✅ 全部完成。现在网页下载客户包会从缓存秒级打包并带上 Chromium。"
  : `\n⚠️ 有 ${failed} 个平台没下成。下成的平台仍会带 Chromium, 没下成的回退系统 Edge。可重跑本脚本重试失败的平台。`);
