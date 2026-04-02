import { z } from "zod";

export interface ToolContext {
  tenantId: string;
  userId: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ITool {
  readonly name: string;
  readonly description: string;
  readonly parameters: z.ZodObject<z.ZodRawShape>;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/**
 * 把 Zod schema 转为 JSON Schema（简化版）
 * 用于将来传给 AI 的 function calling
 */
export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    if (field instanceof z.ZodString) {
      properties[key] = { type: "string", description: field.description };
    } else if (field instanceof z.ZodNumber) {
      properties[key] = { type: "number", description: field.description };
    } else if (field instanceof z.ZodBoolean) {
      properties[key] = { type: "boolean", description: field.description };
    } else if (field instanceof z.ZodArray) {
      properties[key] = { type: "array", description: field.description };
    } else {
      properties[key] = { type: "string" };
    }

    if (!field.isOptional()) {
      required.push(key);
    }
  }

  return { type: "object", properties, required };
}
