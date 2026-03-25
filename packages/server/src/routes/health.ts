import type { FastifyInstance } from "fastify";
import { testConnection } from "../models/db.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    return {
      status: "ok",
      service: "BossMate API",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/db", async () => {
    const ok = await testConnection();
    return {
      status: ok ? "ok" : "error",
      database: ok ? "connected" : "disconnected",
    };
  });
}
