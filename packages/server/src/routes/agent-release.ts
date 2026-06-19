/**
 * 6-19 Agent 自更新: 便携包启动器每次启动只拉这点 agent 代码(dist), Chromium/Node/登录态全保留,
 *   客户不必再重下几百MB的整包。免鉴权(启动器更新时可能还没 token; dist 本就是发给所有客户的JS)。
 *   - GET /api/v1/agent/release/version  → 纯文本版本(dist 内容 sha1 前12位), 变了才触发更新
 *   - GET /api/v1/agent/release/dist.tgz → gzip tar 的 agent dist 目录(流式)
 */
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { logger } from "../config/logger.js";

/** 定位 packages/agent 目录(pm2 cwd=packages/server → ../agent; 兜底几个候选)。 */
function agentRoot(): string {
  const candidates = [
    resolve(process.cwd(), "../agent"),
    resolve(process.cwd(), "../../packages/agent"),
    resolve(process.cwd(), "packages/agent"),
  ];
  for (const c of candidates) if (existsSync(join(c, "dist"))) return c;
  return candidates[0];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let cached: { v: string; at: number } | null = null;
function distVersion(root: string): string {
  const now = Date.now();
  if (cached && now - cached.at < 60_000) return cached.v;
  const distDir = join(root, "dist");
  const files = walk(distDir).filter((f) => f.endsWith(".js")).sort();
  const h = createHash("sha1");
  for (const f of files) h.update(readFileSync(f));
  const v = h.digest("hex").slice(0, 12);
  cached = { v, at: now };
  return v;
}

export async function agentReleaseRoutes(app: FastifyInstance) {
  app.get("/agent/release/version", async (_req, reply) => {
    try {
      const v = distVersion(agentRoot());
      reply.header("Cache-Control", "no-store").type("text/plain; charset=utf-8");
      return v;
    } catch (err) {
      logger.warn({ err }, "agent release version 失败");
      return reply.code(500).send("error");
    }
  });

  app.get("/agent/release/dist.tgz", async (_req, reply) => {
    const root = agentRoot();
    if (!existsSync(join(root, "dist"))) return reply.code(404).send("no dist");
    reply.header("Content-Type", "application/gzip").header("Cache-Control", "no-store");
    // tar -czf - -C <agentRoot> dist  → 解出来是 dist/ 目录, 流式发送
    const child = spawn("tar", ["-czf", "-", "-C", root, "dist"]);
    child.on("error", (e) => {
      logger.warn({ e }, "tar dist 失败");
      try { reply.raw.destroy(); } catch { /* noop */ }
    });
    return reply.send(child.stdout);
  });
}
