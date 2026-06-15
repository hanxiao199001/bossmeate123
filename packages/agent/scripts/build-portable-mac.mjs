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
execSync("npm install --omit=dev --no-audit --no-fund", {
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
  '  echo "配对成功! 接下来扫码登录账号: 会弹出浏览器, 请用对应账号手机 App 扫码。"',
  '  "$NODE" dist/cli.js login --all || true',
  "  echo",
  "fi",
  "",
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

writeFileSync(join(out, "bossmate.cfg"),
  "# 服务器地址已填好; 双击后按提示输入网页生成的6位配对码\n" +
  `SERVER_URL=${SERVER_URL}\nPAIR_CODE=\nDEVICE_NAME=\n`, { encoding: "utf8" });

writeFileSync(join(out, "使用说明.txt"),
  "BossMate 本地发布 Agent — Mac 便携版(免装 Node)\n\n" +
  "1. 解压本文件夹到任意位置(如桌面)。\n" +
  "2. 双击 start-agent.command。\n" +
  "   - 若提示\"无法打开, 来自身份不明的开发者\": 右键点 start-agent.command → 选\"打开\" → 再点\"打开\"(只需一次)。\n" +
  "3. 窗口提示输入配对码时, 把对接人发你的 6 位数字敲进去回车(过期了会让你重输, 不会卡死)。\n" +
  "4. 会弹出浏览器, 用手机 App(抖音/微信)扫码登录账号。\n" +
  "5. 之后保持窗口开着、电脑别休眠, 即自动发布。停止按 Ctrl + C。\n\n" +
  "本版自带运行环境, 无需安装 Node.js, 用系统自带 Edge/Chrome 浏览器。\n", { encoding: "utf8" });

console.log("6/6 打包 zip…");
const zipPath = join(agentRoot, "bossmate-agent-Mac-便携.zip");
rmSync(zipPath, { force: true });
try {
  execSync(`cd "${out}" && zip -r -q -X "${zipPath}" .`, { stdio: "inherit", shell: "/bin/bash" });
} catch {
  console.log("系统 zip 不可用, 请手动把 dist-portable-mac 文件夹压成 zip。");
}
console.log(`\n完成 → ${zipPath}`);
console.log("把这个 zip 发给 Mac 客户即可(微信传文件)。Intel/Apple Silicon 都能跑。");
