/**
 * Orchestrator 进度存储（内存 Map）
 *
 * 前端通过轮询 GET /agents/orchestrator/progress 获取实时进度
 * 每个 tenant 同时只保留一次执行的进度
 */

export interface ProgressStep {
  step: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
}

export interface RunState {
  runId: string;
  tenantId: string;
  progress: number;        // 0-100
  steps: ProgressStep[];
  done: boolean;
  success?: boolean;
  summary?: string;
  startedAt: number;       // Date.now()
}

// tenantId → RunState
const store = new Map<string, RunState>();

/**
 * 创建一次新执行
 */
export function createRun(tenantId: string, runId: string): void {
  store.set(tenantId, {
    runId,
    tenantId,
    progress: 0,
    steps: [
      { step: "data-crawl", label: "数据抓取", status: "pending" },
      { step: "keyword-analysis", label: "关键词分析", status: "pending" },
      { step: "knowledge-engine", label: "知识引擎", status: "pending" },
      { step: "content-director", label: "内容规划", status: "pending" },
      { step: "read-plan", label: "读取计划", status: "pending" },
      { step: "queue-tasks", label: "任务排队", status: "pending" },
    ],
    done: false,
    startedAt: Date.now(),
  });
}

/**
 * 更新某步骤进度
 */
export function emitProgress(event: {
  runId: string;
  step: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  error?: string;
}): void {
  // 用 runId 找到对应 tenant 的 state
  for (const state of store.values()) {
    if (state.runId === event.runId) {
      state.progress = event.progress;
      state.steps = state.steps.map((s) =>
        s.step === event.step
          ? { ...s, status: event.status, error: event.error }
          : s
      );
      break;
    }
  }
}

/**
 * 标记执行完成
 */
export function emitDone(result: {
  runId: string;
  success: boolean;
  summary: string;
}): void {
  for (const state of store.values()) {
    if (state.runId === result.runId) {
      state.done = true;
      state.success = result.success;
      state.summary = result.summary;
      state.progress = 100;

      // 60秒后自动清理
      setTimeout(() => {
        if (store.get(state.tenantId)?.runId === result.runId) {
          store.delete(state.tenantId);
        }
      }, 60_000);
      break;
    }
  }
}

/**
 * 前端轮询用：读取当前进度
 */
export function getRunState(tenantId: string): RunState | null {
  return store.get(tenantId) || null;
}
