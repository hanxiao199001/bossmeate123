/**
 * 获客组件注入器
 *
 * 在发布内容前自动追加获客引导文案，根据平台类型选择不同格式：
 * - 图文平台（百家号/头条号/知乎/小红书）：文末追加引导段落 + 微信号
 * - 视频平台（抖音/视频号）：视频描述中插入引导文案
 * - 微信公众号：已有完整服务卡片（wechat-article-template.ts），不重复注入
 *
 * 获客文案从 tenant.config.leadCapture 读取，支持自定义：
 *   { wechatId: "Wlfj2020", slogan: "期刊发表咨询", qrCodeUrl: "..." }
 * 未配置时用默认值。
 */

import { logger } from "../../config/logger.js";

export interface LeadCaptureConfig {
  wechatId: string;
  slogan: string;
  phone?: string;
  qrCodeUrl?: string;
}

const DEFAULT_CONFIG: LeadCaptureConfig = {
  wechatId: "Wlfj2020",
  slogan: "SCI/SSCI/核心期刊发表咨询",
};

/** 从 tenant config 或 content metadata 获取获客配置 */
export function getLeadCaptureConfig(metadata?: Record<string, any>): LeadCaptureConfig {
  const custom = metadata?.leadCapture as Partial<LeadCaptureConfig> | undefined;
  return {
    wechatId: custom?.wechatId || DEFAULT_CONFIG.wechatId,
    slogan: custom?.slogan || DEFAULT_CONFIG.slogan,
    phone: custom?.phone,
    qrCodeUrl: custom?.qrCodeUrl,
  };
}

/**
 * 图文类获客尾部（百家号/头条号/知乎/小红书）
 * 追加到文章正文末尾
 */
export function articleLeadCaptureText(config: LeadCaptureConfig): string {
  return [
    "",
    "---",
    "",
    `📌 ${config.slogan}`,
    `👉 微信咨询：${config.wechatId}`,
    `🔍 精准选刊 · 正刊投稿 · 全程指导`,
    config.phone ? `📞 电话：${config.phone}` : "",
    "",
    "▶ 顺仕美途科研服务平台 · BossMate AI",
  ].filter(Boolean).join("\n");
}

/**
 * 图文类获客尾部（HTML 版，用于百家号等支持 HTML 的平台）
 */
export function articleLeadCaptureHtml(config: LeadCaptureConfig): string {
  return `
<div style="margin-top:24px;padding:16px;background:#f8f9fa;border-radius:8px;border-left:4px solid #1565C0;">
  <p style="margin:0 0 8px;font-size:15px;font-weight:bold;color:#333;">📌 ${esc(config.slogan)}</p>
  <p style="margin:0 0 4px;font-size:14px;color:#555;">👉 微信咨询：<strong style="color:#1565C0;font-size:16px;">${esc(config.wechatId)}</strong></p>
  <p style="margin:0 0 4px;font-size:13px;color:#888;">精准选刊 · 正刊投稿 · 全程指导</p>
  ${config.phone ? `<p style="margin:0;font-size:13px;color:#888;">📞 ${esc(config.phone)}</p>` : ""}
  <p style="margin:8px 0 0;font-size:11px;color:#bbb;">顺仕美途科研服务平台 · BossMate AI</p>
</div>`;
}

/**
 * 视频类获客文案（抖音/视频号简介）
 */
export function videoLeadCaptureText(config: LeadCaptureConfig): string {
  return [
    `#${config.slogan.replace(/\//g, " #")}`,
    `📌 ${config.slogan}，微信咨询：${config.wechatId}`,
    `精准选刊 | 正刊投稿 | 全程指导`,
    `👉 更多详情见主页链接`,
  ].join("\n");
}

/**
 * 小红书获客文案（笔记末尾）
 */
export function xiaohongshuLeadCaptureText(config: LeadCaptureConfig): string {
  return [
    "",
    "· · ·",
    `💡 ${config.slogan}`,
    `📩 私信或微信：${config.wechatId}`,
    `✅ 精准选刊 · 正刊投稿 · 全程指导`,
    "",
    "#期刊发表 #SCI投稿 #论文写作 #科研服务",
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
