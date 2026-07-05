/**
 * 7-05 老韩拍板: 自引率风险阈值统一口径 — ≤20% 都算低风险(期刊行业常识, 原 5%/15% 分界过严,
 *   把 10.2% 标成"中风险"吓退读者), 20-30% 中风险, >30% 高风险。
 * 全部渲染点(shunshi徽章/wechat模板/listicle避坑提醒)共用本 helper, 禁止各自写死阈值。
 */

/** 单位兼容(PR #234): >1 视为绝对百分点直用, ≤1 视为 ratio ×100; 非法(≤0 或 >100)返回 null。 */
export function selfCitationPct(rate: number | null | undefined): number | null {
  if (typeof rate !== "number" || rate <= 0 || rate > 100) return null;
  return rate > 1 ? rate : rate * 100;
}

export interface SelfCitationRisk {
  level: "低" | "中" | "高";
  /** 渲染色: 低=绿 中=橙 高=红 */
  color: string;
}

export function selfCitationRisk(pct: number): SelfCitationRisk {
  if (pct <= 20) return { level: "低", color: "#388E3C" };
  if (pct <= 30) return { level: "中", color: "#F57C00" };
  return { level: "高", color: "#D32F2F" };
}
