/**
 * 5-23 PR #237 — 修 DVH "Credential is not a constructor" 错误.
 * 根因: @alicloud/credentials 和 @alicloud/avatar20220130 是 CJS 包,
 *   default export 在 .default 上, TS ESM `import X from ...` 拿到 module 对象不是构造函数.
 * 修: 加 unwrapCtor(mod) helper, runtime 兜底取 .default 或 mod 自身.
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}
const CLIENT = "../services/digital-human/client.ts";

describe("PR #237: DVH CJS interop fix", () => {
  it("unwrapCtor helper 定义", async () => {
    const src = await readSrc(CLIENT);
    expect(src).toMatch(/function unwrapCtor<T>\(mod: T\)/);
    expect(src).toMatch(/\(typeof m === "function"\) \? m : \(m\?\.default \?\? m\)/);
  });
  it("createDvhClient 用 unwrapCtor 包 Credential + avatar20220130", async () => {
    const src = await readSrc(CLIENT);
    expect(src).toMatch(/const CredentialCtor = unwrapCtor\(Credential\)/);
    expect(src).toMatch(/const AvatarClientCtor = unwrapCtor\(avatar20220130\)/);
    expect(src).toMatch(/new CredentialCtor\(/);
    expect(src).toMatch(/new AvatarClientCtor\(config\)/);
  });
  it("PR #237 注释解释 CJS default 在 .default 上", async () => {
    const src = await readSrc(CLIENT);
    expect(src).toMatch(/PR #237/);
    expect(src).toMatch(/CJS 包 default 在 \.default 上/);
  });
});
