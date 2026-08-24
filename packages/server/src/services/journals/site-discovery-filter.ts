/**
 * 期刊官网发现 —— 中介站过滤器（2026-08-23/24 实测归纳）。
 *
 * ═══ 为什么需要它 ═══
 *
 * 搜「刊名 + 官网」时，**结果被论文中介站占满**，真官网往往排不进前列。
 * 实测 6 本刊的搜索结果里，中介站占 70-100%。
 *
 * ═══ 🔴 两条特征，域名黑名单只是其中之一 ═══
 *
 * **① 固定域名黑名单** —— 大站，一个域名服务所有刊
 *
 * **② 标题模板 + 域名命名规律** —— 这是更关键的一条。
 * 实测存在一个中介网络：**每本刊一个独立域名**，域名黑名单拦不住它。
 * 但它们共用同一个标题模板：
 *
 * ```
 * www.cdtyxyxbzz.cn   《成都体育学院学报》…投稿_期刊论文发表|版面费|电话|编辑部|论文发表
 * www.zgdhjyzz.cn     《中国电化教育》…投稿_期刊论文发表|版面费|电话|编辑部|论文发表
 * www.tsgxyjzzs.cn    《图书馆学研究》…投稿_期刊论文发表|版面费|电话|编辑部|论文发表
 * ```
 *
 * 域名规律：**刊名拼音缩写 + `zz`/`zzs`/`zazhi` + `.cn`**。
 * 单看域名像官网（.cn、和刊名相关），单看标题才露馅。
 *
 * ▎ 一个特征拦不住的，往往不是因为特征错了，
 * ▎ 而是因为对方的变化维度和你的判据不在同一个维度上。
 *
 * ═══ 🔴 知网门户单独一档 ═══
 *
 * `cbpt.cnki.net` **是真官方门户**（不是中介），但撞硬约束「不碰知网」。
 * 所以它不能归进 `intermediary` —— 归错了，日后有人放宽中介判定时会连它一起放进来。
 * 单独标 `cnki_portal`，语义是「真的，但我们不用」。
 */

/** ① 固定域名黑名单（大站，实测出现过） */
const INTERMEDIARY_DOMAINS = [
  "eshukan.com", "xueshu.com", "mqikan.com", "yipinqikan.com", "juqk.net",
  "llyj.net", "ndhx.net", "mlunwen.com", "xuekanba.com", "fabiaoji.com",
  "zazhi.com.cn", "sfabiao.com", "qikansky.com", "21ks.net", "fabiao.com.cn",
  "youfabiao.com", "kuaiqikan.com", "meizhang.com", "schwyx.com", "qikan58.com",
  "baywatch.cn", "zazhilin.cn", "hhxueshu.com", "soripan.net", "nseac.com",
  "toug.com.cn", "lunwentaotao.com", "itdw.cn", "yashilw.com", "yfabiao.com",
  "haofabiao.com", "hxlww.net", "yueqikan.com", "iikx.com", "abcxueshu.com",
  "journalfamily.com", "tougaozixun.com", "zhichengyz.com", "jyqikan.com",
] as const;

/** 数据库站 —— 有内容但不是官网，且各有各的条款 */
const DATABASE_DOMAINS = ["cqvip.com", "wanfangdata.com.cn", "cnki.net"] as const;

/**
 * ② 标题模板 —— 每刊一域名的中介网络靠这个抓。
 * 「版面费」是最强的单一信号：真官网要么不提，要么明说「不收费用」，
 * 不会把它放进 <title>。
 */
const INTERMEDIARY_TITLE_PATTERNS = [
  /投稿_期刊论文发表/,
  /版面费\s*[|｜]\s*电话/,
  /期刊论文发表\s*[|｜]/,
  /杂志社投稿_/,
  /论文发表\s*[|｜].*编辑部/,
] as const;

/** ② 域名命名规律：刊名拼音缩写 + zz/zzs/zazhi + .cn */
const INTERMEDIARY_DOMAIN_SHAPE = /^(?:www\.)?[a-z]{4,12}(?:zz|zzs|zazhi)\.cn$/i;

