/**
 * EventBus 事件总线类型定义
 *
 * 基于 Redis Streams 的异步事件系统，实现 Agent 间解耦通信
 */

/** 所有支持的事件类型 */
export type EventType =
  // 日常计划
  | "daily.plan.start"
  // 关键词
  | "keyword.analyzed"
  // 内容生产
  | "content.created"
  | "content.approved"
  | "content.review_needed"
  | "content.rejected"
  | "content.published"
  // 销售线索
  | "lead.collected"
  | "lead.stage_changed"
  | "lead.need_human"
  // Agent 状态
  | "agent.error"
  | "agent.timeout";

/** 事件消息体 */
export interface BusEvent<T = unknown> {
  /** 事件类型 */
  type: EventType;
  /** 租户ID，用于多租户隔离 */
  tenantId: string;
  /** 事件载荷 */
  payload: T;
  /** 发布来源（Agent名称） */
  source: string;
  /** 链路追踪ID，贯穿整个任务链 */
  correlationId: string;
  /** 事件创建时间 (ISO) */
  timestamp: string;
  /** Redis Stream 消息ID（消费时自动填充） */
  messageId?: string;
}

/** 事件处理器 */
export type EventHandler<T = unknown> = (event: BusEvent<T>) => Promise<void>;

/** 订阅选项 */
export interface SubscribeOptions {
  /** 消费者组名（默认为 handler 函数名或 Agent 名） */
  group?: string;
  /** 消费者名（同组内唯一，默认为随机ID） */
  consumer?: string;
  /** 批量拉取数量（默认 10） */
  batchSize?: number;
  /** 拉取间隔（毫秒，默认 1000） */
  pollIntervalMs?: number;
}

/** 发布选项 */
export interface PublishOptions {
  /** 最大 Stream 长度（默认 10000，超出自动裁剪） */
  maxLen?: number;
}

/** 死信队列中的消息 */
export interface DeadLetterMessage<T = unknown> {
  /** 原始事件 */
  event: BusEvent<T>;
  /** 失败原因 */
  error: string;
  /** 已重试次数 */
  retryCount: number;
  /** 进入死信队列的时间 */
  deadAt: string;
}

/** EventBus 接口 */
export interface IEventBus {
  /** 发布事件 */
  publish<T>(event: Omit<BusEvent<T>, "timestamp" | "messageId">, options?: PublishOptions): Promise<string>;

  /** 订阅事件 */
  subscribe<T>(type: EventType, handler: EventHandler<T>, options?: SubscribeOptions): Promise<void>;

  /** 确认消息已处理 */
  ack(type: EventType, group: string, messageId: string): Promise<void>;

  /** 查询未确认消息 */
  getPending(type: EventType, group: string, count?: number): Promise<BusEvent[]>;

  /** 查询历史事件 */
  getHistory(type: EventType, limit?: number): Promise<BusEvent[]>;

  /** 查询死信队列 */
  getDeadLetters(type: EventType, limit?: number): Promise<DeadLetterMessage[]>;

  /** 重试死信消息 */
  retryDeadLetter(type: EventType, messageId: string): Promise<void>;

  /** 丢弃死信消息 */
  removeDeadLetter(type: EventType, messageId: string): Promise<void>;

  /** 关闭所有订阅和连接 */
  shutdown(): Promise<void>;
}
