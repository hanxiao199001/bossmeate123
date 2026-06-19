import { readdirSync as fsReaddir, readFileSync as fsReadFile, writeFileSync as fsWriteFile } from "node:fs";
import { join as pathJoin } from "node:path";
import { createHash as nodeCreateHash } from "node:crypto";
/**
 * 打包「免装 Node 的 Mac 便携客户包」。在 Mac 上跑(有网络):
 *   node packages/agent/scripts/build-portable-mac.mjs
 *
 * 产物: packages/agent/bossmate-agent-Mac-便携.zip
 *   内含: bin/node-arm64 + bin/node-x64(便携Node, 双架构通吃) + node_modules(纯JS,跳Chromium)
 *         + dist + start-agent.command + bossmate.cfg + 使用说明.txt
 * 客户解压 → 双击 start-agent.command → 零安装(用包内node + 系统Edge/Chrome) → 输配对码 → 跑。
 *
 * 环境变量: NODE_VER(默认 v18.20.4, 兼容 macOS 10.15+), SERVER_URL(默认 http://122.152.234.155)
 */
import { execSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipFolder } from "./lib/zipdir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const out = join(agentRoot, "dist-portable-mac");
const NODE_VER = process.env.NODE_VER || "v18.20.4";
// 6-18: 内置独立 Chromium 版本(对齐 rebrowser-puppeteer@23.10.3, 老韩 Mac 实测下过此版)。
const CHROME_VERSION = process.env.CHROME_VERSION || "131.0.6778.204";
// 6-18: 共享 Chromium 缓存(由 prepare-chromium.mjs 预下)。打包只从缓存"复制", 绝不联网下载 —
// 否则网页下载会卡在"生成中"(现下 150-300MB)。缓存空则跳过, 客户端回退系统 Edge。
const CHROME_CACHE = join(agentRoot, ".chromium-cache");
// 6-18: 精简 node_modules — 删运行时用不到的(TS源码/类型/map/文档/测试/license), 大幅减小客户包体积。
// 只保留 .js/.json/.node 等运行时真需要的。在 Linux 服务器上用 find 执行。
function writeDistVersion(distDir) {
  try {
    const walk = (d) => fsReaddir(d, { withFileTypes: true }).flatMap((e) => {
      const fp = pathJoin(d, e.name);
      return e.isDirectory() ? walk(fp) : [fp];
    });
    const files = walk(distDir).filter((f) => f.endsWith(".js")).sort();
    const h = nodeCreateHash("sha1");
    for (const f of files) h.update(fsReadFile(f));
    const v = h.digest("hex").slice(0, 12);
    fsWriteFile(pathJoin(distDir, ".version"), v);
    console.log("   dist 版本:", v);
  } catch (e) { console.warn("   写 dist/.version 失败(不影响):", e.message); }
}

function pruneNodeModules(nm) {
  if (!existsSync(nm)) return;
  const before = (() => { try { return execSync(`du -sm ${JSON.stringify(nm)} | cut -f1`, { encoding: "utf8" }).trim(); } catch { return "?"; } })();
  try {
    execSync(`find ${JSON.stringify(nm)} -type f \\( -name "*.ts" -o -name "*.map" -o -name "*.md" -o -name "*.markdown" -o -name "*.flow" -o -iname "license*" -o -iname "readme*" -o -name "*.h" -o -name "*.cc" -o -name "*.gyp" \\) -delete 2>/dev/null || true`);
    execSync(`find ${JSON.stringify(nm)} -type d \\( -name test -o -name tests -o -name __tests__ -o -name example -o -name examples -o -name docs -o -name doc -o -name ".github" -o -name "coverage" \\) -prune -exec rm -rf {} + 2>/dev/null || true`);
  } catch { /* 非致命 */ }
  const after = (() => { try { return execSync(`du -sm ${JSON.stringify(nm)} | cut -f1`, { encoding: "utf8" }).trim(); } catch { return "?"; } })();
  console.log(`   node_modules 瘦身: ${before}MB → ${after}MB`);
}
function cachedChromiumExe(platform) {
  const dir = join(CHROME_CACHE, platform);
  if (!existsSync(dir)) return null;
  const name = platform === "win64" ? "chrome.exe" : "Google Chrome for Testing";
  try {
    const found = execSync(`find ${JSON.stringify(dir)} -type f -name ${JSON.stringify(name)}`, { encoding: "utf8" }).trim().split("\n")[0];
    return found || null;
  } catch { return null; }
}
// 把某平台缓存的 Chromium 复制进包, 返回包内相对 exe 路径(/ 分隔); 缓存没有则返回 ""。
function bundleChromium(platform) {
  const exe = cachedChromiumExe(platform);
  if (!exe) { console.warn(`   未找到 ${platform} 的 Chromium 缓存 — 本平台回退系统 Edge(先在服务器跑 prepare-chromium.mjs 预热)`); return ""; }
  const cacheDir = join(CHROME_CACHE, platform);
  cpSync(cacheDir, join(out, "chrome", platform), { recursive: true });
  const rel = join("chrome", platform, relative(cacheDir, exe));
  console.log(`   ✓ ${platform} Chromium(缓存) → ${rel}`);
  return rel;
}
const SERVER_URL = process.env.SERVER_URL || "http://122.152.234.155";

