/**
 * 打包客户端启动包 — admin 跑一次, 产出可直接 zip 发给客户的双击启动包。
 *
 * 用法 (仓库根或任意处):
 *   node packages/agent/scripts/package-client.mjs
 *
 * 产物: packages/agent/dist-client/
 *   dist/                预构建 CLI (客户不用构建)
 *   package.json         只含运行依赖 (客户首次双击时 npm install)
 *   start-agent.command  Mac 双击启动器
 *   start-agent.bat      Windows 双击启动器
 *   bossmate.cfg         空配置 (用网页"下载客户配置"覆盖即免输码)
 *   使用说明.txt
 *
 * 把整个 dist-client 文件夹压成 zip 发客户即可。
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = join(here, "..");            // packages/agent
const out = join(agentRoot, "dist-client");

console.log("1/4 构建 agent (tsc)…");
execSync("npm run build", { cwd: agentRoot, stdio: "inherit" });

console.log("2/4 组装客户包目录…");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(agentRoot, "dist"), join(out, "dist"), { recursive: true });

// 运行时 package.json: 只留运行依赖, 客户首次双击 npm install --omit=dev
const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8"));
const runtimePkg = {
  name: "bossmate-agent-client",
  private: true,
  version: pkg.version,
  type: "module",
  dependencies: pkg.dependencies ?? {},
};
writeFileSync(join(out, "package.json"), JSON.stringify(runtimePkg, null, 2) + "\n");

console.log("3/4 拷贝启动器 + 说明…");
for (const f of ["start-agent.command", "start-agent.bat", "使用说明.txt"]) {
  cpSync(join(agentRoot, "launcher", f), join(out, f));
}
try { chmodSync(join(out, "start-agent.command"), 0o755); } catch { /* win 上忽略 */ }

if (!existsSync(join(out, "bossmate.cfg"))) {
  writeFileSync(
    join(out, "bossmate.cfg"),
    "# 用网页「设置 → 本地发布 Agent → 下载客户配置」下载的文件覆盖本文件, 即可免输配对码\n" +
      "SERVER_URL=\nPAIR_CODE=\nDEVICE_NAME=\n",
  );
}

console.log("4/4 完成 →", out);
console.log("把 dist-client 整个文件夹压成 zip 发给客户即可 (客户解压后双击启动器)。");
