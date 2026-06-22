/**
 * 6-21 Jina Reader 网页抓取 —— 复活期刊官网链路。
 *   背景: 服务器是数据中心 IP, 直连/stealth 抓期刊官网常被 Cloudflare 屏蔽(见 orchestrator 注释)。
 *   Jina Reader(r.jina.ai)从 Jina 自己的服务器渲染+清洗网页, 不走我们的 IP → 绕开 CF; 返回干净 markdown,
 *   比原始 HTML 更省 token、LLM 抽取更准; 服务器侧零 Chromium。
 *
 *   纪律(沿用 LetPub 反爬铁律): 默认开, 可 env 熔断; 超时硬封顶; 失败返回 null 不抛(orchestrator partial OK)。
 *   env:
 *     JINA_FETCH_ENABLED=false  → 熔断, 直接返回 null
 *     JINA_API_KEY=...          → 可选, 配了走更高速率额度(无则用免费匿名额度)
 *     JINA_FETCH_TIMEOUT_MS     → 默认 25000
 */
import { logger } from "../../../../config/logger.js";

const TIMEOUT_MS = Number(process.env.JINA_FETCH_TIMEOUT_MS) || 25000;
const MAX_CHARS = 60000; // 截断超长页面, 控住下游 LLM token

/** 抓取网页并返回干净 markdown。失败/熔断返回 null。 */
export async function fetchCleanPage(url: string): Promise<string | null> {
  if (process.env.JINA_FETCH_ENABLED === "false") {
    logger.debug({ url }, "jina: 已熔断(JINA_FETCH_ENABLED=false)");
    return null;
  }
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const endpoint = "https://r.jina.ai/" + url; // Jina Reader: 前缀目标 URL
  const headers: Record<string, string> = { "X-Return-Format": "markdown", Accept: "text/plain" };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, { headers, signal: controller.signal });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "jina: 抓取失败(HTTP)");
      return null;
    }
    const md = (await res.text()).trim();
    if (md.length < 80) return null; // 太短=没抓到正文
    return md.length > MAX_CHARS ? md.slice(0, MAX_CHARS) : md;
  } catch (err) {
    logger.warn({ url, err: err instanceof Error ? err.message : String(err) }, "jina: 抓取异常");
    return null;
  } finally {
    clearTimeout(timer);
  }
}
