/**
 * P4 batch 路由（5-12 backend Day 1）。
 *
 *   POST /api/v1/batch/upload         multipart csv → createBatch
 *   GET  /api/v1/batch/:id            状态 + rows
 *   GET  /api/v1/batch/:id/report     csv 下载（utf-8 BOM）
 *   POST /api/v1/batch/:id/retry/:rowId  手动 retry 失败 row
 */
import type { FastifyInstance } from "fastify";
import { logger } from "../config/logger.js";
import { parseCsv, buildReportCsv } from "../services/batch/csv-parser.js";
import { createBatch, getBatchStatus, retryRow } from "../services/batch/batch-service.js";

const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROWS = 500; // 单次 batch 上限

export async function batchRoutes(app: FastifyInstance) {
  /** P4：上传 csv 创建 batch */
  app.post("/batch/upload", async (request, reply) => {
    let file: Buffer;
    let filename = "upload.csv";
    try {
      const data = await request.file();
      if (!data) return reply.code(400).send({ code: "BAD_REQUEST", message: "缺 csv 文件" });
      filename = data.filename ?? "upload.csv";
      file = await data.toBuffer();
      if (file.length > MAX_CSV_BYTES) {
        return reply.code(413).send({ code: "FILE_TOO_LARGE", message: `csv ≤ 5MB（实际 ${file.length} 字节）` });
      }
    } catch (err) {
      logger.error({ err }, "P4 batch upload multipart 解析失败");
      return reply.code(400).send({ code: "BAD_REQUEST", message: "csv 上传失败" });
    }

    const csvText = file.toString("utf8");
    const parsed = parseCsv(csvText);

    if (parsed.errors.length > 0 && parsed.rows.length === 0) {
      return reply.code(400).send({
        code: "CSV_INVALID",
        message: "csv 全部行解析失败",
        data: { errors: parsed.errors.slice(0, 20) },
      });
    }
    if (parsed.rows.length > MAX_ROWS) {
      return reply.code(400).send({ code: "TOO_MANY_ROWS", message: `csv 行数 ${parsed.rows.length} 超过上限 ${MAX_ROWS}` });
    }
    if (parsed.rows.length === 0) {
      return reply.code(400).send({ code: "CSV_EMPTY", message: "csv 0 行有效数据" });
    }

    try {
      const result = await createBatch({
        tenantId: request.tenantId,
        userId: request.user.userId,
        filename,
        rows: parsed.rows,
      });
      return reply.send({
        code: "OK",
        data: { batchId: result.batchId, rowCount: result.rowCount, parseErrors: parsed.errors.slice(0, 20) },
      });
    } catch (err) {
      logger.error({ err }, "P4 batch createBatch 失败");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "batch 创建失败" });
    }
  });

  /** P4：获取 batch 状态 + rows */
  app.get("/batch/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await getBatchStatus(id, request.tenantId);
    if (!result) return reply.code(404).send({ code: "NOT_FOUND", message: "batch 不存在或无权限" });
    return { code: "OK", data: result };
  });

  /** P4：下载 csv 报告 */
  app.get("/batch/:id/report", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await getBatchStatus(id, request.tenantId);
    if (!result) return reply.code(404).send({ code: "NOT_FOUND", message: "batch 不存在或无权限" });
    const csv = buildReportCsv(
      result.rows.map((r) => ({
        rowIndex: r.rowIndex,
        topic: r.topic,
        status: r.status,
        articleId: r.articleId,
        errorMessage: r.errorMessage,
      })),
    );
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="batch-${id}-report.csv"`);
    return reply.send(csv);
  });

  /** P4：手动 retry 失败 row */
  app.post("/batch/:id/retry/:rowId", async (request, reply) => {
    const { rowId } = request.params as { id: string; rowId: string };
    const result = await retryRow(rowId, request.tenantId);
    if ("error" in result) {
      return reply.code(400).send({ code: "RETRY_FAILED", message: result.error });
    }
    return { code: "OK", data: { ok: true } };
  });
}
