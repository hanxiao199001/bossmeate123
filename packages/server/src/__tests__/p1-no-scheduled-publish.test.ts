/**
 * PR P1（5-9 砍定时发布）：防回归。
 *
 * 锁定：
 *  - publish-worker.ts 文件不存在
 *  - schema.ts 不再 export scheduledPublishes
 *  - migrate.ts 含 DROP TABLE IF EXISTS scheduled_publishes
 *  - content-worker.ts 不再 INSERT scheduledPublishes
 *  - agent-status.ts 不再 SELECT scheduledPublishes
 *  - index.ts 不再 startPublishWorker
 *
 * 用户改为审核通过后手动一键发布（走 publisher.publishToAccounts）。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("PR P1: publish-worker.ts 文件已删", () => {
  it("packages/server/src/services/task/publish-worker.ts 不存在", () => {
    expect(existsSync(join(__dirname, "../services/task/publish-worker.ts"))).toBe(false);
  });
});

describe("PR P1: schema.ts 不再 export scheduledPublishes", () => {
  const src = readSrc("models/schema.ts");

  it("不再 export const scheduledPublishes = pgTable(...)", () => {
    expect(src).not.toMatch(/export\s+const\s+scheduledPublishes\s*=\s*pgTable/);
  });

  it("含 PR P1 删除注释（防未来 refactor 误恢复）", () => {
    expect(src).toMatch(/PR P1.*砍定时发布/);
  });
});

describe("PR P1: migrate.ts 含 DROP TABLE", () => {
  const src = readSrc("models/migrate.ts");

  it("含 DROP TABLE IF EXISTS scheduled_publishes（幂等清理 prod）", () => {
    expect(src).toMatch(/DROP TABLE IF EXISTS scheduled_publishes/);
  });

  it("含 DROP INDEX IF EXISTS idx_sp_pending（清理孤儿 INDEX）", () => {
    expect(src).toMatch(/DROP INDEX IF EXISTS idx_sp_pending/);
  });

  it("不再含 CREATE TABLE scheduled_publishes 行", () => {
    expect(src).not.toMatch(/CREATE TABLE IF NOT EXISTS scheduled_publishes/);
  });
});

describe("PR P1: content-worker.ts 不再 INSERT scheduledPublishes", () => {
  const src = readSrc("services/task/content-worker.ts");

  it("import 不含 scheduledPublishes（schema 已删）", () => {
    expect(src).not.toMatch(/scheduledPublishes\s*[,}]/);
  });

  it("schedulePublish helper 函数已删除", () => {
    expect(src).not.toMatch(/^async function schedulePublish/m);
    expect(src).not.toMatch(/await schedulePublish\(/);
  });
});

describe("PR P1: agent-status.ts 不再查 scheduledPublishes", () => {
  const src = readSrc("routes/agent-status.ts");

  it("import 不含 scheduledPublishes", () => {
    expect(src).not.toMatch(/^\s*scheduledPublishes,?\s*$/m);
  });

  it("approve handler 不再 SELECT pendingPublishes", () => {
    expect(src).not.toMatch(/pendingPublishes\s*=\s*await db/);
    expect(src).not.toMatch(/\.from\(scheduledPublishes\)/);
  });
});

describe("PR P1: index.ts 不再启动 publish-worker", () => {
  const src = readSrc("index.ts");

  it("不再 import startPublishWorker / stopPublishWorker", () => {
    expect(src).not.toMatch(/import\s*\{[^}]*startPublishWorker[^}]*\}\s*from\s*["']\.\/services\/task\/publish-worker/);
  });

  it("boot 流程不再调用 startPublishWorker()", () => {
    expect(src).not.toMatch(/^\s*startPublishWorker\(\);/m);
  });

  it("含 PR P1 删除标记（防 refactor 误恢复）", () => {
    expect(src).toMatch(/PR P1.*砍定时|publish-worker.*已删/);
  });
});
