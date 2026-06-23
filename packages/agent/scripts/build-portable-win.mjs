import { readdirSync as fsReaddir, readFileSync as fsReadFile, writeFileSync as fsWriteFile } from "node:fs";
import { join as pathJoin } from "node:path";
import { createHash as nodeCreateHash } from "node:crypto";
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
import { execSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync, createWriteStream, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipFolder } from "./lib/zipdir.mjs";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");
const out = join(agentRoot, "dist-portable-win");
const NODE_VER = process.env.NODE_VER || "v22.14.0";
const CHROME_VERSION = process.env.CHROME_VERSION || "131.0.6778.204";
// 6-18: 从共享缓存复制 Chromium(由 prepare-chromium.mjs 预下), 打包绝不联网 — 否则网页下载卡"生成中"。
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
function bundleChromium(platform) {
  const exe = cachedChromiumExe(platform);
  if (!exe) { console.warn(`   \u672a\u627e\u5230 ${platform} Chromium \u7f13\u5b58 \u2014 \u56de\u9000\u7cfb\u7edf Edge(\u5148\u8dd1 prepare-chromium.mjs)`); return ""; }
  const cacheDir = join(CHROME_CACHE, platform);
  cpSync(cacheDir, join(out, "chrome", platform), { recursive: true });
  const rel = join("chrome", platform, relative(cacheDir, exe)); // POSIX(Linux构建)
  console.log(`   \u2713 ${platform} Chromium(\u7f13\u5b58) \u2192 ${rel}`);
  return rel;
}
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
// 6-19 自更新: 写 dist 版本号(与服务端 agent-release 同算法)。
writeDistVersion(join(out, "dist"));

console.log(`3/6 下载 Windows node.exe (${NODE_VER})…`);
const NODE_MIRROR = process.env.NODE_MIRROR || "https://cdn.npmmirror.com/binaries/node"; // 6-18 国内镜像
await download(`${NODE_MIRROR}/${NODE_VER}/win-x64/node.exe`, join(out, "node.exe"));

console.log(`4/6 vendor 运行依赖 (跳过 Chromium, 纯 JS 可跨平台)…`);
const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "bossmate-agent-client", private: true, version: pkg.version, type: "module",
  dependencies: pkg.dependencies ?? {},
}, null, 2) + "\n");
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund", {  // 6-17: --ignore-scripts 跳过 rebrowser 自带 Chromium postinstall(下面单独下 win64)
  cwd: out, stdio: "inherit", env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true" },
});
console.log("4.6/6 精简 node_modules…");
pruneNodeModules(join(out, "node_modules"));

console.log("4.5/6 内置 Chromium (从缓存复制, 秒级; 无缓存则回退系统 Edge)…");
const relWin = (bundleChromium("win64").split("/").join("\\")) || "chrome\\__no_chromium__\\chrome.exe";  // 空则用不存在占位(防 if exist 命中包目录)

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
  'rem 6-18: bundled standalone Chromium (fix system-Edge control / about:blank)',
  `set "BUNDLED_CHROME=%~dp0${relWin}"`,
  'if exist "%BUNDLED_CHROME%" set "BOSSMATE_BROWSER_PATH=%BUNDLED_CHROME%"',
  "",
  'rem 6-19 self-update: pull only the small agent code (dist); keep Chromium/Node/login',
  'if "!SERVER_URL!"=="" goto skip_update',
  '  set "RVER="',
  '  for /f "usebackq delims=" %%v in (`curl -fsS --max-time 8 "!SERVER_URL!/api/v1/agent/release/version" 2^>nul`) do set "RVER=%%v"',
  '  if "!RVER!"=="" goto skip_update',
  '  set "LVER="',
  '  if exist "dist\\.version" set /p LVER=<dist\\.version',
  '  if "!RVER!"=="!LVER!" goto skip_update',
  '  echo Updating agent code (tens of KB), your login is preserved...',
  '  curl -fsS --max-time 60 "!SERVER_URL!/api/v1/agent/release/dist.tgz" -o "%TEMP%\\bm-dist.tgz" 2>nul',
  '  if not exist "%TEMP%\\bm-dist.tgz" goto skip_update',
  '  rmdir /s /q "%TEMP%\\bm-dist-new" 2>nul',
  '  mkdir "%TEMP%\\bm-dist-new"',
  '  tar -xzf "%TEMP%\\bm-dist.tgz" -C "%TEMP%\\bm-dist-new" 2>nul',
  '  if exist "%TEMP%\\bm-dist-new\\dist\\cli.js" (',
  '    rmdir /s /q dist 2>nul',
  '    move "%TEMP%\\bm-dist-new\\dist" dist >nul',
  '    >dist\\.version echo !RVER!',
  '    echo Updated to latest.',
  '  )',
  '  rmdir /s /q "%TEMP%\\bm-dist-new" 2>nul',
  '  del "%TEMP%\\bm-dist.tgz" 2>nul',
  ':skip_update',
  "",
  'if exist "%USERPROFILE%\\\\.bossmate-agent\\\\config.json" goto run_section',
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
  "rem 6-23: 转常驻后台服务(schtasks 计划任务: 登录自启+看门狗拉起), 用包内 node(process.execPath)。",
  "echo Setting up background service (auto-start on login, survives window close)...",
  '"%NODE%" dist\\cli.js install-service',
  "if errorlevel 1 (",
  "  echo.",
  "  echo Could not install background service (may need Administrator). Falling back to foreground.",
  "  echo Keep this window open and do not let the computer sleep. Press Ctrl+C to stop.",
  '  "%NODE%" dist\\cli.js run',
  "  echo.",
  "  echo Agent stopped.",
  "  pause",
  "  exit /b 0",
  ")",
  "timeout /t 2 >nul",
  'start "" "http://localhost:17653"',
  "echo.",
  "echo [OK] Running in background now. You can CLOSE this window.",
  '  echo   - Add accounts: use the "Add Publishing Account" page that just opened.',
  '  echo   - To stop background service: double-click "stop-agent.bat".',
  "echo.",
  "pause",
  "exit /b 0",
  "",
].join("\r\n");
writeFileSync(join(out, "start-agent.bat"), bat, { encoding: "ascii" });

