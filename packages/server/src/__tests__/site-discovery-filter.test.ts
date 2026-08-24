/**
 * 官网发现过滤器 —— 用 2026-08-23/24 实测到的**真实 URL 与标题**当输入。
 *
 * 自己撞见过的样本是最可靠的测试来源：它一定发生过，不是想象出来的边界。
 */
import { describe, it, expect } from "vitest";
import { checkCandidateSite } from "../services/journals/site-discovery-filter.js";

describe("① 固定域名黑名单（大站）", () => {
  it.each([
    "https://www.eshukan.com/displayj.aspx?jid=10109",
    "http://ywjs.juqk.net/",
    "http://ywjs.llyj.net/",
    "https://ywjs.mlunwen.com/",
    "https://zgdhjy.jyqikan.com/",
  ])("%s → intermediary", (url) => {
    expect(checkCandidateSite(url).verdict).toBe("intermediary");
  });
});

describe("🔴 ② 每刊一域名的中介网络 —— 域名黑名单拦不住，靠标题模板", () => {
  const 模板标题 = "《成都体育学院学报》成都体育学院学报杂志社投稿_期刊论文发表|版面费|电话|编辑部|论文发表";

  it("域名形如 拼音缩写+zzs+.cn → 即使不在黑名单也判中介", () => {
    const r = checkCandidateSite("https://www.tsgxyjzzs.cn/");
    expect(r.verdict).toBe("intermediary");
    expect(r.reasons.join()).toContain("每刊一域名");
  });

  it("标题命中「版面费|电话」模板 → 判中介", () => {
    expect(checkCandidateSite("https://www.cdtyxyxbzz.cn/", 模板标题).verdict).toBe("intermediary");
  });

  it("🔴 不传 title 时会漏掉只有标题特征的那些 —— 所以调用方必须传", () => {
    // 构造一个域名不符合 zz 形状、但标题是中介模板的候选
    const 只有标题特征 = checkCandidateSite("https://www.example-journal.com/", 模板标题);
    expect(只有标题特征.verdict).toBe("intermediary");
    const 不传标题 = checkCandidateSite("https://www.example-journal.com/");
    expect(不传标题.verdict).not.toBe("intermediary");   // 漏了 —— 这就是不传 title 的代价
  });
});

describe("🔴 知网门户单独一档：真官方，但我们不用", () => {
  it.each([
    "https://wgjn.cbpt.cnki.net/portal",
    "https://jxcy.cbpt.cnki.net/",
    "https://zdjy.cbpt.cnki.net/portal/journal/portal/client/news/ZDJY_x",
  ])("%s → cnki_portal（不是 intermediary）", (url) => {
    const r = checkCandidateSite(url);
    expect(r.verdict).toBe("cnki_portal");
    // 归错档的后果：日后有人放宽中介判定，会把知网门户一起放进来
    expect(r.verdict).not.toBe("intermediary");
  });
});

describe("正向：实测判定为官网的那些", () => {
  it.each([
    ["https://xbjk.ecnu.edu.cn/", null],
    // 🔴 首页判得出 official（.edu.cn），但**判不出平台** —— 平台特征在深层 URL 里。
    //   实测：同一个站 /cdtyxyxb/ 看不出，/cdtyxyxb/article/2025/3 才露出 magtech 形态。
    //   操作含义：阶段二做平台识别时，**必须先进到目录页再判**，拿首页判会系统性漏掉。
    ["https://cdtyxb.cdsu.edu.cn/cdtyxyxb/", null],
    ["http://jam.biam.ac.cn/indexen.htm", null],
    ["http://sioc-journal.cn/Jwk_hxxb/EN/0567-7351/home.shtml", "magtech"],
    ["http://journal.ucas.ac.cn/CN/2095-6134/home.shtml", "magtech"],
    ["http://chinaepi.icdc.cn/zhlxbxen/ch/index.aspx", "qinyun_sancai"],
    ["https://cdtyxb.cdsu.edu.cn/cdtyxyxb/article/2025/3", "magtech"],
  ])("%s → official, platform=%s", (url, platform) => {
    const r = checkCandidateSite(url as string);
    expect(r.verdict).toBe("official");
    expect(r.platform).toBe(platform);
  });
});

describe("数据库站与未知", () => {
  it("维普/万方/知网主站 → database（有内容但非官网）", () => {
    expect(checkCandidateSite("https://www.cqvip.com/journal/96950A").verdict).toBe("database");
    expect(checkCandidateSite("https://sns.wanfangdata.com.cn/perio/hdsfdxxb-jykxb").verdict).toBe("database");
  });

  it("两边特征都不足 → unknown，交人工（绝不猜成 official）", () => {
    const r = checkCandidateSite("https://www.jllib.com/tsgxyj/");
    expect(r.verdict).toBe("unknown");
    expect(r.reasons.join()).toContain("需人工确认");
  });
});
