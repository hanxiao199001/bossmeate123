/**
 * PR Q.7：Dashboard widget 隐藏 + V3 batch flag + ChatPage modal 自动弹（防回归 grep）。
 */
import { describe, it, expect } from "vitest";

async function readSrc(rel: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(rel, import.meta.url), "utf8");
}

describe("PR Q.7 B 方案：V3 batch agent 总闸 + Dashboard widget 隐藏", () => {
  it("env.ts 含 V3_BATCH_AGENT_ENABLED 默认 false", async () => {
    const src = await readSrc("../config/env.ts");
    expect(src).toMatch(/V3_BATCH_AGENT_ENABLED:\s*z/);
    expect(src).toMatch(/\.default\("false"\)/);
  });

  it("scheduler.ts orchestrator + knowledge-engine 都早 return when flag false", async () => {
    const src = await readSrc("../services/scheduler.ts");
    expect(src).toMatch(/V3_BATCH_AGENT_ENABLED=false/);
    expect(src).toMatch(/orchestrator scheduled job skipped/);
    expect(src).toMatch(/knowledge-engine scheduled job skipped/);
  });

  it("DashboardPage.tsx 不再渲染 <FactoryHero />（widget 真消失）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/DashboardPage.tsx");
    // FactoryHero 函数定义保留，但 jsx 调用必须被注释掉
    expect(src).toMatch(/\{\s*\/\*\s*<FactoryHero \/>\s*\*\/\s*\}/);
    // 主 layout 不应再含未注释的 <FactoryHero />
    expect(src).not.toMatch(/^\s*<FactoryHero \/>$/m);
  });
});

describe("PR Q.7 (Q.3.1)：ChatPage 模板选择 modal 自动弹", () => {
  it("handleSend 在 article skill 时缓存 pending args + 弹 modal（不立即 send）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ChatPage.tsx");
    expect(src).toMatch(/setPendingSendArgs\(\{ content: userContent, convId \}\)/);
    expect(src).toMatch(/setShowTemplatePicker\(true\)/);
  });

  it("pickTemplateAndSend 接收 templateId 后立即调 sendMessageWithTemplate", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ChatPage.tsx");
    expect(src).toMatch(/async function pickTemplateAndSend\(templateId: string\)/);
    expect(src).toMatch(/sendMessageWithTemplate\(args\.content, args\.convId, templateId\)/);
  });

  it("modal 按钮点击触发 pickTemplateAndSend（pendingSendArgs 有时直接发）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ChatPage.tsx");
    expect(src).toMatch(/if \(pendingSendArgs\) pickTemplateAndSend\(t\.id\)/);
  });

  it("取消按钮恢复 input + 清 pendingSendArgs（容错）", async () => {
    const src = await readSrc("../../../../apps/web/src/pages/ChatPage.tsx");
    expect(src).toMatch(/setInput\(pendingSendArgs\.content\)/);
    expect(src).toMatch(/setPendingSendArgs\(null\)/);
  });
});