// 6-17: 双击即"登录/添加账号"。内容全 ASCII(中文会触发 GBK 闪退, 见历史教训); 中文提示由 node 进程输出。
// 6-18: 双击打开本机"添加账号"控制台(需 start-agent.bat 正在运行)。内容全 ASCII(中文会触发 GBK 闪退)。
const addBat = [
  "@echo off",
  'start "" "http://localhost:17653"',
  "",
].join("\r\n");
writeFileSync(join(out, "添加账号.bat"), addBat, { encoding: "ascii" });

// 6-22: 清理旧客户端(设备吊销卡死一键重置, commit 33f5f66) — 拷 launcher 源(内容全英文 ASCII), 归一化 CRLF。
const cleanupBat = readFileSync(join(agentRoot, "launcher", "清理旧客户端.bat"), "utf8").replace(/\r?\n/g, "\r\n");
writeFileSync(join(out, "清理旧客户端.bat"), cleanupBat, { encoding: "ascii" });

// 6-23: 停止常驻后台服务 — 卸载 schtasks 计划任务(登录/账号保留)。用包内 node。ASCII.
const stopBat = [
  "@echo off",
  "chcp 65001 >nul",
  'cd /d "%~dp0"',
  "title BossMate Agent - Stop",
  "echo ===================================================",
  "echo     BossMate Agent - Stop Background Service",
  "echo ===================================================",
  "echo.",
  "echo This stops the background publisher service and disables auto-start.",
  "echo Your logins/accounts are kept. To start again, double-click start-agent.bat.",
  "echo.",
  'set "NODE=%~dp0node.exe"',
  '"%NODE%" dist\\cli.js uninstall-service',
  "echo.",
  "echo Done. Press any key to close.",
  "pause >nul",
  "",
].join("\r\n");
writeFileSync(join(out, "stop-agent.bat"), stopBat, { encoding: "ascii" });

writeFileSync(join(out, "bossmate.cfg"),
  "# 服务器地址已填好; 双击后按提示输入网页生成的6位配对码\r\n" +
  `SERVER_URL=${SERVER_URL}\r\nPAIR_CODE=\r\nDEVICE_NAME=\r\n`, { encoding: "utf8" });

writeFileSync(join(out, "使用说明.txt"),
  "BossMate 本地发布 Agent — Windows 便携版(免装 Node)\r\n\r\n" +
  "1. 解压本文件夹到任意位置(如桌面)。\r\n" +
  "2. 双击 start-agent.bat。\r\n" +
  "   - 若弹蓝色\"Windows 已保护你的电脑\": 点\"更多信息\" → \"仍要运行\"。\r\n" +
  "3. 窗口提示输入配对码时, 把对接人发你的 6 位数字敲进去回车。\r\n" +
  "4. 启动后会自动打开一个\"添加账号\"网页, 点【登录抖音】或【登录视频号】→ 弹出 Edge 登录页用手机扫码 → 这个号就加好并绑定本机。可重复点, 加多个号。\r\n" +
  "5. 之后保持窗口开着、电脑别休眠, 即自动发布。停止按 Ctrl+C。\r\n\r\n" +
  "【想再加号 / 网页关了?】双击同目录的 添加账号.bat 重新打开那个网页, 点按钮扫码即可(全程只扫码, 不用输入)。\r\n" +
  "【账号掉线了?】不用管, 下次要发它时会自动弹出二维码让你重扫。\r\n\r\n" +
  "本版自带运行环境, 无需安装 Node.js, 用系统自带 Edge 浏览器。\r\n", { encoding: "utf8" });

console.log(`6/6 打包 zip…`);
const zipName = "bossmate-agent-Windows-便携.zip";
const zipPath = join(agentRoot, zipName);
rmSync(zipPath, { force: true });
await zipFolder(out, zipPath);
console.log(`\n完成 → ${zipPath}`);
console.log("把这个 zip 发给 Windows 客户即可(微信传文件, 别走浏览器下载)。");
