/**
 * EventBus - 基于 Redis Streams 的事件总线
 *
 * 核心特性:
 * - 发布/订阅解耦 Agent 间通信
 * - 消费者组保证每条消息只被一个消费者处理
 * - XACK 消息确认，未确认消息自动重投
 * - 死信队列兜底，重试3次仍失败进入 DLQ
 * - 多租户隔离（tenantId 嵌入事件体）
 * - correlationId 贯穿链路追踪
 */

import IORedis from "ioredis";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type {
  EventType,
  BusEvent,
  EventHandler,
  SubscribeOptions,
  PublishOptions,
  DeadLetterMessage,
  IEventBus,
} from "./types.js";

/** Stream key 格式 */
const streamKey = (type: EventType) => `bm:events:${type}`;
/** 死信队列 key */
const dlqKey = (type: EventType) => `bm:dlq:${type}`;

/** 最大重投次数，超过则进入死信队列 */
const MAX_DELIVERY_COUNT = 3;
/** pending 消息超时时间（毫秒），超过后会被 XCLAIM 重投 */
const PENDING_TIMEOUT_MS = 2 * 60 * 1000; // 2分钟
/** pending 扫描间隔 */
const PENDING_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5分钟

interface Subscription {
  type: EventType;
  group: string;
  consumer: string;
  handler: EventHandler;
  pollTimer: ReturnType<typeof setInterval> | null;
  pendingScanTimer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

class EventBus implements IEventBus {
  private subscriptions: Subscription[] = [];
  private isShutdown = false;

  /**
   * EventBus 专用 Redis 连接（独立于 BullMQ）。
   *
   * 关键：BullMQ 的 QueueEvents/Worker 使用阻塞命令 (XREAD BLOCK)，
   * ioredis 在同一条连接上串行执行命令，阻塞命令会卡死所有后续 XADD/XACK。
   * 因此 EventBus 必须用独立连接。
   * 为发布（publish）和消费（subscribe）再拆两条连接更干净：
   *   - pubConn: 纯命令型，XADD / XACK / XPENDING / XCLAIM 等
   *   - subConn: 长轮询 XREADGROUP（BLOCK 0 时需独占）
   */
  private _pubConn: InstanceType<typeof IORedis.default> | null = null;
  private _subConn: InstanceType<typeof IORedis.default> | null = null;

  private getPubConn() {
    if (!this._pubConn) {
      this._pubConn = new IORedis.default(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: false,
      });
      this._pubConn.on("error", (err: Error) =>
        logger.error({ err: err.message }, "EventBus pub 连接错误")
      );
    }
    return this._pubConn;
  }

