/**
 * LLM 接入点自检 —— `pnpm --filter @bossmate/server llm:check`
 *
 * 干两件事:
 *   ① 静态配对校验(与服务启动时跑的是同一份纯函数 checkLlmEndpointConfig): baseURL 与
 *      API Key 是不是配套的、百炼路径有没有写成原生 /api/v1 等。
 *   ② 可选联网探活: GET {baseUrl}/models —— 这是**不计费**的模型列表接口, 能一次性验出
 *      "域名对不对 / key 认不认"(401 就是 key 不对)。**绝不发 chat 请求**, 不烧一分钱。
 *      加 --offline 可跳过联网, 只做静态校验。
 *
 * 切百炼的正确姿势(只改这一个开关, baseURL 与 key 会成对切换):
 *   DEEPSEEK_VIA=bailian   # 配合 QWEN_API_KEY = 百炼控制台 API-KEY
 */
import {
  checkLlmEndpointConfig,
  getLlmEndpoint,
  type LlmEndpoint,
  type LlmProviderName,
} from "../services/ai/llm-endpoints.js";
import { env } from "../config/env.js";

function mask(key: string): string {
  if (key.length <= 10) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

async function probe(ep: LlmEndpoint): Promise<string> {
  const url = `${ep.baseUrl}/models`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${ep.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) return `✅ ${resp.status} 通(域名对 + key 认)`;
    const body = (await resp.text()).slice(0, 160);
    if (resp.status === 401 || resp.status === 403) {
      return `❌ ${resp.status} key 不被接受 —— 多半是 baseURL 与 key 不配套(${ep.keySource} 打 ${ep.baseUrl})\n     ${body}`;
    }
    if (resp.status === 404) {
      return `❌ 404 路径不对 —— 百炼 OpenAI 兼容端点是 /compatible-mode/v1(别写成原生 /api/v1)\n     ${body}`;
    }
    return `⚠️ ${resp.status} ${body}`;
  } catch (err) {
    return `❌ 网络不通: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main() {
  const offline = process.argv.includes("--offline");

  console.log("========== LLM 接入点自检 ==========\n");
  console.log(`DEEPSEEK_VIA = ${env.DEEPSEEK_VIA}  (official=DeepSeek 官方账户 | bailian=阿里云百炼)`);
  console.log(`模型: chat=${env.DEEPSEEK_MODEL_CHAT}  reasoner=${env.DEEPSEEK_MODEL_REASONER}  qwen=${env.QWEN_MODEL_PLUS}\n`);

  const names: LlmProviderName[] = ["deepseek", "qwen"];
  const endpoints: Array<[LlmProviderName, LlmEndpoint | null]> = names.map((n) => [n, getLlmEndpoint(n)]);

  for (const [name, ep] of endpoints) {
    if (!ep) {
      console.log(`【${name}】未配置(缺 API Key) → 该线路不可用`);
      continue;
    }
    console.log(`【${name}】`);
    console.log(`  baseURL : ${ep.baseUrl}`);
    console.log(`  key     : ${mask(ep.apiKey)}  (来自 ${ep.keySource})`);
    console.log(`  扣费账户: ${ep.billingAccount}`);
  }

  const issues = checkLlmEndpointConfig({
    deepseekVia: env.DEEPSEEK_VIA,
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    qwenApiKey: env.QWEN_API_KEY,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL,
    qwenBaseUrl: env.QWEN_BASE_URL,
  });

  console.log("\n---------- 静态配对校验 ----------");
  if (issues.length === 0) {
    console.log("  ✅ 无问题");
  } else {
    for (const i of issues) console.log(`  ${i.level === "error" ? "❌" : "⚠️"} [${i.code}] ${i.message}`);
  }

  if (!offline) {
    console.log("\n---------- 联网探活(GET /models, 不计费) ----------");
    for (const [name, ep] of endpoints) {
      if (!ep) continue;
      console.log(`  ${name}: ${await probe(ep)}`);
    }
  }

  const fatal = issues.some((i) => i.level === "error");
  console.log(fatal ? "\n结论: ❌ 有致命配置错误, 生产启动会被拦下, 先按上面提示改 .env" : "\n结论: ✅ 配置成对, 可以起服务");
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