function fetchNodeBin(arch, outBin) {
  const dirName = `node-${NODE_VER}-darwin-${arch}`;
  const NODE_MIRROR = process.env.NODE_MIRROR || "https://cdn.npmmirror.com/binaries/node"; // 6-18 国内镜像, 去掉 nodejs.org 依赖
  const url = `${NODE_MIRROR}/${NODE_VER}/${dirName}.tar.gz`;
  const tmp = `/tmp/bm-node-${arch}`;
  execSync(
    `rm -rf "${tmp}" && mkdir -p "${tmp}" && cd "${tmp}" && curl -fsSL "${url}" -o n.tgz && tar -xzf n.tgz "${dirName}/bin/node"`,
    { stdio: "inherit", shell: "/bin/bash" },
  );
  cpSync(join(tmp, dirName, "bin", "node"), outBin);
  chmodSync(outBin, 0o755);
  rmSync(tmp, { recursive: true, force: true });
}

console.log("1/6 构建 agent (tsc)…");
execSync("npm run build", { cwd: agentRoot, stdio: "inherit" });

console.log("2/6 准备目录…");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
cpSync(join(agentRoot, "dist"), join(out, "dist"), { recursive: true });
// 6-19 自更新: 写入 dist 版本号(与服务端 agent-release 同算法), 客户包首次启动不会空跑一次更新。
writeDistVersion(join(out, "dist"));

console.log(`3/6 下载便携 Node ${NODE_VER} (arm64 + x64)…`);
fetchNodeBin("arm64", join(out, "bin", "node-arm64"));
fetchNodeBin("x64", join(out, "bin", "node-x64"));

console.log("4/6 vendor 运行依赖 (跳过 Chromium, 纯 JS)…");
const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "bossmate-agent-client", private: true, version: pkg.version, type: "module",
  dependencies: pkg.dependencies ?? {},
}, null, 2) + "\n");
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", {  // 6-17: --ignore-scripts 跳过 rebrowser 自带 Chromium postinstall(下面单独下指定平台的)
  cwd: out, stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
});
console.log("4.6/6 精简 node_modules…");
pruneNodeModules(join(out, "node_modules"));

console.log("4.5/6 内置 Chromium (从缓存复制, 秒级; 无缓存则回退系统 Edge)…");
const relArm = bundleChromium("mac_arm");
const relX64 = bundleChromium("mac");