  private getSubConn() {
    if (!this._subConn) {
      this._subConn = new IORedis.default(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: false,
      });
      this._subConn.on("error", (err: Error) =>
        logger.error({ err: err.message }, "EventBus sub 连接错误")
      );
    }
    return this._subConn;
  }

  /** 兼容旧代码：默认的 redis 指向发布连接（非阻塞命令） */
  private get redis() {
    return this.getPubConn();
  }

  /**
   * 发布事件到 Redis Stream
   */
  async publish<T>(
    event: Omit<BusEvent<T>, "timestamp" | "messageId">,
    options: PublishOptions = {}
  ): Promise<string> {
    const maxLen = options.maxLen ?? 10000;
    const fullEvent: Omit<BusEvent<T>, "messageId"> = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    const key = streamKey(event.type);
    const data = JSON.stringify(fullEvent);

    // XADD with MAXLEN 近似裁剪
    const messageId = await this.redis.xadd(
      key,
      "MAXLEN",
      "~",
      String(maxLen),
      "*",
      "data",
      data
    );

    logger.info(
      {
        eventType: event.type,
        tenantId: event.tenantId,
        source: event.source,
        correlationId: event.correlationId,
        messageId,
      },
      "EventBus: 事件已发布"
    );

    return messageId!;
  }

  /**
   * 订阅事件类型
   */
  async subscribe<T>(
    type: EventType,
    handler: EventHandler<T>,
    options: SubscribeOptions = {}
  ): Promise<void> {
    const group = options.group ?? `group:${type}`;
    const consumer = options.consumer ?? `consumer:${process.pid}:${Date.now()}`;
    const batchSize = options.batchSize ?? 10;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;

    const key = streamKey(type);

    // 创建消费者组（如果不存在）
    try {
      await this.redis.xgroup("CREATE", key, group, "0", "MKSTREAM");
      logger.info({ type, group }, "EventBus: 消费者组已创建");
    } catch (err: unknown) {
      // BUSYGROUP 表示组已存在，忽略
      if (err instanceof Error && !err.message.includes("BUSYGROUP")) {
        throw err;
      }
    }

    const sub: Subscription = {
      type,
      group,
      consumer,
      handler: handler as EventHandler,
      pollTimer: null,
      pendingScanTimer: null,
      running: true,
    };

    // 轮询新消息
    sub.pollTimer = setInterval(async () => {
      if (!sub.running || this.isShutdown) return;
      try {
        await this.pollMessages(sub, key, batchSize);
      } catch (err) {
        logger.error({ err, type, group }, "EventBus: 轮询消息失败");
      }
    }, pollIntervalMs);

    // 定期扫描 pending 消息（重投超时未 ACK 的）
    sub.pendingScanTimer = setInterval(async () => {
      if (!sub.running || this.isShutdown) return;
      try {
        await this.reclaimPending(sub, key);
      } catch (err) {
        logger.error({ err, type, group }, "EventBus: pending扫描失败");
      }
    }, PENDING_SCAN_INTERVAL_MS);

    this.subscriptions.push(sub);

    logger.info(
      { type, group, consumer, pollIntervalMs },
      "EventBus: 订阅已注册"
    );
  }

  /**
   * 拉取并处理新消息
   */
  private async pollMessages(
    sub: Subscription,
    key: string,
    batchSize: number
  ): Promise<void> {
    // XREADGROUP: 读取未投递给该消费者的新消息
    // 用独立 subConn，避免和 publish / ack 的命令串在一起
    // 注意：不加 BLOCK 参数 → 非阻塞，没有新消息立即返回 nil
    // （Redis 语义里 BLOCK 0 是"永久阻塞"，会把共享的 subConn 卡死，
    //  导致其它订阅的 XREADGROUP 排队饿死）
    const results = await this.getSubConn().xreadgroup(
      "GROUP",
      sub.group,
      sub.consumer,
      "COUNT",
      String(batchSize),
      "STREAMS",
      key,
      ">" // 只读新消息
    );

    if (!results || !Array.isArray(results)) return;

    for (const streamEntry of results as [string, [string, string[]][]][]) {
      const messages = streamEntry[1];
      if (!Array.isArray(messages)) continue;
      for (const [messageId, fields] of messages) {
        await this.processMessage(sub, key, messageId, fields);
      }
    }
  }

  /**
   * 处理单条消息
   */
  private async processMessage(
    sub: Subscription,
    key: string,
    messageId: string,
    fields: string[]
  ): Promise<void> {
    let event: BusEvent;

    try {
      // fields 格式: ["data", "{...json...}"]
      const dataIndex = fields.indexOf("data");
      if (dataIndex === -1 || dataIndex + 1 >= fields.length) {
        logger.warn({ messageId, fields }, "EventBus: 消息格式异常，跳过");
        await this.redis.xack(key, sub.group, messageId);
        return;
      }

      event = JSON.parse(fields[dataIndex + 1]) as BusEvent;
      event.messageId = messageId;
    } catch (parseErr) {
      logger.error({ parseErr, messageId }, "EventBus: 消息解析失败，ACK并跳过");
      await this.redis.xack(key, sub.group, messageId);
      return;
    }

    try {
      await sub.handler(event);
      // 处理成功，确认消息
      await this.redis.xack(key, sub.group, messageId);

      logger.debug(
        {
          eventType: event.type,
          messageId,
          correlationId: event.correlationId,
        },
        "EventBus: 消息处理成功"
      );
    } catch (handlerErr) {
      // 处理失败，检查是否需要进入死信队列
      const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);

      logger.warn(
        {
          eventType: event.type,
          messageId,
          error: errMsg,
          correlationId: event.correlationId,
        },
        "EventBus: 消息处理失败"
      );

      // 检查投递次数（通过 XPENDING 单条查询）
      await this.checkAndMoveToDlq(sub, key, messageId, event, errMsg);
    }
  }

  /**
   * 检查消息投递次数，超过阈值移入死信队列
   */
  private async checkAndMoveToDlq(
    sub: Subscription,
    key: string,
    messageId: string,
    event: BusEvent,
    error: string
  ): Promise<void> {
    try {
      // XPENDING <key> <group> - + 1 <consumer> 获取单条 pending 信息
      const pendingInfo = await this.redis.xpending(
        key,
        sub.group,
        "-",
        "+",
        1,
        sub.consumer
      );

      let deliveryCount = 1;
      if (Array.isArray(pendingInfo) && pendingInfo.length > 0) {
        // pendingInfo[0] = [messageId, consumer, idleTime, deliveryCount]
        const entries = pendingInfo as unknown[];
        const entry = entries.find(
          (p) => Array.isArray(p) && (p as unknown[])[0] === messageId
        ) as unknown[] | undefined;
        if (entry) {
          deliveryCount = Number(entry[3]) || 1;
        }
      }

      if (deliveryCount >= MAX_DELIVERY_COUNT) {
        // 移入死信队列
        const dlqMessage: DeadLetterMessage = {
          event,
          error,
          retryCount: deliveryCount,
          deadAt: new Date().toISOString(),
        };

        await this.redis.xadd(
          dlqKey(event.type),
          "MAXLEN",
          "~",
          "1000",
          "*",
          "data",
          JSON.stringify(dlqMessage)
        );

        // ACK 原消息（从 pending 中移除）
        await this.redis.xack(key, sub.group, messageId);

        logger.warn(
          {
            eventType: event.type,
            messageId,
            deliveryCount,
            correlationId: event.correlationId,
          },
          "EventBus: 消息已移入死信队列"
        );
      }
      // 如果还没达到阈值，消息留在 pending 中等待下次 reclaimPending 重投
    } catch (err) {
      logger.error({ err, messageId }, "EventBus: 检查DLQ失败");
    }
  }

  /**
   * 扫描并重新认领超时的 pending 消息
   */
  private async reclaimPending(sub: Subscription, key: string): Promise<void> {
    // XPENDING: 获取该组所有 pending 消息摘要
    const pendingMessages = await this.redis.xpending(
      key,
      sub.group,
      "-",
      "+",
      100
    );

    if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) return;

    for (const entry of pendingMessages) {
      if (!Array.isArray(entry) || entry.length < 4) continue;

      const [msgId, , idleTime, deliveryCount] = entry;
      const idle = Number(idleTime);
      const deliveries = Number(deliveryCount);

      if (idle < PENDING_TIMEOUT_MS) continue;

      if (deliveries >= MAX_DELIVERY_COUNT) {
        // 超过重试次数，尝试获取消息内容并移入 DLQ
        try {
          const msgs = await this.redis.xrange(key, msgId, msgId);
          if (msgs && msgs.length > 0) {
            const [, fields] = msgs[0];
            const dataIndex = fields.indexOf("data");
            if (dataIndex !== -1) {
              const event = JSON.parse(fields[dataIndex + 1]) as BusEvent;
              const dlqMessage: DeadLetterMessage = {
                event,
                error: `超过最大重试次数(${MAX_DELIVERY_COUNT})，idle=${idle}ms`,
                retryCount: deliveries,
                deadAt: new Date().toISOString(),
              };
              await this.redis.xadd(
                dlqKey(event.type),
                "MAXLEN",
                "~",
                "1000",
                "*",
                "data",
                JSON.stringify(dlqMessage)
              );
            }
          }
          await this.redis.xack(key, sub.group, msgId);
          logger.warn(
            { messageId: msgId, deliveryCount: deliveries },
            "EventBus: pending消息超过重试上限，移入DLQ"
          );
        } catch (err) {
          logger.error({ err, msgId }, "EventBus: 处理过期pending消息失败");
        }
      } else {
        // 重新认领消息（XCLAIM），给当前消费者
        try {
          await this.redis.xclaim(
            key,
            sub.group,
            sub.consumer,
            String(PENDING_TIMEOUT_MS),
            msgId
          );
          logger.info(
            { messageId: msgId, idleMs: idle, deliveryCount: deliveries },
            "EventBus: 重新认领pending消息"
          );
        } catch (err) {
          logger.error({ err, msgId }, "EventBus: XCLAIM失败");
        }
      }
    }
  }

  /**
   * 手动确认消息
   */
  async ack(type: EventType, group: string, messageId: string): Promise<void> {
    await this.redis.xack(streamKey(type), group, messageId);
  }

  /**
   * 查询未确认消息列表
   */
  async getPending(type: EventType, group: string, count = 50): Promise<BusEvent[]> {
    const key = streamKey(type);
    const pendingList = await this.redis.xpending(key, group, "-", "+", count);

    if (!Array.isArray(pendingList) || pendingList.length === 0) return [];

    const events: BusEvent[] = [];
    for (const entry of pendingList) {
      if (!Array.isArray(entry)) continue;
      const [msgId] = entry;
      const msgs = await this.redis.xrange(key, msgId, msgId);
      if (msgs && msgs.length > 0) {
        const [, fields] = msgs[0];
        const dataIndex = fields.indexOf("data");
        if (dataIndex !== -1) {
          const event = JSON.parse(fields[dataIndex + 1]) as BusEvent;
          event.messageId = msgId;
          events.push(event);
        }
      }
    }

    return events;
  }

  /**
   * 查询历史事件
   */
  async getHistory(type: EventType, limit = 50): Promise<BusEvent[]> {
    const key = streamKey(type);
    // XREVRANGE: 从最新到最旧
    const results = await this.redis.xrevrange(key, "+", "-", "COUNT", String(limit));

    return results.map(([messageId, fields]) => {
      const dataIndex = fields.indexOf("data");
      const event = JSON.parse(fields[dataIndex + 1]) as BusEvent;
      event.messageId = messageId;
      return event;
    });
  }

  /**
   * 查询死信队列
   */
  async getDeadLetters(type: EventType, limit = 50): Promise<DeadLetterMessage[]> {
    const key = dlqKey(type);
    const results = await this.redis.xrevrange(key, "+", "-", "COUNT", String(limit));

    return results.map(([messageId, fields]) => {
      const dataIndex = fields.indexOf("data");
      const msg = JSON.parse(fields[dataIndex + 1]) as DeadLetterMessage;
      if (msg.event) msg.event.messageId = messageId;
      return msg;
    });
  }

  /**
   * 重试死信消息（从 DLQ 取出重新发布到原 Stream）
   */
  async retryDeadLetter(type: EventType, messageId: string): Promise<void> {
    const key = dlqKey(type);
    const msgs = await this.redis.xrange(key, messageId, messageId);

    if (!msgs || msgs.length === 0) {
      throw new Error(`死信消息不存在: ${messageId}`);
    }

    const [, fields] = msgs[0];
    const dataIndex = fields.indexOf("data");
    const dlqMsg = JSON.parse(fields[dataIndex + 1]) as DeadLetterMessage;

    // 重新发布到原 Stream
    await this.publish({
      type: dlqMsg.event.type,
      tenantId: dlqMsg.event.tenantId,
      payload: dlqMsg.event.payload,
      source: dlqMsg.event.source,
      correlationId: dlqMsg.event.correlationId,
    });

    // 从 DLQ 删除
    await this.redis.xdel(key, messageId);

    logger.info({ type, messageId }, "EventBus: 死信消息已重试");
  }

  /**
   * 丢弃死信消息
   */
  async removeDeadLetter(type: EventType, messageId: string): Promise<void> {
    await this.redis.xdel(dlqKey(type), messageId);
    logger.info({ type, messageId }, "EventBus: 死信消息已丢弃");
  }

  /**
   * 关闭所有订阅
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    for (const sub of this.subscriptions) {
      sub.running = false;
      if (sub.pollTimer) clearInterval(sub.pollTimer);
      if (sub.pendingScanTimer) clearInterval(sub.pendingScanTimer);
    }

    this.subscriptions = [];

    // 关闭独占连接
    try {
      if (this._subConn) {
        this._subConn.disconnect();
        this._subConn = null;
      }
      if (this._pubConn) {
        this._pubConn.disconnect();
        this._pubConn = null;
      }
    } catch (err) {
      logger.warn({ err }, "EventBus: 关闭 Redis 连接时出错");
    }

    logger.info("EventBus: 已关闭所有订阅");
  }
}

/** 全局单例 */
export const eventBus = new EventBus();

export type { EventType, BusEvent, EventHandler, SubscribeOptions, IEventBus } from "./types.js";
