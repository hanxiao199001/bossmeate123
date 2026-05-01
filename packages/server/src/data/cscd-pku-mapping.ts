/**
 * B.4-1 国内中文核心目录映射：ISSN → { cscdLevel?, pkuCoreLevel? }。
 * 数据源：CSCD 2023-2024（核心库/扩展库）+ 中文核心期刊要目总览 2023 第 10 版。
 * v1 seed 覆盖现有 journals 种子；admin 后续可加行扩展，重跑 ingest 即可。
 */

export type CscdLevel = "核心库" | "扩展库";
export type PkuCoreLevel = "北大核心";

export interface CscdPkuEntry {
  cscdLevel?: CscdLevel;
  pkuCoreLevel?: PkuCoreLevel;
}

export interface CscdPkuMappingFile {
  meta: {
    cscdSource: string;
    pkuSource: string;
    lastUpdatedAt: string;
  };
  mappings: Record<string, CscdPkuEntry>;
}

export const CSCD_PKU_MAPPING: CscdPkuMappingFile = {
  meta: {
    cscdSource: "CSCD 2023-2024 核心库 / 扩展库（中国科学引文数据库公示）",
    pkuSource: "中文核心期刊要目总览 2023 第 10 版（北大图书馆公示）",
    lastUpdatedAt: "2026-05-01",
  },
  mappings: {
    "0376-2491": { pkuCoreLevel: "北大核心", cscdLevel: "核心库" },
    "1671-167X": { pkuCoreLevel: "北大核心", cscdLevel: "扩展库" },
    "1002-5731": { pkuCoreLevel: "北大核心" },
    "1003-1707": { pkuCoreLevel: "北大核心" },
    "1002-896X": { pkuCoreLevel: "北大核心" },
    "1004-1303": { pkuCoreLevel: "北大核心" },
    "1000-0208": { pkuCoreLevel: "北大核心" },
    "1001-2397": { pkuCoreLevel: "北大核心" },
    "1674-5205": { pkuCoreLevel: "北大核心" },
    "1009-6728": { pkuCoreLevel: "北大核心" },
    "1004-8561": { pkuCoreLevel: "北大核心" },
    "0496-3490": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "0578-1752": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "0001-5733": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "0367-6234": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "1000-2243": { cscdLevel: "扩展库" },
    "1001-1455": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "1004-9037": { cscdLevel: "核心库", pkuCoreLevel: "北大核心" },
    "0250-3263": { cscdLevel: "核心库" },
    "1671-7406": { pkuCoreLevel: "北大核心" },
    "1000-0577": { pkuCoreLevel: "北大核心", cscdLevel: "核心库" },
    "1000-1131": { pkuCoreLevel: "北大核心", cscdLevel: "核心库" },
    "1003-7837": { cscdLevel: "扩展库" },
    "1002-9001": { pkuCoreLevel: "北大核心" },
    "1009-3729": { pkuCoreLevel: "北大核心" },
  },
};