console.log("5/6 写启动器 + 配置 + 说明…");
const cmd = [
  "#!/bin/bash",
  'DIR="$(cd "$(dirname "$0")" && pwd)"',
  'cd "$DIR" || exit 1',
  '# 去隔离: 微信/浏览器下载会给文件打 com.apple.quarantine, 不清的话包内 node 会被 Gatekeeper 拦',
  'xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true',
  "clear",
  'echo "==================================================="',
  'echo "      BossMate 本地发布 Agent (便携版)"',
  'echo "==================================================="',
  "echo",
  'ARCH="$(uname -m)"',
  'if [ "$ARCH" = "arm64" ]; then NODE="$DIR/bin/node-arm64"; else NODE="$DIR/bin/node-x64"; fi',
  'chmod +x "$NODE" 2>/dev/null || true',
  '# 6-18: 内置独立 Chromium(根治系统 Edge 控制错页/卡 about:blank), 按架构选; 不在则回退系统 Edge。',
  `ARM_CHROME="$DIR/${relArm}"`,
  `X64_CHROME="$DIR/${relX64}"`,
  'if [ "$ARCH" = "arm64" ] && [ -f "$ARM_CHROME" ]; then export BOSSMATE_BROWSER_PATH="$ARM_CHROME"; elif [ -f "$X64_CHROME" ]; then export BOSSMATE_BROWSER_PATH="$X64_CHROME"; fi',
  '[ -n "$BOSSMATE_BROWSER_PATH" ] && chmod +x "$BOSSMATE_BROWSER_PATH" 2>/dev/null; if [ -n "$BOSSMATE_BROWSER_PATH" ]; then echo "浏览器: 内置 Chromium"; else echo "浏览器: 回退系统 Edge/Chrome"; fi',
  "",
  'SERVER_URL=""; PAIR_CODE=""; DEVICE_NAME=""',
  'if [ -f "bossmate.cfg" ]; then',
  "  while IFS='=' read -r k v; do",
  "    key=\"$(printf '%s' \"$k\" | tr -d '[:space:]')\"",
  "    val=\"$(printf '%s' \"$v\" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')\"",
  '    case "$key" in',
  '      SERVER_URL) SERVER_URL="$val" ;;',
  '      PAIR_CODE)  PAIR_CODE="$val" ;;',
  '      DEVICE_NAME) DEVICE_NAME="$val" ;;',
  "    esac",
  "  done < <(grep -v '^[[:space:]]*#' bossmate.cfg)",
  "fi",
  '[ -z "$DEVICE_NAME" ] && DEVICE_NAME="$(hostname)"',
  "",
  '# 6-19 自更新: 只拉小小的 agent 代码(dist), Chromium/Node/登录态全保留 — 不必重下整包。',
  'if [ -n "$SERVER_URL" ]; then',
  '  RVER="$(curl -fsS --max-time 8 "$SERVER_URL/api/v1/agent/release/version" 2>/dev/null | tr -dc "0-9a-f")"',
  '  LVER="$(cat dist/.version 2>/dev/null | tr -dc "0-9a-f")"',
  '  if [ -n "$RVER" ] && [ "$RVER" != "$LVER" ]; then',
  '    echo "发现新版本, 正在更新(仅几十KB, 登录态不受影响)…"',
  '    if curl -fsS --max-time 60 "$SERVER_URL/api/v1/agent/release/dist.tgz" -o /tmp/bm-dist.tgz 2>/dev/null; then',
  '      rm -rf /tmp/bm-dist.new && mkdir -p /tmp/bm-dist.new && tar -xzf /tmp/bm-dist.tgz -C /tmp/bm-dist.new 2>/dev/null && [ -d /tmp/bm-dist.new/dist ] && rm -rf dist && mv /tmp/bm-dist.new/dist dist && printf "%s" "$RVER" > dist/.version && echo "已更新到最新版。" || echo "(更新失败, 用当前版本继续)"',
  '      rm -rf /tmp/bm-dist.new /tmp/bm-dist.tgz',
  '    else',
  '      echo "(联网检查更新失败, 用当前版本继续)"',
  '    fi',
  '  fi',
  'fi',
  "",
  'if [ ! -f "$HOME/.bossmate-agent/config.json" ]; then',
  "  while true; do",
  '    [ -z "$SERVER_URL" ] && read -r -p "服务器地址 (如 http://122.152.234.155): " SERVER_URL',
  '    [ -z "$PAIR_CODE" ] && read -r -p "配对码 (6 位, 网页生成): " PAIR_CODE',
  '    echo "正在配对…"',
  '    if "$NODE" dist/cli.js pair "$SERVER_URL" "$PAIR_CODE" "$DEVICE_NAME"; then',
  "      break",
  "    fi",
  "    echo",
  '    echo "配对失败 — 配对码可能已过期(10 分钟有效)。请让对接人重发一个新码, 然后重新输入。"',
  "    echo",
  '    PAIR_CODE=""',
  "  done",
  "  echo",
  '  echo "配对成功!"',
  "  echo",
  "fi",
  "",
  '# 6-17: 每次启动给"本机还没登录"的账号补扫码(已登录的自动跳过; 一个账号都没有则引导登录一个)',
  'echo "检查账号登录状态… 有没登录的会弹出浏览器扫码(已登录的会跳过)。"',
  '"$NODE" dist/cli.js ensure-login || true',
  "echo",
  'echo "开始挂机自动发布。请保持本窗口开着、电脑不要休眠。停止请按 Ctrl + C。"',
  "echo",
  'caffeinate -i "$NODE" dist/cli.js run',
  "echo",
  'echo "Agent 已停止。按回车键关闭窗口。"',
  "read -r _",
  "",
].join("\n");
writeFileSync(join(out, "start-agent.command"), cmd, { encoding: "utf8" });
chmodSync(join(out, "start-agent.command"), 0o755);

