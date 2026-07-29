import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * OSS 出来的 URL 必须是 https (7-30)。
 *
 * ## 病症
 *
 * ali-oss 默认吐 `http://` —— `put().url` 与 `signatureUrl()` 都是。7-29 背景图库上线后实测:
 *   入库成功、DB 有记录、接口返 200, 但管理页(https)里缩略图**空白** ——
 *   浏览器按混合内容(mixed content)把 http 图片拦掉了。看着像"没存进去", 实际存了。
 *
 * 签名 URL 同样是 http, DVH 音频/字幕靠它取件。阿里云服务端拉取现在不挑协议, 但哪天收紧到
 * 只收 https, 整条数字人链路会一起断。
 *
 * ## 为什么修在 storage 层而不是消费方
 *
 * URL 是 storage 产出的, 所有用它的地方(封面 / 音频 / 视频 / 混剪素材 / 背景图, 23 个调用点)
 * 都有这个问题。在背景图那边补一次, 其余照旧 —— 那就变成"同一个问题在 N 处各修各的"。
 * 用官方 `secure: true` 也好过字符串替换 http→https: 后者遇到自定义域/内网端点会改错。
 *
 * ## 锁什么
 *
 * 全仓任何 `new OSS({...})` 都必须带 `secure: true`。不比对真实 URL —— 那要连生产 OSS。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, "..");
const REPO_ROOT = resolve(HERE, "../../../..");

/** 收集所有 new OSS({...}) 的位置 */
function collectOssInits(roots: string[]): Array<{ file: string; hasSecure: boolean; snippet: string }> {
  const out: Array<{ file: string; hasSecure: boolean; snippet: string }> = [];
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|mjs|js)$/.test(name)) acc.push(p);
    }
    return acc;
  };

  for (const root of roots) {
    let files: string[] = [];
    try { files = walk(root); } catch { continue; }
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let idx = src.indexOf("new OSS(");
      while (idx !== -1) {
        // 取到配置对象闭合为止(够覆盖多行字面量; 这些初始化都很短)
        const chunk = src.slice(idx, idx + 900);
        const end = chunk.indexOf("});");
        const block = end === -1 ? chunk : chunk.slice(0, end + 3);
        out.push({
          file: relative(REPO_ROOT, f).split("\\").join("/"),
          hasSecure: /\bsecure\s*:\s*true\b/.test(block),
          snippet: block.replace(/\s+/g, " ").slice(0, 100),
        });
        idx = src.indexOf("new OSS(", idx + 1);
      }
    }
  }
  return out;
}

describe("OSS URL 必须走 https", () => {
  const inits = collectOssInits([SERVER_SRC, join(REPO_ROOT, "scripts")]);

  it("扫到了 OSS 初始化(扫不到说明扫描器本身坏了, 不能假绿)", () => {
    expect(inits.length).toBeGreaterThan(0);
  });

  it("每个 new OSS({...}) 都带 secure: true", () => {
    const missing = inits.filter((i) => !i.hasSecure);
    expect(
      missing.map((m) => `${m.file}  ${m.snippet}`),
      "以下 OSS 初始化没带 secure: true —— 它产出的 url / signatureUrl 会是 http://,\n" +
        "前端(https 页面)预览被混合内容拦掉, 且签名 URL 一旦被上游收紧到只收 https 就整条断。\n" +
        "别在消费方补 http→https 字符串替换, 在初始化处加 secure: true:",
    ).toEqual([]);
  });

  it("storage 层是唯一的 URL 出口 —— 消费方不许自己拼本项目桶的 URL", () => {
    const storageSrc = readFileSync(resolve(SERVER_SRC, "services/storage/index.ts"), "utf8");
    expect(storageSrc).toContain("secure: true");
    // upload/getSignedUrl 仍是对外接口(改名了这条会红, 提醒同步本测试)
    expect(storageSrc).toMatch(/async\s+upload\(/);
    expect(storageSrc).toMatch(/async\s+getSignedUrl\(/);
  });
});
