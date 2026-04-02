import type { FastifyInstance } from "fastify";
import type { JobProgress } from "bullmq";
import { contentQueueEvents } from "./queue.js";

export function registerTaskWebSocket(fastify: FastifyInstance): void {
  fastify.get("/ws/tasks/:taskId", { websocket: true }, (socket, request) => {
    const { taskId } = request.params as { taskId: string };

    const onProgress = ({ jobId, data }: { jobId: string; data: JobProgress }) => {
      if (jobId === `gen-${taskId}`) {
        socket.send(JSON.stringify({
          type: "progress", taskId,
          progress: typeof data === "number" ? data : 0,
        }));
      }
    };

    const onCompleted = ({ jobId, returnvalue }: { jobId: string; returnvalue: string }) => {
      if (jobId === `gen-${taskId}`) {
        socket.send(JSON.stringify({
          type: "completed", taskId,
          result: JSON.parse(returnvalue || "{}"),
        }));
        socket.close();
      }
    };

    const onFailed = ({ jobId, failedReason }: { jobId: string; failedReason: string }) => {
      if (jobId === `gen-${taskId}`) {
        socket.send(JSON.stringify({
          type: "failed", taskId, error: failedReason,
        }));
        socket.close();
      }
    };

    contentQueueEvents.on("progress", onProgress);
    contentQueueEvents.on("completed", onCompleted);
    contentQueueEvents.on("failed", onFailed);

    socket.on("close", () => {
      contentQueueEvents.off("progress", onProgress);
      contentQueueEvents.off("completed", onCompleted);
      contentQueueEvents.off("failed", onFailed);
    });
  });
}
