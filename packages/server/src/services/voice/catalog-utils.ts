/**
 * 7-10 音色库纯函数工具(可单测, 无 IO)。
 *   与 tts-service.synthesizeDashscope 的克隆音检测保持同一判据:
 *   voice_id 含 '-vc-' 或以 'cosyvoice-' 开头 = 克隆音; 否则按预置音色处理。
 */

/** 克隆/预置判型 — 判据须与 tts-service 里 /-vc-|^cosyvoice-/i 一致, 改一处必须同步另一处。 */
export function inferVoiceType(voiceId: string): "cloned" | "preset" {
  return /-vc-|^cosyvoice-/i.test(voiceId) ? "cloned" : "preset";
}

/** 录音入库的默认名: "账号名的声音 M-D"(前端没填名字时用)。截断到 60(voice_catalog.name 上限)。 */
export function defaultCloneName(accountName?: string | null, now: Date = new Date()): string {
  const base = (accountName ?? "").trim() || "我";
  return `${base}的声音 ${now.getMonth() + 1}-${now.getDate()}`.slice(0, 60);
}

/** 存量 clonedVoiceId 补录 catalog 的条目名: 备注名 > 账号名 > "账号", 加"的声音"后缀, 截断 60。 */
export function backfillCloneName(accountName?: string | null, remark?: string | null): string {
  const base = (remark ?? "").trim() || (accountName ?? "").trim() || "账号";
  return `${base}的声音`.slice(0, 60);
}

/** 音色库列表/管理页展示用: voice_id 尾 6 位(全量 id 太长且无需暴露)。 */
export function voiceTail(voiceId: string, n = 6): string {
  const v = voiceId.trim();
  return v.length > n ? `…${v.slice(-n)}` : v;
}

/** 改名入参校验: 去空白、非空、≤60。不合法返回 null。 */
export function sanitizeCatalogName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const t = name.trim();
  if (!t || t.length > 60) return null;
  return t;
}

/** 单次生成临时音色入参校验: 非空字符串且 ≤120(voice_id 列宽), 否则 undefined(走账号绑定/默认)。 */
export function sanitizeVoiceOverride(voiceId: unknown): string | undefined {
  if (typeof voiceId !== "string") return undefined;
  const t = voiceId.trim();
  if (!t || t.length > 120) return undefined;
  return t;
}
