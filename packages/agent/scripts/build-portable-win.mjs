/**
 * 打包「免装 Node 的 Windows 便携客户包」。在有网络的机器(你的 Mac)上跑:
 *   node packages/agent/scripts/build-portable-win.mjs
 *
 * 产物: packages/agent/bossmate-agent-Windows-便携.zip
 *   内含: node.exe(便携Node) + node_modules(纯JS,跳过Chromium) + dist + start-agent.bat + bossmate.cfg + 使用说明.txt
 * 客户解压 → 双击 start-agent.bat → 零安装(用包内node + 系统Edge) → 输配对码 → 跑。
 *
 * 可选环境变量:
 *   NODE_VER   要打包的 Node 版本 (默认 v22.14.0)
 *   SERVER_URL 写进 cfg 的服务器地址 (默认 http://122.152.234.155)
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipFolder } from "./lib/zipdir.mjs";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const out = join(agentRoot, "dist-portable-win");
const NODE_VER = process.env.NODE_VER || "v22.14.0";
const SERVER_URL = process.env.SERVER_URL || "http://122.152.234.155";

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`);
  await new Promise((resolve, reject) => {
    const f = createWriteStream(dest);
    Readable.fromWeb(res.body).pipe(f).on("finish", resolve).on("error", reject);
  });
}

console.log(`1/6 构建 agent (tsc)…`);
execSync("npm run build", { cwd: agentRoot, stdio: "inherit" });

console.log(`2/6 准备目录…`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(agentRoot, "dist"), join(out, "dist"), { recursive: true });

console.log(`3/6 下载 Windows node.exe (${NODE_VER})…`);
await download(`https://nodejs.org/dist/${NODE_VER}/win-x64/node.exe`, join(out, "node.exe"));

console.log(`4/6 vendor 运行依赖 (跳过 Chromium, 纯 JS 可跨平台)…`);
const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "bossmate-agent-client", private: true, version: pkg.version, type: "module",
  dependencies: pkg.dependencies ?? {},
}, null, 2) + "\n");
execSync("npm install --omit=dev --no-audit --no-fund", {
  cwd: out, stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
});

console.log(`5/6 写启动器 + 配置 + 说明…`);
const bat = [
  "@echo off",
  "chcp 65001 >nul",
  "setlocal enabledelayedexpansion",
  'cd /d "%~dp0"',
  "title BossMate Agent",
  "echo ===================================================",
  "echo       BossMate Local Publisher Agent (portable)",
  "echo ===================================================",
  "echo.",
  'set "SERVER_URL="',
  'set "PAIR_CODE="',
  'set "DEVICE_NAME="',
  'if exist "bossmate.cfg" (',
  '  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("bossmate.cfg") do (',
  '    if /i "%%a"=="SERVER_URL" set "SERVER_URL=%%b"',
  '    if /i "%%a"=="PAIR_CODE"  set "PAIR_CODE=%%b"',
  '    if /i "%%a"=="DEVICE_NAME" set "DEVICE_NAME=%%b"',
  "  )",
  ")",
  'if "!DEVICE_NAME!"=="" set "DEVICE_NAME=%COMPUTERNAME%"',
  'set "NODE=%~dp0node.exe"',
  "",
  'if exist "%USERPROFILE%\\.bossmate-agent\\config.json" goto run_section',
  "",
  ":pair_loop",
  '  if "!SERVER_URL!"=="" set /p "SERVER_URL=Server URL e.g. http://122.152.234.155 : "',
  '  if "!PAIR_CODE!"=="" set /p "PAIR_CODE=Pairing code 6 digits from the web : "',
  "  echo Pairing...",
  '  "%NODE%" dist\\cli.js pair "!SERVER_URL!" "!PAIR_CODE!" "!DEVICE_NAME!"',
  "  if errorlevel 1 (",
  "    echo.",
  "    echo Pairing failed. The code may have expired, valid only 10 minutes.",
  "    echo Ask for a fresh code, then enter it again.",
  '    set "PAIR_CODE="',
  "    goto pair_loop",
  "  )",
  "  echo.",
  "  echo Paired.",
  "",
  ":run_section",
  "echo.",
  "echo Checking account login... a browser opens for any not-yet-logged-in account.",
  '"%NODE%" dist\\cli.js ensure-login',
  "echo.",
  "echo Running. Keep this window open and do not let the computer sleep. Press Ctrl+C to stop.",
  "echo.",
  '"%NODE%" dist\\cli.js run',
  "echo.",
  "echo Agent stopped.",
  "pause",
  "",
].join("\r\n");
writeFileSync(join(out, "start-agent.bat"), bat, { encoding: "ascii" });

// 6-17: 双击即"登录/添加账号"。内容全 ASCII(中文会触发 GBK 闪退, 见历史教训); 中文提示由 node 进程输出。
const loginBat = [
  "@echo off",
  "setlocal enabledelayedexpansion",
  'cd /d "%~dp0"',
  "title BossMate Add Account",
  'set "NODE=%~dp0node.exe"',
  'if not exist "%USERPROFILE%\\.bossmate-agent\\config.json" goto notpaired',
  '"%NODE%" dist\\cli.js add',
  "echo.",
  "echo Done. To start auto-publishing, run start-agent.bat.",
  "pause",
  "exit /b 0",
  ":notpaired",
  "echo Not paired yet. Please run start-agent.bat first to pair, then come back.",
  "pause",
  "",
].join("\r\n");
writeFileSync(join(out, "登录账号.bat"), loginBat, { encoding: "ascii" });

writeFileSync(join(out, "bossmate.cfg"),
  "# 服务器地址已填好; 双击后按提示输入网页生成的6位配对码\r\n" +
  `SERVER_URL=${SERVER_URL}\r\nPAIR_CODE=\r\nDEVICE_NAME=\r\n`, { encoding: "utf8" });

writeFileSync(join(out, "使用说明.txt"),
  "BossMate 本地发布 Agent — Windows 便携版(免装 Node)\r\n\r\n" +
  "1. 解压本文件夹到任意位置(如桌面)。\r\n" +
  "2. 双击 start-agent.bat。\r\n" +
  "   - 若弹蓝色\"Windows 已保护你的电脑\": 点\"更多信息\" → \"仍要运行\"。\r\n" +
  "3. 窗口提示输入配对码时, 把对接人发你的 6 位数字敲进去回车。\r\n" +
  "4. 会自动弹出 Edge 浏览器, 用手机 App(抖音/微信)扫码登录账号(没有账号会先让你选平台登录一个)。\r\n" +
  "5. 之后保持窗口开着、电脑别休眠, 即自动发布。停止按 Ctrl+C。\r\n\r\n" +
  "【要再登录/添加一个新账号?】双击同目录的 登录账号.bat → 选平台(抖音/视频号)→ 扫码即可, 不用去网页建号。\r\n" +
  "【账号掉线/换号了?】同样双击 登录账号.bat 重新扫码; 或重开 start-agent.bat 也会自动给没登录的号补扫。\r\n\r\n" +
  "本版自带运行环境, 无需安装 Node.js, 用系统自带 Edge 浏览器。\r\n", { encoding: "utf8" });

console.log(`6/6 打包 zip…`);
const zipName = "bossmate-agent-Windows-便携.zip";
const zipPath = join(agentRoot, zipName);
rmSync(zipPath, { force: true });
await zipFolder(out, zipPath);
console.log(`\n完成 → ${zipPath}`);
console.log("把这个 zip 发给 Windows 客户即可(微信传文件, 别走浏览器下载)。");
