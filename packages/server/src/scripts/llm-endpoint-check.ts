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
  billingAccountLabel,
  checkLlmEndpointConfig,
  getLlmEndpoint,
  type BillingAccount,
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


/**
 * 🔴 计费探针 —— `/models` 探不出欠费，必须真发一次最小的计费请求。
 *
 * 8-17 血的教训：百炼欠费期间 `GET /models` **照样 200**，本脚本于是回
 *「✅ 配置成对，可以起服务」，而同一时刻任何 chat 调用都返回
 * `400 {"type":"Arrearage"}`，整条内容线停摆。欠费从 7-23 起断续发作 6 次，
 * 8-16 单日 154 次，全程没有任何工具说过一句"是因为没钱"。
 *
 * 成本：max_tokens=1 的一次调用，可忽略；换来的是"能不能真的干活"这个答案。
 * 不计费探活回答的是"地址和 key 对不对"，这两个问题不是一回事。
 */
async function probeBilled(ep: { baseUrl: string; apiKey: string; billingAccount: BillingAccount }, model: string): Promise<string> {
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "1" }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return "✅ 计费调用通(账户可用)";
    const body = await res.text();
    if (/arrearage|overdue|欠费|in good standing/i.test(body)) {
      // 8-26: 账户名不许硬编码 —— 探的是哪条线路就说哪条线路的扣费账户(见 describeQuotaAction 注释)
      return `🔴 **${billingAccountLabel(ep.billingAccount)}账户欠费** —— 去该账户充值, 充完自动恢复。原文: ${body.slice(0, 140)}`;
    }
    return `❌ ${res.status}: ${body.slice(0, 160)}`;
  } catch (e) {
    return `❌ 请求异常: ${e instanceof Error ? e.message : String(e)}`;
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

  let billedBad = false;
  if (!offline) {
    console.log("\n---------- 联网探活(GET /models, 不计费) ----------");
    for (const [name, ep] of endpoints) {
      if (!ep) continue;
      console.log(`  ${name}: ${await probe(ep)}`);
    }
    // 🔴 /models 探不出欠费 —— 必须再发一次真实计费请求(见 probeBilled 注释)
    console.log("\n---------- 账户探活(真发一次 max_tokens=1 的计费调用) ----------");
    for (const [name, ep] of endpoints) {
      if (!ep) continue;
      // 模型名走 env(红线 #3: 不许硬编码)
      const model = name === "qwen" ? env.QWEN_MODEL_PLUS : env.DEEPSEEK_MODEL_CHAT;
      const r = await probeBilled(ep, model);
      if (!r.startsWith("✅")) billedBad = true;
      console.log(`  ${name}: ${r}`);
    }
  }

  const fatal = issues.some((i) => i.level === "error");
  // 配置对但账户不可用, 照样干不了活 —— 结论必须体现这一点, 不能再回"可以起服务"
  console.log(
    fatal
      ? "\n结论: ❌ 有致命配置错误, 生产启动会被拦下, 先按上面提示改 .env"
      : billedBad
        ? "\n结论: ⚠️ 配置成对, 但**账户侧调用不通**(见上方账户探活) —— 起了服务也生成不出东西"
        : "\n结论: ✅ 配置成对且账户可用",
  );
  process.exit(fatal ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
