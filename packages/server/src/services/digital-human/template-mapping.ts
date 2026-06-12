/**
 * 4 模板 → avatar + voice mapping (5-13 user 从阿里数字人平台拿真值)
 *
 * Spec 来源：user cowork PM 5-13 平台真实例信息
 * 之前 user memory 5-12 22:03 记的灵川/灵玥/灵芮/灵将 + shunshi-style 等已作废，
 * 真值见下表。
 */

export type TemplateId = "A_academic" | "B_marketing" | "C_popular" | "E_industry";

export interface AvatarVoiceMapping {
  avatarCode: string; // 数字人形象 Code (DVH API: AvatarInfo.Code)
  avatarLabel: string; // 人类可读名 (日志/admin)
  voiceCode: string; // TTS 发音人 Code (DVH API: AudioInfo.Voice)
  voiceLabel: string;
  templateLabel: string;
  // PR #243 (5-23): 背景图 OSS URL (DVH API: VideoInfo.backgroundImageUrl).
  //   缺省 → 用 env DVH_DEFAULT_BG_URL → 仍缺 → DVH 默认黑底.
  backgroundUrl?: string;
}

export const TEMPLATE_AVATAR_VOICE_MAP: Record<TemplateId, AvatarVoiceMapping> = {
  A_academic: {
    // PR #258 (5-28): academic 模板换形象+声音.
    //   原 紫灵礼服站姿+艾佳: 礼服画风太娱乐, 与学术违和; aijia 播音腔 AI 感重.
    //   新 馨馨坐姿西装+艾夏: 西装坐姿正式职业感, aixia "客服数字人" 版本嘴型契合度更高.
    avatarCode: "CH_2d_MHBF8Br0ld8W8yoi",
    avatarLabel: "馨馨-西装坐姿",
    voiceCode: "aixia",
    voiceLabel: "艾夏-亲和女声",
    templateLabel: "A 学术",
  },
  B_marketing: {
    avatarCode: "CH_2d_8llEIn0PmNlTWpWs",
    avatarLabel: "筱曲站姿02",
    voiceCode: "maoxiaomei",
    voiceLabel: "猫小美-活力女声",
    templateLabel: "B 营销",
  },
  C_popular: {
    avatarCode: "CH_2d_UY8seLTndqU3gSXD",
    avatarLabel: "emily无桌站姿",
    voiceCode: "aixia",
    voiceLabel: "艾夏-亲和女声",
    templateLabel: "C 科普",
  },
  E_industry: {
    avatarCode: "CH_2d_alIxNPvTg62qntxE",
    avatarLabel: "紫灵裙装站姿",
    voiceCode: "aiyuan",
    voiceLabel: "Aiyuan-知心温情",
    templateLabel: "E 行业",
  },
};


// ===== PR-X2: 形象/音色目录化 — 默认 4 个 + SYSTEM config 扩展 (不再硬编码上限) =====
// 管理员从阿里云 DVH 控制台拿到新形象/音色的真实 Code 后, 通过 PATCH /admin/dvh-catalog 添加,
// key 可以是新名字(出现在前端主播选择器), 也可以覆盖默认 4 个的形象配置。
import { eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { tenants } from "../../models/schema.js";
import { SYSTEM_RECOMMENDATION_TENANT_ID } from "../../config/system-recommendation.js";

export interface DvhCatalogEntry extends AvatarVoiceMapping {
  key: string;
}

function isValidEntry(e: unknown): e is DvhCatalogEntry {
  const x = e as Record<string, unknown>;
  return !!x && typeof x.key === "string" && !!x.key
    && typeof x.avatarCode === "string" && !!x.avatarCode
    && typeof x.voiceCode === "string" && !!x.voiceCode;
}

/** 默认 4 个 + config 扩展合并 (config 同 key 覆盖默认) */
export async function loadDvhCatalog(): Promise<DvhCatalogEntry[]> {
  const defaults: DvhCatalogEntry[] = (Object.entries(TEMPLATE_AVATAR_VOICE_MAP) as Array<[TemplateId, AvatarVoiceMapping]>)
    .map(([key, m]) => ({ key, ...m }));
  try {
    const [t] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, SYSTEM_RECOMMENDATION_TENANT_ID)).limit(1);
    const extras = (((t?.config as any)?.automationConfig?.dvhCatalog) ?? []) as unknown[];
    const cleanExtras = extras.filter(isValidEntry).map((e) => ({
      key: e.key.slice(0, 40),
      avatarCode: e.avatarCode,
      avatarLabel: e.avatarLabel || e.key,
      voiceCode: e.voiceCode,
      voiceLabel: e.voiceLabel || e.voiceCode,
      templateLabel: e.templateLabel || e.key,
      ...(e.backgroundUrl ? { backgroundUrl: e.backgroundUrl } : {}),
    }));
    const merged = new Map<string, DvhCatalogEntry>();
    for (const d of defaults) merged.set(d.key, d);
    for (const e of cleanExtras) merged.set(e.key, e);
    return [...merged.values()];
  } catch {
    return defaults;
  }
}

/** key → 形象映射 (目录里找, 找不到回退硬编码默认, 都没有 = null) */
export async function resolveAvatarVoice(key: string): Promise<AvatarVoiceMapping | null> {
  const catalog = await loadDvhCatalog();
  const hit = catalog.find((c) => c.key === key);
  if (hit) return hit;
  return (TEMPLATE_AVATAR_VOICE_MAP as Record<string, AvatarVoiceMapping>)[key] ?? null;
}
