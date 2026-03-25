/**
 * BossMate 共享类型定义
 * 前后端共用
 */

// ============ 通用响应 ============
export interface ApiResponse<T = unknown> {
  code: string;
  data?: T;
  message?: string;
}

// ============ 用户 ============
export interface User {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  avatar?: string;
}

// ============ 租户 ============
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "trial" | "basic" | "pro";
  status: "active" | "suspended";
}

// ============ 对话 ============
export interface Conversation {
  id: string;
  title: string;
  skillType?: SkillType;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

// ============ 消息 ============
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string;
  tokensUsed?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ============ 内容资产 ============
export interface Content {
  id: string;
  type: ContentType;
  title?: string;
  body?: string;
  status: ContentStatus;
  platforms: PublishRecord[];
  tokensTotal: number;
  createdAt: string;
  updatedAt: string;
}

export type ContentType = "article" | "video_script" | "reply";
export type ContentStatus = "draft" | "reviewing" | "approved" | "published";

export interface PublishRecord {
  platform: string;
  publishedAt?: string;
  url?: string;
  status: "pending" | "published" | "failed";
}

// ============ 技能/业务线 ============
export type SkillType = "article" | "video" | "customer_service";

// ============ 模型路由 ============
export type ModelTier = "expensive" | "cheap";
export type TaskType =
  | "content_generation"
  | "requirement_analysis"
  | "quality_check"
  | "knowledge_search"
  | "daily_chat"
  | "formatting"
  | "customer_service"
  | "translation";