// 6-17: 双击即"登录新账号" — 选平台→弹浏览器扫码→自动建号绑定本机, 不用去网页建号、不碰终端。
// 6-18: 双击打开本机"添加账号"控制台(两个按钮: 登录抖音/视频号), 客户点一下扫码即加好。
// 需 start-agent.command 正在运行(它会起本地控制台并自动打开此页; 关了可用本启动器再开)。
const addCmd = [
  "#!/bin/bash",
  'open "http://localhost:17653" 2>/dev/null || true',
  "",
].join("\n");
writeFileSync(join(out, "添加账号.command"), addCmd, { encoding: "utf8" });
chmodSync(join(out, "添加账号.command"), 0o755);

writeFileSync(join(out, "bossmate.cfg"),
  "# 服务器地址已填好; 双击后按提示输入网页生成的6位配对码\n" +
  `SERVER_URL=${SERVER_URL}\nPAIR_CODE=\nDEVICE_NAME=\n`, { encoding: "utf8" });

writeFileSync(join(out, "使用说明.txt"),
  "BossMate 本地发布 Agent — Mac 便携版(免装 Node)\n\n" +
  "1. 解压本文件夹到任意位置(如桌面)。\n" +
  "2. 双击 start-agent.command。\n" +
  "   - 若提示\"无法打开, 来自身份不明的开发者\": 右键点 start-agent.command → 选\"打开\" → 再点\"打开\"(只需一次)。\n" +
  "3. 窗口提示输入配对码时, 把对接人发你的 6 位数字敲进去回车(过期了会让你重输, 不会卡死)。\n" +
  "4. 启动后会自动打开一个\"添加账号\"网页, 点【登录抖音】或【登录视频号】→ 弹出登录页用手机扫码 → 这个号就加好并绑定本机了。可重复点, 加多个号。\n" +
  "5. 之后保持窗口开着、电脑别休眠, 即自动发布。停止按 Ctrl + C。\n\n" +
  "【想再加号 / 网页关了?】双击同目录的 \"添加账号.command\" 重新打开那个网页, 点按钮扫码即可(全程只扫码, 不用输入)。\n" +
  "【账号掉线了?】不用管, 下次要发它时会自动弹出二维码让你重扫。\n\n" +
  "本版自带运行环境, 无需安装 Node.js, 用系统自带 Edge/Chrome 浏览器。\n", { encoding: "utf8" });

console.log("6/6 打包 zip…");
const zipPath = join(agentRoot, "bossmate-agent-Mac-便携.zip");
rmSync(zipPath, { force: true });
await zipFolder(out, zipPath);
console.log(`\n完成 → ${zipPath}`);
console.log("把这个 zip 发给 Mac 客户即可(微信传文件)。Intel/Apple Silicon 都能跑。");
