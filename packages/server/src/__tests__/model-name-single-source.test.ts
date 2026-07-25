import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 7-25 事故守卫: 模型名单一真相源。
 *
 * 事故经过: DeepSeek 官方下线 deepseek-chat / deepseek-reasoner, API 只认 deepseek-v4-pro /
 *   deepseek-v4-flash。项目里 model-router 走 env.DEEPSEEK_MODEL_CHAT(改 .env 即可救), 但
 *   workflow / style-learner / keyword-cluster / topic-skill 共 11 处**硬编码** `model:
 *   "deepseek-chat"` 绕开了这套 —— 热修 .env 救不了它们, 只能改代码重发。400 是客户端错误,
 *   不触发 qwen-plus 兜底, 于是这些链路直接吐"抱歉，AI暂时无法响应"占位文并落库。
 *
 * 本测试锁死: 业务代码里不得再出现硬编码模型名, 一律走 env.*_MODEL_*。
 *   允许出现的地方只有三处 —— config/env.ts(默认值本身)、billing/llm-cost.ts(价目表键名)、
 *   __tests__(mock env)。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

/** 允许出现模型名字面量的文件(相对 packages/server/src) */
const ALLOWED = [
  "config/env.ts",            // 默认值定义处 = 真相源
  "services/billing/llm-cost.ts", // 价目表的键必须是字面模型名
];

/** 认得出的模型名字面量(带引号, 避免误伤注释里的散文) */
const MODEL_LITERAL = /["'](deepseek-[a-z0-9.-]+|qwen-(?:plus|max|turbo)[a-z0-9.-]*)["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("模型名单一真相源(7-25 DeepSeek 下线事故守卫)", () => {
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (ALLOWED.includes(rel)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      // 跳过注释行 —— 注释里写模型名是说明, 不是调用
      const t = text.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (MODEL_LITERAL.test(text)) offenders.push({ file: rel, line: i + 1, text: t.slice(0, 100) });
    });
  }

  it("业务代码不得硬编码模型名, 一律走 env.DEEPSEEK_MODEL_* / env.QWEN_MODEL_*", () => {
    expect(
      offenders,
      `发现硬编码模型名(改 .env 救不了这些调用点):\n` +
        offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n")
    ).toEqual([]);
  });

  it("已下线的 deepseek-chat / deepseek-reasoner 不再作为默认值", async () => {
    const envSrc = readFileSync(resolve(SRC, "config/env.ts"), "utf8");
    expect(envSrc).not.toMatch(/DEEPSEEK_MODEL_CHAT:\s*z\.string\(\)\.default\("deepseek-chat"\)/);
    expect(envSrc).not.toMatch(/DEEPSEEK_MODEL_REASONER:\s*z\.string\(\)\.default\("deepseek-reasoner"\)/);
  });

  it("价目表覆盖当前在用的模型, 否则成本记 0(预算闸/花费告警失明)", async () => {
    const costSrc = readFileSync(resolve(SRC, "services/billing/llm-cost.ts"), "utf8");
    for (const m of ["deepseek-v4-pro", "deepseek-v4-flash", "qwen-plus"]) {
      expect(costSrc).toContain(`"${m}"`);
    }
  });
});
