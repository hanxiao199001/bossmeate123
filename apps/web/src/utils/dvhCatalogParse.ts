/**
 * 7-21 数字人形象「批量粘贴导入」解析纯函数。
 *   老板从阿里云控制台(2D 资产中心)复制形象信息, 一次粘贴多行导入目录。
 *   每行格式: 名字 | avatarCode | voiceCode(可选) | 预览图URL(可选)
 *   分隔符容错: 竖线 | 或全角 ｜ 或制表符(Tab, 从表格粘贴时) 或 2+ 连续空格。
 *   镜像后端 PATCH /admin/dvh-catalog 的字段结构; 解析只产出候选, 追加/去重由调用方决定。
 */

/** 系统默认音色(与 template-mapping.ts 默认形象一致): 艾夏-亲和女声 */
export const DEFAULT_DVH_VOICE = { code: "aixia", label: "艾夏-亲和女声" } as const;

/** 阿里云 2D 公模形象 Code 前缀; 不符合只警告不拦 */
export const DVH_AVATAR_CODE_PREFIX = "CH_2d_";

export interface ParsedDvhEntry {
  key: string;
  avatarCode: string;
  avatarLabel: string;
  voiceCode: string;
  voiceLabel: string;
  templateLabel: string;
  preview?: string;
  /** 原始行号(1 基), 用于预览定位 */
  line: number;
  /** 同 avatarCode 已在现有目录 或 本次粘贴内更靠前已出现 → 导入时跳过 */
  isDup: boolean;
  /** avatarCode 非 CH_2d_ 开头 → 前端标红提示, 不阻断其它行 */
  codeWarning: boolean;
}

export interface ParseDvhOptions {
  /** 现有目录已占用的 avatarCode(含内置 4 个), 用于标记「已存在」 */
  existingCodes?: string[];
  /** voiceCode 省略时回退的默认音色 code */
  defaultVoiceCode?: string;
  /** 默认音色的展示名 */
  defaultVoiceLabel?: string;
}

/** 由名字 + code 末 4 位生成唯一 key(与手动添加一致) */
export function makeDvhKey(label: string, code: string): string {
  const base = (label || code).slice(0, 36).replace(/\s+/g, "_");
  return `${base}_${code.slice(-4)}`;
}

/** 拆分一行: 优先按 |/｜/Tab, 其次按 2+ 空格 */
function splitLine(line: string): string[] {
  if (/[|｜\t]/.test(line)) {
    return line.split(/[|｜\t]/).map((c) => c.trim());
  }
  return line.split(/\s{2,}/).map((c) => c.trim());
}

/**
 * 解析粘贴文本 → 候选形象条目 + 硬错误(缺必填字段的行)。
 * - 名字、avatarCode 必填; 缺任一 → 记 error 跳过该行。
 * - voiceCode 省略 → 用系统默认音色。
 * - avatarCode 非 CH_2d_ 开头 → 条目 codeWarning=true(不拦)。
 * - 同 avatarCode(相对现有目录或批内更早行) → 条目 isDup=true(导入跳过)。
 */
export function parseDvhCatalogPaste(
  text: string,
  opts: ParseDvhOptions = {},
): { entries: ParsedDvhEntry[]; errors: string[] } {
  const defaultVoiceCode = opts.defaultVoiceCode ?? DEFAULT_DVH_VOICE.code;
  const defaultVoiceLabel = opts.defaultVoiceLabel ?? DEFAULT_DVH_VOICE.label;
  const seen = new Set<string>((opts.existingCodes ?? []).filter(Boolean));

  const raw = (text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const entries: ParsedDvhEntry[] = [];
  const errors: string[] = [];

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    if (!rawLine.trim()) return; // 空行跳过
    const cells = splitLine(rawLine);
    const name = (cells[0] ?? "").trim();
    const avatarCode = (cells[1] ?? "").trim();
    const voiceCode = (cells[2] ?? "").trim();
    const preview = (cells[3] ?? "").trim();

    if (!name || !avatarCode) {
      errors.push(`第 ${lineNo} 行缺少必填项(名字 / 形象Code)，已跳过`);
      return;
    }

    const finalVoice = voiceCode || defaultVoiceCode;
    const finalVoiceLabel = voiceCode ? voiceCode : defaultVoiceLabel;
    const isDup = seen.has(avatarCode);
    if (!isDup) seen.add(avatarCode); // 批内后续同 code 也算重复

    entries.push({
      key: makeDvhKey(name, avatarCode),
      avatarCode,
      avatarLabel: name,
      voiceCode: finalVoice,
      voiceLabel: finalVoiceLabel,
      templateLabel: name,
      ...(preview ? { preview } : {}),
      line: lineNo,
      isDup,
      codeWarning: !avatarCode.startsWith(DVH_AVATAR_CODE_PREFIX),
    });
  });

  return { entries, errors };
}
