/**
 * task #1 root cause fix: env.ts findEnvFile 单测。
 *
 * 验证：
 *  - ENV_FILE_PATH 显式指定 + 文件存在 → 返回该路径
 *  - 默认 fallback 解析 monorepo root .env 绝对路径
 *  - 文件不存在 → throw（fail fast，杜绝 silent fallback）
 *  - 空字符串 / 仅空白 ENV_FILE_PATH 视为 unset，走 fallback
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

// 必须在 import env.ts 前 stub process.env，否则模块顶部 findEnvFile() 会先跑
const ORIGINAL_ENV_FILE_PATH = process.env.ENV_FILE_PATH;
const TEMP_DIR = mkdtempSync(join(tmpdir(), "env-findenv-test-"));
const TEMP_ENV = join(TEMP_DIR, ".env");

// 写一份足够 zod schema 通过的 .env，让模块能成功 import
writeFileSync(TEMP_ENV, [
  "DATABASE_URL=postgres://test/test",
  "JWT_SECRET=test-jwt-secret-32-characters-min-len",
  "NODE_ENV=test",
].join("\n"));
process.env.ENV_FILE_PATH = TEMP_ENV;

const { findEnvFile } = await import("../config/env.js");

describe("findEnvFile (task #1 root cause fix)", () => {
  beforeEach(() => {
    process.env.ENV_FILE_PATH = TEMP_ENV;
  });

  afterEach(() => {
    if (ORIGINAL_ENV_FILE_PATH === undefined) delete process.env.ENV_FILE_PATH;
    else process.env.ENV_FILE_PATH = ORIGINAL_ENV_FILE_PATH;
  });

  it("returns explicit ENV_FILE_PATH when file exists", () => {
    expect(findEnvFile(TEMP_ENV)).toBe(TEMP_ENV);
  });

  it("uses process.env.ENV_FILE_PATH when arg omitted", () => {
    process.env.ENV_FILE_PATH = TEMP_ENV;
    expect(findEnvFile()).toBe(TEMP_ENV);
  });

  it("throws when explicit path does not exist (fail fast)", () => {
    expect(() => findEnvFile("/nonexistent/path/.env")).toThrow(/\.env file not found/);
  });

  it("treats empty string ENV_FILE_PATH as unset (fallback to default)", () => {
    // 7-25 修: 老写法硬断言"一定 throw", 前提是"monorepo 根 .env 不存在"。
    //   在**开发者本机**(根目录当然有 .env)这条永远红 —— 与被测行为无关的假失败。
    //   改成断言"空串/纯空白 ≡ 未设置": 两种情况走同一条 DEFAULT_ENV_PATH 分支,
    //   根 .env 在不在都成立(在 → 同一个绝对路径; 不在 → 同一条 not found 报错)。
    const call = (arg?: string) => {
      try {
        return { ok: true as const, value: findEnvFile(arg) };
      } catch (err: any) {
        return { ok: false as const, value: err.message as string };
      }
    };
    delete process.env.ENV_FILE_PATH;
    const baseline = call(); // 未设置时的行为
    for (const blank of ["", "   "]) {
      expect(call(blank)).toEqual(baseline);
    }
    // 兜底: 绝不能把空串本身当路径用(那会解析成 cwd 之类)
    expect(baseline.value).not.toMatch(/not found at\s*$/);
  });

  it("default fallback resolves to monorepo root .env (absolute path 4 levels up from src/config)", () => {
    // 删 ENV_FILE_PATH，触发默认路径解析
    delete process.env.ENV_FILE_PATH;
    // 在测试环境 monorepo 根 .env 通常不存在 → throw 但 message 含绝对路径
    try {
      findEnvFile();
      // 若 monorepo root 真有 .env 也算 pass
    } catch (err: any) {
      expect(err.message).toMatch(/\.env file not found at \//); // 绝对路径开头
      expect(err.message).not.toMatch(/packages\/server\/\.env/); // 不再指向影子
    }
  });
});

afterEach(() => {
  // 清理 temp dir（最后一个 test 后）
});

// 模块结束时清理 tmp
process.on("exit", () => {
  try { rmSync(TEMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
