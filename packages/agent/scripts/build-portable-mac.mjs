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
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipFolder } from "./lib/zipdir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const out = join(agentRoot, "dist-portable-mac");
const NODE_VER = process.env.NODE_VER || "v18.20.4";
const SERVER_URL = process.env.SERVER_URL || "http://122.152.234.155";

function fetchNodeBin(arch, outBin) {
  const dirName = `node-${NODE_VER}-darwin-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VER}/${dirName}.tar.gz`;
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

console.log(`3/6 下载便携 Node ${NODE_VER} (arm64 + x64)…`);
fetchNodeBin("arm64", join(out, "bin", "node-arm64"));
fetchNodeBin("x64", join(out, "bin", "node-x64"));

console.log("4/6 vendor 运行依赖 (跳过 Chromium, 纯 JS)…");
const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "bossmate-agent-client", private: true, version: pkg.version, type: "module",
  dependencies: pkg.dependencies ?? {},
}, null, 2) + "\n");
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", {  // 6-17: --ignore-scripts 跳过 rebrowser Chromium 下载 postinstall(便携用系统Edge, 不加会拖崩→node_modules不全→缺puppeteer-extra)
  cwd: out, stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
});

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
