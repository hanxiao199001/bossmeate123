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

  // 7-08 死测试清理 (确死: 读已删文件): 删 "DashboardPage.tsx 不再渲染 <FactoryHero />" it —
  //   目标 apps/web/src/pages/DashboardPage.tsx 已删 (首页合并进「今日驾驶舱」)。V3 batch flag 的活断言 (env.ts + scheduler.ts) 上方保留。
});

// 7-08 死测试清理 (确死: 读已删文件): 删整个 "ChatPage 模板选择 modal 自动弹" describe (4 个 it) —
//   全部 readSrc apps/web/src/pages/ChatPage.tsx, 该页已删 (/chat 整页下线, 见 pr123/pr116 同期清理)。
//   模板选择逻辑现由后端 preferences + article-skill 承载 (pr123-p6-preferences.test.ts 验证), 前端 modal 随页面下线无取代 UI 可断言。
