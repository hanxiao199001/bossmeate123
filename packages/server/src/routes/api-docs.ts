import type { FastifyInstance } from "fastify";

export async function apiDocsRoutes(app: FastifyInstance) {
  /**
   * GET /api/docs - 返回 OpenAPI 3.0 规范 JSON
   */
  app.get("/", async (_request, reply) => {
    const openapi = {
      openapi: "3.0.0",
      info: {
        title: "BossMate API",
        description: "BossMate - AI超级员工内容生产平台 API 文档",
        version: "1.0.0",
        contact: {
          name: "BossMate Team",
        },
      },
      servers: [
        {
          url: "https://api.bossmate.ai/v1",
          description: "生产环境",
        },
        {
          url: "http://localhost:3000/v1",
          description: "本地开发环境",
        },
      ],
      tags: [
        { name: "认证", description: "用户注册和登录" },
        { name: "内容", description: "内容 CRUD 操作" },
        { name: "对话", description: "AI 对话和消息处理" },
        { name: "关键词", description: "关键词监控、爬虫、趋势分析" },
        { name: "期刊", description: "期刊检索和匹配" },
        { name: "选题", description: "选题工坊 - 选刊到文章生成" },
        { name: "工作流", description: "内容生产工作流" },
        { name: "账号", description: "多平台账号管理和发布" },
        { name: "知识库", description: "知识库管理和搜索" },
        { name: "Agent", description: "AI Agent 系统管理" },
        { name: "数据采集", description: "热点事件、竞品分析、数据采集" },
        { name: "内容引擎", description: "多格式内容生成" },
        { name: "推荐", description: "每日选题推荐" },
        { name: "任务", description: "异步任务管理" },
        { name: "看板", description: "数据概览和统计" },
        { name: "微信", description: "微信公众号集成" },
        { name: "租户", description: "租户信息查询" },
        { name: "健康检查", description: "服务健康检查" },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "JWT token from login response",
          },
        },
        schemas: {
          // 通用响应格式
          SuccessResponse: {
            type: "object",
            properties: {
              code: { type: "string", example: "OK" },
              data: { type: "object" },
              message: { type: "string" },
            },
          },
          ErrorResponse: {
            type: "object",
            properties: {
              code: { type: "string", example: "INTERNAL_ERROR" },
              message: { type: "string" },
            },
          },
          // 用户相关
          User: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              email: { type: "string", format: "email" },
              role: { type: "string", enum: ["owner", "admin", "member"] },
            },
          },
          Tenant: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              slug: { type: "string" },
            },
          },
          // 内容相关
          Content: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              tenantId: { type: "string", format: "uuid" },
              userId: { type: "string", format: "uuid" },
              type: { type: "string", enum: ["article", "video_script", "reply"] },
              title: { type: "string" },
              body: { type: "string" },
              status: { type: "string", enum: ["draft", "reviewing", "approved", "published"] },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
          // 对话相关
          Conversation: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              tenantId: { type: "string", format: "uuid" },
              userId: { type: "string", format: "uuid" },
              title: { type: "string" },
              skillType: { type: "string", enum: ["article", "video", "customer_service", "general"] },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
          Message: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              conversationId: { type: "string", format: "uuid" },
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
              model: { type: "string" },
              tokensUsed: { type: "integer" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          // 关键词相关
          Keyword: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              keyword: { type: "string" },
              category: { type: "string" },
              status: { type: "string" },
              platform: { type: "string" },
            },
          },
          // 期刊相关
          Journal: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
              nameEn: { type: "string" },
              discipline: { type: "string" },
              partition: { type: "string", enum: ["Q1", "Q2", "Q3", "Q4"] },
              impactFactor: { type: "number" },
              isWarningList: { type: "boolean" },
              letpubViews: { type: "integer" },
            },
          },
          // 账号相关
          PlatformAccount: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              platform: { type: "string", enum: ["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu"] },
              accountName: { type: "string" },
              isVerified: { type: "boolean" },
              status: { type: "string", enum: ["active", "disabled", "expired"] },
            },
          },
        },
      },
      paths: {
        // ==================== 健康检查 ====================
        "/health": {
          get: {
            tags: ["健康检查"],
            summary: "服务健康检查",
            responses: {
              200: {
                description: "服务运行正常",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        status: { type: "string", example: "ok" },
                        service: { type: "string", example: "BossMate API" },
                        version: { type: "string", example: "0.1.0" },
                        timestamp: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/health/db": {
          get: {
            tags: ["健康检查"],
            summary: "数据库连接检查",
            responses: {
              200: {
                description: "数据库状态",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        status: { type: "string", example: "ok" },
                        database: { type: "string", example: "connected" },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        // ==================== 认证 ====================
        "/auth/register": {
          post: {
            tags: ["认证"],
            summary: "用户注册（创建租户和用户）",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["email", "password", "name", "tenantName"],
                    properties: {
                      email: { type: "string", format: "email" },
                      password: { type: "string", minLength: 6 },
                      name: { type: "string" },
                      tenantName: { type: "string" },
                      phone: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              201: {
                description: "注册成功，返回 JWT token",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string", example: "OK" },
                        data: {
                          type: "object",
                          properties: {
                            token: { type: "string" },
                            user: { $ref: "#/components/schemas/User" },
                            tenant: { $ref: "#/components/schemas/Tenant" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              409: { description: "邮箱已注册" },
            },
          },
        },
        "/auth/login": {
          post: {
            tags: ["认证"],
            summary: "用户登录",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["email", "password"],
                    properties: {
                      email: { type: "string", format: "email" },
                      password: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "登录成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string", example: "OK" },
                        data: {
                          type: "object",
                          properties: {
                            token: { type: "string" },
                            user: { $ref: "#/components/schemas/User" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              401: { description: "邮箱或密码错误" },
            },
          },
        },

        // ==================== 租户 ====================
        "/tenant/info": {
          get: {
            tags: ["租户"],
            summary: "获取当前租户信息",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "租户信息",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string", example: "OK" },
                        data: { $ref: "#/components/schemas/Tenant" },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        // ==================== 内容 ====================
        "/content": {
          get: {
            tags: ["内容"],
            summary: "获取内容列表（分页、筛选）",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "type", in: "query", schema: { type: "string", enum: ["article", "video_script", "reply"] } },
              { name: "status", in: "query", schema: { type: "string", enum: ["draft", "reviewing", "approved", "published"] } },
              { name: "userId", in: "query", schema: { type: "string", format: "uuid" } },
              { name: "page", in: "query", schema: { type: "integer", default: 1 } },
              { name: "pageSize", in: "query", schema: { type: "integer", default: 20 } },
            ],
            responses: {
              200: {
                description: "内容列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: {
                          type: "object",
                          properties: {
                            items: { type: "array", items: { $ref: "#/components/schemas/Content" } },
                            total: { type: "integer" },
                            page: { type: "integer" },
                            pageSize: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            tags: ["内容"],
            summary: "创建内容",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["type"],
                    properties: {
                      type: { type: "string", enum: ["article", "video_script", "reply"] },
                      title: { type: "string" },
                      body: { type: "string" },
                      conversationId: { type: "string", format: "uuid" },
                    },
                  },
                },
              },
            },
            responses: {
              201: {
                description: "内容创建成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/Content" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/content/stats": {
          get: {
            tags: ["内容"],
            summary: "获取内容统计（按状态和类型分类）",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "内容统计",
              },
            },
          },
        },
        "/content/{id}": {
          get: {
            tags: ["内容"],
            summary: "获取单个内容详情",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "内容详情",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/Content" },
                      },
                    },
                  },
                },
              },
              404: { description: "内容不存在" },
            },
          },
          patch: {
            tags: ["内容"],
            summary: "更新内容（人工编辑）",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      body: { type: "string" },
                      status: { type: "string", enum: ["draft", "reviewing", "approved", "published"] },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "内容更新成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/Content" },
                      },
                    },
                  },
                },
              },
            },
          },
          delete: {
            tags: ["内容"],
            summary: "删除内容",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "内容删除成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: {
                          type: "object",
                          properties: { id: { type: "string", format: "uuid" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        // ==================== 对话 ====================
        "/chat/conversations": {
          get: {
            tags: ["对话"],
            summary: "获取对话列表",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "对话列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { type: "array", items: { $ref: "#/components/schemas/Conversation" } },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            tags: ["对话"],
            summary: "创建新对话",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      skillType: { type: "string", enum: ["article", "video", "customer_service", "general"] },
                    },
                  },
                },
              },
            },
            responses: {
              201: {
                description: "对话创建成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/Conversation" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/chat/conversations/{id}/messages": {
          get: {
            tags: ["对话"],
            summary: "获取对话消息历史（支持分页）",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
              { name: "limit", in: "query", schema: { type: "integer", default: 50 } },
              { name: "before", in: "query", schema: { type: "string", format: "uuid" } },
            ],
            responses: {
              200: {
                description: "消息列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: {
                          type: "object",
                          properties: {
                            items: { type: "array", items: { $ref: "#/components/schemas/Message" } },
                            hasMore: { type: "boolean" },
                            oldestId: { type: "string", format: "uuid" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/chat/conversations/{id}/send": {
          post: {
            tags: ["对话"],
            summary: "发送消息并获取 AI 回复",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["content"],
                    properties: {
                      content: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "消息已发送，返回用户消息和 AI 回复",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: {
                          type: "object",
                          properties: {
                            userMessage: { $ref: "#/components/schemas/Message" },
                            aiMessage: { $ref: "#/components/schemas/Message" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/chat/skills": {
          get: {
            tags: ["对话"],
            summary: "获取可用的 Skill 列表",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "Skill 列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { type: "array" },
                      },
                    },
                  },
                },
              },
            },
          },
        },

        // ==================== 关键词 ====================
        "/keywords": {
          get: {
            tags: ["关键词"],
            summary: "获取关键词列表（分页、筛选）",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "page", in: "query", schema: { type: "integer" } },
              { name: "pageSize", in: "query", schema: { type: "integer" } },
              { name: "platform", in: "query", schema: { type: "string" } },
              { name: "category", in: "query", schema: { type: "string" } },
              { name: "status", in: "query", schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "关键词列表",
              },
            },
          },
        },
        "/keywords/today": {
          get: {
            tags: ["关键词"],
            summary: "获取今日关键词报告",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              200: {
                description: "今日关键词",
              },
            },
          },
        },
        "/keywords/trends": {
          get: {
            tags: ["关键词"],
            summary: "获取关键词趋势报告（exploding/rising/stable/cooling）",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              200: {
                description: "趋势报告",
              },
            },
          },
        },
        "/keywords/trends/{keyword}": {
          get: {
            tags: ["关键词"],
            summary: "获取单个关键词趋势详情",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "keyword", in: "path", required: true, schema: { type: "string" } },
              { name: "days", in: "query", schema: { type: "integer" } },
            ],
            responses: {
              200: {
                description: "关键词趋势",
              },
            },
          },
        },
        "/keywords/platforms": {
          get: {
            tags: ["关键词"],
            summary: "获取已注册爬虫平台",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "平台列表",
              },
            },
          },
        },
        "/keywords/dictionary": {
          get: {
            tags: ["关键词"],
            summary: "获取行业词库列表",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "level", in: "query", schema: { type: "string" } },
              { name: "category", in: "query", schema: { type: "string" } },
              { name: "isActive", in: "query", schema: { type: "string" } },
              { name: "source", in: "query", schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "词库列表",
              },
            },
          },
          post: {
            tags: ["关键词"],
            summary: "添加行业关键词",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["word", "level"],
                    properties: {
                      word: { type: "string" },
                      level: { type: "string", enum: ["primary", "secondary", "context"] },
                      category: { type: "string" },
                      weight: { type: "number" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "关键词添加成功",
              },
            },
          },
        },
        "/keywords/dictionary/categories": {
          get: {
            tags: ["关键词"],
            summary: "获取词库分类",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "分类列表",
              },
            },
          },
        },
        "/keywords/dictionary/init": {
          post: {
            tags: ["关键词"],
            summary: "初始化预置词库",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "词库初始化成功",
              },
            },
          },
        },
        "/keywords/dictionary/{id}": {
          patch: {
            tags: ["关键词"],
            summary: "更新行业关键词",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      category: { type: "string" },
                      weight: { type: "number" },
                      isActive: { type: "boolean" },
                      level: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "关键词更新成功",
              },
            },
          },
          delete: {
            tags: ["关键词"],
            summary: "删除行业关键词",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "关键词删除成功",
              },
            },
          },
        },
        "/keywords/crawl": {
          post: {
            tags: ["关键词"],
            summary: "手动触发全平台抓取（国内核心+SCI）",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "抓取完成",
              },
            },
          },
        },
        "/keywords/crawl/domestic": {
          post: {
            tags: ["关键词"],
            summary: "只抓国内核心线",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "抓取完成",
              },
            },
          },
        },
        "/keywords/crawl/sci": {
          post: {
            tags: ["关键词"],
            summary: "只抓 SCI 线",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "抓取完成",
              },
            },
          },
        },
        "/keywords/crawl/{platform}": {
          post: {
            tags: ["关键词"],
            summary: "手动触发单平台抓取",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "platform", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "抓取完成",
              },
            },
          },
        },
        "/keywords/clusters": {
          post: {
            tags: ["关键词"],
            summary: "关键词聚类+标题生成",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      track: { type: "string", enum: ["domestic", "sci", "all"] },
                      discipline: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "聚类完成",
              },
            },
          },
        },

        // ==================== 期刊 ====================
        "/journals": {
          get: {
            tags: ["期刊"],
            summary: "获取期刊列表（筛选+排序）",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "discipline", in: "query", schema: { type: "string" } },
              { name: "partition", in: "query", schema: { type: "string" } },
              { name: "ifMin", in: "query", schema: { type: "number" } },
              { name: "ifMax", in: "query", schema: { type: "number" } },
              { name: "warningOnly", in: "query", schema: { type: "boolean" } },
              { name: "safeOnly", in: "query", schema: { type: "boolean" } },
              { name: "keyword", in: "query", schema: { type: "string" } },
              { name: "sortBy", in: "query", schema: { type: "string", enum: ["views", "if", "acceptance"] } },
              { name: "page", in: "query", schema: { type: "integer" } },
              { name: "pageSize", in: "query", schema: { type: "integer" } },
            ],
            responses: {
              200: {
                description: "期刊列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: {
                          type: "object",
                          properties: {
                            items: { type: "array", items: { $ref: "#/components/schemas/Journal" } },
                            total: { type: "integer" },
                            page: { type: "integer" },
                            pageSize: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/journals/{id}": {
          get: {
            tags: ["期刊"],
            summary: "获取单个期刊详情",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "期刊详情",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/Journal" },
                      },
                    },
                  },
                },
              },
              404: { description: "期刊不存在" },
            },
          },
        },
        "/journals/{id}/warning-check": {
          get: {
            tags: ["期刊"],
            summary: "检查期刊预警状态（中科院预警名单、IF 检查）",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "预警检查结果",
              },
            },
          },
        },
        "/journals/meta/disciplines": {
          get: {
            tags: ["期刊"],
            summary: "获取学科列表（用于筛选器）",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "学科列表",
              },
            },
          },
        },
        "/journals/match": {
          post: {
            tags: ["期刊"],
            summary: "根据关键词智能匹配期刊",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["keywords"],
                    properties: {
                      keywords: { type: "array", items: { type: "string" } },
                      track: { type: "string", enum: ["domestic", "sci", "all"] },
                      discipline: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "匹配结果",
              },
            },
          },
        },
        "/journals/seed": {
          post: {
            tags: ["期刊"],
            summary: "导入种子期刊数据",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      force: { type: "boolean" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "导入完成",
              },
            },
          },
        },

        // ==================== 选题工坊 ====================
        "/topic/hooks": {
          post: {
            tags: ["选题"],
            summary: "为选定期刊找噱头",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["journalId"],
                    properties: {
                      journalId: { type: "string", format: "uuid" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "找到的噱头",
              },
            },
          },
        },
        "/topic/titles": {
          post: {
            tags: ["选题"],
            summary: "为噱头生成标题",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      hook: { type: "string" },
                      journal: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "生成的标题",
              },
            },
          },
        },

        // ==================== 工作流 ====================
        "/workflow/generate-article": {
          post: {
            tags: ["工作流"],
            summary: "根据工作流上下文生成图文文章",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      keywords: { type: "array", items: { type: "string" } },
                      title: { type: "string" },
                      journals: { type: "array" },
                      template: { type: "string" },
                      discipline: { type: "string" },
                      track: { type: "string" },
                      stylePrompt: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "生成的文章",
              },
            },
          },
        },

        // ==================== 账号管理 ====================
        "/accounts": {
          get: {
            tags: ["账号"],
            summary: "获取所有平台账号",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "platform", in: "query", schema: { type: "string" } },
              { name: "group", in: "query", schema: { type: "string" } },
            ],
            responses: {
              200: {
                description: "账号列表",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { type: "array", items: { $ref: "#/components/schemas/PlatformAccount" } },
                      },
                    },
                  },
                },
              },
            },
          },
          post: {
            tags: ["账号"],
            summary: "添加平台账号",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["platform", "accountName", "credentials"],
                    properties: {
                      platform: { type: "string", enum: ["wechat", "baijiahao", "toutiao", "zhihu", "xiaohongshu"] },
                      accountName: { type: "string" },
                      credentials: { type: "object" },
                      groupName: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              201: {
                description: "账号添加成功",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        code: { type: "string" },
                        data: { $ref: "#/components/schemas/PlatformAccount" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "/accounts/platforms": {
          get: {
            tags: ["账号"],
            summary: "获取支持的平台列表",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "平台列表",
              },
            },
          },
        },
        "/accounts/{id}": {
          patch: {
            tags: ["账号"],
            summary: "更新账号信息",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      accountName: { type: "string" },
                      credentials: { type: "object" },
                      groupName: { type: "string" },
                      status: { type: "string", enum: ["active", "disabled"] },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "账号更新成功",
              },
            },
          },
          delete: {
            tags: ["账号"],
            summary: "删除账号",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "账号删除成功",
              },
            },
          },
        },
        "/accounts/{id}/verify": {
          post: {
            tags: ["账号"],
            summary: "验证账号凭证",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "验证结果",
              },
            },
          },
        },
        "/publish": {
          post: {
            tags: ["账号"],
            summary: "批量发布内容到多个账号",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["contentId", "accountIds"],
                    properties: {
                      contentId: { type: "string", format: "uuid" },
                      accountIds: { type: "array", items: { type: "string", format: "uuid" } },
                      options: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "发布完成",
              },
            },
          },
        },

        // ==================== Agent 系统 ====================
        "/agents/status": {
          get: {
            tags: ["Agent"],
            summary: "获取 Agent 状态",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "Agent 列表",
              },
            },
          },
        },
        "/agents/daily-plan": {
          get: {
            tags: ["Agent"],
            summary: "获取每日计划",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "今日计划",
              },
            },
          },
        },
        "/agents/logs": {
          get: {
            tags: ["Agent"],
            summary: "获取 Agent 执行日志",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: {
              200: {
                description: "日志列表",
              },
            },
          },
        },
        "/agents/{name}/trigger": {
          post: {
            tags: ["Agent"],
            summary: "手动触发 Agent 执行",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "执行已触发",
              },
            },
          },
        },
        "/agents/orchestrator/progress": {
          get: {
            tags: ["Agent"],
            summary: "轮询 Orchestrator 执行进度",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "执行进度",
              },
            },
          },
        },
        "/agents/diagnostic": {
          get: {
            tags: ["Agent"],
            summary: "系统诊断（计划、内容、队列、Provider、Redis）",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "诊断信息",
              },
            },
          },
        },
        "/agents/review/pending": {
          get: {
            tags: ["Agent"],
            summary: "获取待审核内容",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "待审核内容列表",
              },
            },
          },
        },
        "/agents/review/{id}/approve": {
          post: {
            tags: ["Agent"],
            summary: "审核通过",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              200: {
                description: "已通过审核",
              },
            },
          },
        },
        "/agents/review/{id}/edit": {
          post: {
            tags: ["Agent"],
            summary: "编辑并通过审核",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      body: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "修改已保存",
              },
            },
          },
        },
        "/agents/review/{id}/reject": {
          post: {
            tags: ["Agent"],
            summary: "拒绝审核",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      reason: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "已打回",
              },
            },
          },
        },
        "/agents/config": {
          get: {
            tags: ["Agent"],
            summary: "获取 Agent 自动化配置",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "配置信息",
              },
            },
          },
          patch: {
            tags: ["Agent"],
            summary: "更新 Agent 自动化配置",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      autoPublishThreshold: { type: "integer" },
                      pauseThreshold: { type: "integer" },
                      dailyArticleLimit: { type: "integer" },
                      dailyVideoLimit: { type: "integer" },
                      focusDisciplines: { type: "array" },
                      enabledPlatforms: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "配置更新成功",
              },
            },
          },
        },

        // ==================== 知识库 ====================
        "/knowledge": {
          get: {
            tags: ["知识库"],
            summary: "获取知识库条目列表",
            security: [{ BearerAuth: [] }],
            parameters: [
              { name: "category", in: "query", schema: { type: "string" } },
              { name: "page", in: "query", schema: { type: "integer" } },
              { name: "pageSize", in: "query", schema: { type: "integer" } },
            ],
            responses: {
              200: {
                description: "知识库列表",
              },
            },
          },
          post: {
            tags: ["知识库"],
            summary: "创建知识库条目",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["category", "title", "content"],
                    properties: {
                      category: { type: "string" },
                      title: { type: "string" },
                      content: { type: "string" },
                      source: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              201: {
                description: "条目创建成功",
              },
            },
          },
        },
        "/knowledge/search": {
          post: {
            tags: ["知识库"],
            summary: "语义搜索知识库",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["query"],
                    properties: {
                      query: { type: "string" },
                      category: { type: "string" },
                      topK: { type: "integer" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "搜索结果",
              },
            },
          },
        },
        "/knowledge/{id}": {
          get: {
            tags: ["知识库"],
            summary: "获取知识库条目详情",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "条目详情",
              },
            },
          },
          patch: {
            tags: ["知识库"],
            summary: "更新知识库条目",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      content: { type: "string" },
                      source: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "条目更新成功",
              },
            },
          },
          delete: {
            tags: ["知识库"],
            summary: "删除知识库条目",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              200: {
                description: "条目删除成功",
              },
            },
          },
        },

        // ==================== 数据采集 ====================
        "/data-collection/hot-events/detect": {
          post: {
            tags: ["数据采集"],
            summary: "手动触发热点事件监控",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "检测完成",
              },
            },
          },
        },
        "/data-collection/competitors/analyze": {
          post: {
            tags: ["数据采集"],
            summary: "手动触发竞品分析",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "分析完成",
              },
            },
          },
        },

        // ==================== 内容引擎 ====================
        "/content-engine/generate": {
          post: {
            tags: ["内容引擎"],
            summary: "生成多格式内容（8 种形式）",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["topic", "format"],
                    properties: {
                      topic: { type: "string" },
                      format: { type: "string", enum: ["spoken", "article", "video_script", "infographic", "long_graphic", "short_video", "audio", "interactive"] },
                      audience: { type: "string" },
                      tone: { type: "string" },
                      keywords: { type: "array", items: { type: "string" } },
                      platform: { type: "string" },
                      wordCount: { type: "integer" },
                      extraRequirements: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "内容生成完成",
              },
            },
          },
        },

        // ==================== 推荐 ====================
        "/recommendations/today": {
          get: {
            tags: ["推荐"],
            summary: "获取今日选题推荐",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "今日推荐",
              },
            },
          },
        },
        "/recommendations/history": {
          get: {
            tags: ["推荐"],
            summary: "获取推荐历史",
            security: [{ BearerAuth: [] }],
            parameters: [{ name: "days", in: "query", schema: { type: "integer" } }],
            responses: {
              200: {
                description: "历史推荐",
              },
            },
          },
        },

        // ==================== 任务 ====================
        "/tasks": {
          post: {
            tags: ["任务"],
            summary: "创建异步任务",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["conversationId", "skillType", "userInput"],
                    properties: {
                      conversationId: { type: "string", format: "uuid" },
                      skillType: { type: "string" },
                      userInput: { type: "string" },
                      history: { type: "array" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "任务创建成功",
              },
            },
          },
        },

        // ==================== 看板 ====================
        "/dashboard/overview": {
          get: {
            tags: ["看板"],
            summary: "获取全局概览数据",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "概览数据",
              },
            },
          },
        },

        // ==================== 微信 ====================
        "/wechat/config": {
          get: {
            tags: ["微信"],
            summary: "获取公众号配置",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "配置信息",
              },
            },
          },
          post: {
            tags: ["微信"],
            summary: "保存/更新公众号配置",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      appId: { type: "string" },
                      appSecret: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "配置保存成功",
              },
            },
          },
        },
        "/wechat/config/verify": {
          post: {
            tags: ["微信"],
            summary: "验证公众号配置",
            security: [{ BearerAuth: [] }],
            responses: {
              200: {
                description: "验证结果",
              },
            },
          },
        },
        "/wechat/draft": {
          post: {
            tags: ["微信"],
            summary: "创建草稿",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      contentId: { type: "string", format: "uuid" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "草稿创建成功",
              },
            },
          },
        },
        "/wechat/publish": {
          post: {
            tags: ["微信"],
            summary: "发布草稿",
            security: [{ BearerAuth: [] }],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      mediaId: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: "发布成功",
              },
            },
          },
        },
      },
    };

    return reply.send(openapi);
  });
}
