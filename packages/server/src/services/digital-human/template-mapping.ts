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
