/**
 * Agent 注册表 — 单例，管理所有 Agent 实例
 */

import { logger } from "../../../config/logger.js";
import type { IAgent, AgentConfig } from "./types.js";

const DEFAULT_CONCURRENCY: Record<string, number> = {
  "article-writer": 5,
  "video-creator": 3,
  "customer-service": 2,
  "knowledge-engine": 1,
  "content-director": 1,
  "orchestrator": 1,
};

class AgentRegistryClass {
  private agents = new Map<string, IAgent>();

  register(agent: IAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent "${agent.name}" already registered`);
    }
    this.agents.set(agent.name, agent);
    logger.info({ agent: agent.name }, `Agent registered: ${agent.displayName}`);
  }

  get(name: string): IAgent | undefined {
    return this.agents.get(name);
  }

  getAll(): IAgent[] {
    return Array.from(this.agents.values());
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }

  async initializeAll(tenantId?: string): Promise<void> {
    for (const [name, agent] of this.agents) {
      const concurrency = DEFAULT_CONCURRENCY[name] || 1;
      const config: AgentConfig = {
        tenantId,
        concurrency,
        maxRetries: 3,
        timeoutMs: 300_000,
      };
      try {
        await agent.initialize(config);
        logger.info({ agent: name }, "Agent initialized");
      } catch (err) {
        logger.error({ agent: name, err }, "Agent initialization failed");
      }
    }
  }

  async shutdownAll(): Promise<void> {
    for (const [name, agent] of this.agents) {
      try {
        await agent.shutdown();
        logger.info({ agent: name }, "Agent shutdown");
      } catch (err) {
        logger.error({ agent: name, err }, "Agent shutdown failed");
      }
    }
  }

  list(): Array<{ name: string; displayName: string; status: string }> {
    return Array.from(this.agents.values()).map((a) => ({
      name: a.name,
      displayName: a.displayName,
      status: a.getStatus(),
    }));
  }
}

export const agentRegistry = new AgentRegistryClass();