/** 正向特征：判定为真官网 */
const OFFICIAL_DOMAIN_HINTS = [/\.edu\.cn$/i, /\.ac\.cn$/i, /\.org\.cn$/i, /\.gov\.cn$/i];
const OFFICIAL_PATH_HINTS = [
  /\/CN\//, /\/EN\//, /home\.shtml/i, /Jwk_/i, /Journalx/i,
  /\/ch\/index\.aspx/i, /\/volumn\//i, /\/article\/\d{4}\//,
];

export type SiteVerdict =
  | "official"        // 判定为官网
  | "intermediary"    // 中介站
  | "database"        // 数据库站（非官网）
  | "cnki_portal"     // 知网期刊门户 —— 真官方，但撞「不碰知网」
  | "unknown";        // 两边特征都不足，需人工

export interface SiteCheck {
  verdict: SiteVerdict;
  reasons: string[];
  /** 命中的投稿系统平台（可解析性的先行指标） */
  platform: "magtech" | "qinyun_sancai" | null;
}

function hostOf(url: string): string {
  try { return new URL(url.startsWith("http") ? url : `http://${url}`).host.toLowerCase(); }
  catch { return url.toLowerCase(); }
}

/**
 * 判定一个候选 URL。
 *
 * @param title 搜索结果给的标题 —— **不传的话就少了第二条特征**，
 *              而每刊一域名的中介网络只有标题能抓。
 */
export function checkCandidateSite(url: string, title?: string | null): SiteCheck {
  const host = hostOf(url);
  const reasons: string[] = [];

  // 知网门户先判 —— 它是真官方，只是我们不用。归错档会在放宽中介判定时被误放进来。
  if (/(^|\.)cbpt\.cnki\.net$/i.test(host)) {
    return { verdict: "cnki_portal", reasons: ["知网期刊门户：真官方，但撞硬约束「不碰知网」"], platform: null };
  }
  if (DATABASE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { verdict: "database", reasons: [`数据库站 ${host}：有内容但非官网`], platform: null };
  }
  if (INTERMEDIARY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return { verdict: "intermediary", reasons: [`中介域名黑名单命中 ${host}`], platform: null };
  }
  if (INTERMEDIARY_DOMAIN_SHAPE.test(host)) {
    reasons.push(`域名形如「拼音缩写+zz/zzs+.cn」(${host}) —— 每刊一域名的中介网络`);
  }
  if (title) {
    for (const re of INTERMEDIARY_TITLE_PATTERNS) {
      if (re.test(title)) { reasons.push(`标题命中中介模板 ${re}`); break; }
    }
  }
  // 🔴 两条特征**任一命中即判中介** —— 域名形状单独出现时可能误伤（真官网也可能叫 xxzz.cn），
  //   但标题模板几乎不会误伤：真官网不会把「版面费|电话」写进 <title>。
  //   宁可误伤一个候选，也不要把中介站当官网写进库（写错比漏掉贵得多）。
  if (reasons.length > 0) return { verdict: "intermediary", reasons, platform: null };

  const platform: SiteCheck["platform"] =
    /Jwk_|Journalx|home\.shtml|\/CN\/|\/volumn\/|\/article\/\d{4}\//i.test(url) ? "magtech"
    : /\/ch\/index\.aspx|\.aspx/i.test(url) ? "qinyun_sancai"
    : null;
  if (platform) reasons.push(`投稿系统特征：${platform}`);

  const officialDomain = OFFICIAL_DOMAIN_HINTS.some((re) => re.test(host));
  if (officialDomain) reasons.push(`机构域名 ${host}`);
  const officialPath = OFFICIAL_PATH_HINTS.some((re) => re.test(url));
  if (officialPath) reasons.push("路径含期刊系统特征");

  if (officialDomain || platform || officialPath) return { verdict: "official", reasons, platform };
  return { verdict: "unknown", reasons: ["无中介特征，也无官网正向特征 —— 需人工确认"], platform: null };
}
