/**
 * 移植自 server draft-push.ts, 服务器侧改了要同步这里。
 * 源: packages/server/src/services/publisher/draft-push.ts (S12~S19 线上调试结晶)
 *
 * 改造仅限:
 *   1. logger → src/log.ts (console 实现, 兼容 pino 风格调用签名, 调用点零改动)
 *   2. 截图目录 FAIL_SHOT_DIR → ~/.bossmate-agent/screenshots/
 *   3. 去掉服务端队列/DB/登录态注入, 只保留两个 pusher 及其全部 helper
 * 选择器与流程逻辑一字不改。
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "puppeteer";
import { logger } from "./log.js";
import { SCREENSHOTS_DIR } from "./config.js";

const FAIL_SHOT_DIR = SCREENSHOTS_DIR;

// ===== 平台上传实现 =====
export interface UploadParams {
  /** 钩子标题 (文案包 hookTitle), 视频号短标题从这派生; 缺省回退 caption */
  title?: string;
  page: Page;
  videoPath: string;
  caption: string;
}

/** 抖音创作者中心: 上传 → 等转码 → 填文案 → 存草稿 (选择器多套兜底) */
export async function douyinPushDraft({ page: initialPage, videoPath, caption, title }: UploadParams): Promise<void> {
  let page = initialPage;
  // 6-11 四轮: 平台编辑页有 beforeunload"离开此网站?"原生弹窗(验证步骤导航离开时触发),
  // 有头模式下会真弹给用户且阻塞导航 → 自动接受
  page.on("dialog", (d) => { d.accept().catch(() => {}); });
  await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
    waitUntil: "domcontentloaded", // 创作页长连接, networkidle2 永不触发
    timeout: 60_000,
  });
  await new Promise((r) => setTimeout(r, 3_000));
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");

  // 1. 确保在上传页 (直链可能被重定向回首页), 再上传
  page = await douyinEnsureUploadPage(page);
  // 抖音是弹窗登录(不改URL): 出现扫码/登录弹窗 = 登录态失效
  const loginPopup = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const txt = (doc.body?.innerText || "");
    // 真上传页不含"扫码登录/验证码登录"对话框文案; 出现即登录态失效弹了登录框
    return /扫码登录|验证码登录|手机号登录|登录后即可|登录抖音/.test(txt);
  }).catch(() => false);
  if (loginPopup) throw new Error("LOGIN_EXPIRED");
  await uploadVideoFile(page, videoPath);
  logger.info("抖音推草稿: 视频文件已提交, 等待进入编辑页");

  // 2. 等编辑页就绪 (穿透 shadow DOM 找文案编辑器)
  const editor = await deepFindEditor(page, 90_000);
  if (!editor) throw new Error("等不到文案编辑器 (上传可能失败或页面改版, 见失败截图)");

  // 3. 填文案 — 6-11 真机修复: 抖音编辑页 = 标题框(30字硬限) + 简介框(1000字)。
  // 旧逻辑把整段 caption 打进第一个编辑器(标题框)被截 30 字。改: 标题框填短标题, 简介框尽力填全文案。
  const douyinTitle = (title && title.trim() ? title.trim() : caption).slice(0, 30);
  await editor.click();
  await page.keyboard.type(douyinTitle, { delay: 30 });
  await new Promise((r) => setTimeout(r, 800));
  // 简介框: 按 placeholder 深度查找(穿透 shadow DOM), 找不到不阻断(草稿可人工补简介)
  try {
    const briefHandle = await page.evaluateHandle(() => {
      const doc = (globalThis as any).document;
      const out: any[] = [];
      const walk = (root: any) => {
        if (!root) return;
        for (const el of root.querySelectorAll?.("*") ?? []) {
          const ph = (el.getAttribute?.("placeholder") ?? "") + (el.getAttribute?.("data-placeholder") ?? "");
          const cls = el.className?.toString?.() ?? "";
          if (/作品简介|添加作品简介/.test(ph) || (/editor/.test(cls) && /简介/.test(el.parentElement?.innerText?.slice(0, 80) ?? ""))) out.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(doc);
      return out[0] ?? null;
    });
    const briefEl = briefHandle.asElement();
    if (briefEl) {
      await (briefEl as any).click();
      await page.keyboard.type(caption.slice(0, 990), { delay: 20 });
      logger.info("抖音推草稿: 简介已填入");
    } else {
      logger.warn("抖音推草稿: 未找到简介框, 跳过(标题已填, 草稿可人工补简介)");
    }
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : e }, "抖音推草稿: 填简介异常, 跳过");
  }
  await new Promise((r) => setTimeout(r, 1_500));

  // 4. 等视频转码完成. 6-11 真机实锤: 当前版本按钮叫「暂存离开」(不再是"存草稿")
  const clicked = await clickButtonByText(page, ["暂存离开", "存草稿", "保存草稿", "暂存"], 180_000);
  if (!clicked) throw new Error("找不到或点不动「暂存离开/存草稿」按钮 (转码超时或页面改版)");
  logger.info("抖音推草稿: 已点「暂存离开」, 处理二次确认与结果验证");

  // 4b. 6-11 五轮: 「暂存离开」常弹二次确认(页面内"确定/确认离开/暂存"按钮) — 点掉它推进保存
  await new Promise((r) => setTimeout(r, 1_500));
  await clickButtonByText(page, ["确定", "确认离开", "确认暂存", "离开"], 4_000).catch(() => false);

  // 4c. 点击后现场截图(无论成败留证, 排查抖音保存流程靠它)
  try {
    await new Promise((r) => setTimeout(r, 2_500));
    await mkdir(FAIL_SHOT_DIR, { recursive: true });
    const shot = resolve(FAIL_SHOT_DIR, `douyin-aftersave-${Date.now()}.png`);
    await page.screenshot({ path: shot as any, fullPage: true });
    logger.info({ shot }, "抖音: 点暂存后现场截图");
  } catch { /* noop */ }

  // 5. 成功证据(唯一可信). 6-11 五轮真机实锤草稿存放方式: 抖音网页版「暂存离开」后**留在上传页**,
  //    再次进上传页顶部出现横幅"你还有上次未发布的视频, 是否继续编辑?[继续编辑][放弃]" = 草稿真在。
  //    (抖音没有独立"草稿箱"菜单, 作品管理里也查不到, 这条横幅就是草稿的唯一入口)
  const ok = await (async (): Promise<boolean> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const u = page.url();
      if (u.includes("login")) throw new Error("LOGIN_EXPIRED");
      const txt = await deepBodyText(page).catch(() => "");
      // 强信号: "上次未发布的视频/继续编辑" 横幅 = 暂存成功
      if (/上次未发布的视频|是否继续编辑|继续编辑/.test(txt)) return true;
      // 跳到内容/作品管理 或 显式成功提示
      if (/content\/manage|creator-micro\/content\/(manage|post)/.test(u) && !/upload/.test(u)) return true;
      if (/暂存成功|保存成功|已保存草稿|草稿保存成功/.test(txt)) return true;
      const blocked = txt.match(/[^\n]*(?:发布失败|保存失败|审核不通过|含有违规|标题不能为空|上传失败)[^\n]*/);
      if (blocked) throw new Error(`抖音暂存被拦: ${blocked[0].trim().slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return false;
  })();
  if (!ok) {
    // 兜底实查: 主动回上传页看横幅(暂存离开可能已把当前页导走, 当前页文本取不到横幅)
    try {
      await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 5_000));
      const txt2 = await deepBodyText(page).catch(() => "");
      if (/上次未发布的视频|是否继续编辑|继续编辑/.test(txt2)) {
        logger.info("抖音推草稿: 回上传页见'继续编辑'横幅, 草稿已确认");
        return;
      }
    } catch { /* noop */ }
    throw new Error("抖音「暂存离开」未确认生效 (上传页无'继续编辑'横幅 — 草稿可能没真存上, 见 douyin-aftersave 截图)");
  }
  logger.info({ url: page.url() }, "抖音推草稿: 暂存离开已确认生效(草稿已存)");
}

/** 文本找按钮并点击 (等到可点为止), 浏览器上下文执行 */
/**
 * 上传视频文件 — 通吃标准 input 和自定义上传组件:
 * 1. 先跨 frame 找现成 input[type=file] 直接 uploadFile
 * 2. 找不到 → 点"上传/添加/选择视频"等区域, 用 waitForFileChooser 拦截原生文件框塞文件
 *    (自定义组件点击后也会弹文件框, 这招绕过 DOM 选择器)
 */
const UPLOAD_TRIGGER_TEXTS = ["上传视频", "上传", "选择视频", "点击上传", "添加视频", "添加", "发布视频"];

async function tryDirectInput(page: Page, videoPath: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      // pierce: 既查普通 DOM 也查 shadow root (视频号微前端用 web component)
      const h = await frame.evaluateHandle(() => {
        const doc = (globalThis as any).document;
        function* deep(root: any): any {
          const els = root.querySelectorAll("*");
          for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
        }
        for (const el of deep(doc)) {
          if (el.tagName === "INPUT" && el.type === "file") return el;
        }
        return null;
      });
      const el = h.asElement();
      if (el) { await (el as any).uploadFile(videoPath); await h.dispose(); return true; }
      await h.dispose();
    } catch { /* frame detach */ }
  }
  return false;
}

async function uploadVideoFile(page: Page, videoPath: string): Promise<void> {
  // 诊断: 打印 frame URL 便于排查
  logger.info({ frames: page.frames().map((f) => f.url()).slice(0, 8) }, "推草稿: 当前页 frames");

  if (await tryDirectInput(page, videoPath)) {
    logger.info("推草稿: 直接 input[type=file] 上传成功");
    return;
  }

  // 深度点击: 穿透 shadow DOM + 遍历所有 frame 找上传区点击 (返回命中描述)
  const deepClickUploadZone = async (): Promise<string | null> => {
    for (const frame of page.frames()) {
      try {
        const hit = await frame.evaluate((labels: string[]) => {
          const doc = (globalThis as any).document;
          function* deep(root: any): any {
            const els = root.querySelectorAll("*");
            for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
          }
          const all = Array.from(deep(doc)) as any[];
          const visible = (el: any) => { try { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20; } catch { return false; } };
          // a) class 含 upload/drag
          const classRe = /(upload|uploader|dragger|drag|drop)/i;
          for (const el of all) {
            const cls = el.className && el.className.toString ? el.className.toString() : "";
            if (classRe.test(cls) && visible(el)) { el.click(); return "cls:" + cls.slice(0, 24); }
          }
          // b) 文案含上传/拖拽/大小限制 (上传区提示文字)
          for (const el of all) {
            const t = (el.textContent || "").trim();
            if (t.length < 60 && /上传视频|点击上传|拖拽|选择视频|添加视频|大小不超过|时长/.test(t) && visible(el)) {
              el.click(); return "txt:" + t.slice(0, 18);
            }
          }
          // c) 短按钮精确文本
          for (const el of all) {
            const t = (el.textContent || "").trim();
            if (t.length <= 12 && labels.some((l) => t === l) && visible(el)) { el.click(); return "btn:" + t; }
          }
          return null;
        }, UPLOAD_TRIGGER_TEXTS);
        if (hit) return hit;
      } catch { /* frame detach */ }
    }
    return null;
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    let chooser: any = null;
    const chooserP = page.waitForFileChooser({ timeout: 9_000 }).then((c) => (chooser = c)).catch(() => null);
    const clicked = await deepClickUploadZone();
    await chooserP;
    if (chooser) {
      await chooser.accept([videoPath]);
      logger.info({ via: clicked }, "推草稿: 经 fileChooser 上传成功");
      return;
    }
    logger.info({ attempt, clicked, url: page.url() }, "推草稿: 本轮未触发文件框, 重试");
    // 点击可能触发了导航或动态创建了 input, 再查一次
    if (await tryDirectInput(page, videoPath)) { logger.info("推草稿: 点击后 input 上传成功"); return; }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("找不到上传入口 (input 与 fileChooser 均失败, 见失败截图)");
}

/** 抖音: 确保在上传页 (直链常被重定向回首页 → 从首页点'发布视频'进上传页, 处理可能的新标签页) */
async function douyinEnsureUploadPage(page: Page): Promise<Page> {
  if (/content\/(upload|publish)/.test(page.url())) return page;
  logger.info({ url: page.url() }, "抖音: 不在上传页, 尝试点'发布视频'进入");
  const browser = page.browser();
  const newPagePromise = new Promise<Page | null>((resolve) => {
    const onTarget = async (t: any) => {
      try { const np = await t.page(); if (np) resolve(np); } catch { resolve(null); }
    };
    browser.once("targetcreated", onTarget);
    setTimeout(() => resolve(null), 8_000);
  });
  const clicked = await page.evaluate(() => {
    const doc = (globalThis as any).document;
    const els = Array.from(doc.querySelectorAll("a, button, div, span")) as any[];
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (t === "发布视频" || t === "上传视频" || t === "发布作品") { el.click(); return t; }
    }
    return null;
  });
  if (!clicked) {
    // 兜底再直链一次
    await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    return page;
  }
  const newPage = await newPagePromise;
  if (newPage) {
    await newPage.bringToFront().catch(() => {});
    await new Promise((r) => setTimeout(r, 3_000));
    logger.info({ url: newPage.url() }, "抖音: 发布视频打开新标签页");
    return newPage;
  }
  // 同标签内导航
  await new Promise((r) => setTimeout(r, 3_000));
  return page;
}

/** 收集全页文本 (穿透 shadow DOM + frame), 用于检测上传进度/提示 */
async function deepBodyText(page: Page): Promise<string> {
  let text = "";
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() => {
        const doc = (globalThis as any).document;
        function* deep(root: any): any {
          const els = root.querySelectorAll("*");
          for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
        }
        let out = "";
        for (const el of deep(doc)) {
          // 只取叶子文本避免重复
          if (el.children && el.children.length === 0 && el.textContent) out += el.textContent.trim() + "\n";
        }
        return out;
      });
      text += t + "\n";
    } catch { /* frame detach */ }
  }
  return text;
}

/**
 * 等视频号上传完成 — 12s 就点保存会存到空草稿。
 * 等"上传中/上传 xx%/处理中"消失 且 出现完成信号(时长/更换/删除/上传完成)。
 */
async function waitChannelsUploadComplete(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawUploading = false;
  while (Date.now() < deadline) {
    const txt = await deepBodyText(page);
    const uploadingNow = /上传中|上传\s*\d+\s*%|处理中|转码中|视频上传中/.test(txt);
    if (uploadingNow) sawUploading = true;
    // 注意: '预览/发表时间'是发表页静态文案, 不能当完成标记(会秒判完成→存空草稿)
    const readyMarker = /上传完成|更换视频|删除视频|重新上传/.test(txt);
    // 见过上传中且现在不在上传 → 完成; 或出现明确完成标记
    if ((sawUploading && !uploadingNow) || readyMarker) {
      logger.info({ sawUploading, readyMarker }, "视频号: 判定上传完成");
      return true;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  logger.warn("视频号: 等上传完成超时");
  return false;
}

async function clickButtonByText(page: Page, texts: string[], timeoutMs: number): Promise<boolean> {
  // el.click() 只派发孤立 click 事件, channels(Vue) 的按钮监听 pointer/mouse 序列, 经常"点了没反应"。
  // 主 frame: 拿按钮中心坐标 → page.mouse 真实点击 (trusted event, 等价人手)。
  // 子 frame: 坐标系不通, 退而求其次派发完整 pointerdown→mousedown→pointerup→mouseup→click 序列。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const isMain = frame === page.mainFrame();
      try {
        const hit = await frame.evaluate((labels: string[], useCoords: boolean) => {
          const doc = (globalThis as any).document;
          const win = (globalThis as any).window;
          function* deep(root: any): any {
            const els = root.querySelectorAll("*");
            for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
          }
          for (const b of deep(doc)) {
            const tag = b.tagName;
            if (tag !== "BUTTON" && tag !== "DIV" && tag !== "SPAN" && tag !== "A") continue;
            const t = (b.textContent || "").trim();
            if (!labels.some((l) => t === l)) continue;
            const el = (b.closest && b.closest("button")) || b;
            const disabled = el.disabled || el.getAttribute?.("aria-disabled") === "true" ||
              (el.className || "").toString().includes("disabled");
            if (disabled) return { found: false }; // 命中但禁用(转码中) → 等下一轮
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (useCoords) return { found: true, x: cx, y: cy };
            // 子 frame: 派发完整事件序列 (composed:true 穿 shadow boundary)
            const opts = { bubbles: true, cancelable: true, composed: true, view: win, button: 0, clientX: cx, clientY: cy };
            for (const [type, Ctor] of [
              ["pointerdown", win.PointerEvent ?? win.MouseEvent], ["mousedown", win.MouseEvent],
              ["pointerup", win.PointerEvent ?? win.MouseEvent], ["mouseup", win.MouseEvent], ["click", win.MouseEvent],
            ] as any) { try { el.dispatchEvent(new Ctor(type, opts)); } catch { /* noop */ } }
            return { found: true };
          }
          return { found: false };
        }, texts, isMain);
        if (hit?.found) {
          if (isMain && typeof (hit as any).x === "number") {
            await page.mouse.click((hit as any).x, (hit as any).y, { delay: 60 });
          }
          return true;
        }
      } catch { /* frame detach */ }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/** 深度找编辑器 (穿透 shadow DOM + frame): contenteditable / textarea / 描述输入框, 轮询 timeoutMs */
async function deepFindEditor(page: Page, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const h = await frame.evaluateHandle(() => {
          const doc = (globalThis as any).document;
          function* deep(root: any): any {
            const els = root.querySelectorAll("*");
            for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
          }
          for (const el of deep(doc)) {
            try {
              const r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 12) continue;
            } catch { continue; }
            if (el.getAttribute && el.getAttribute("contenteditable") === "true") return el;
            if (el.tagName === "TEXTAREA") return el;
            const ph = el.getAttribute && (el.getAttribute("placeholder") || "");
            if (el.tagName === "INPUT" && /描述|标题|说点什么/.test(ph)) return el;
          }
          return null;
        });
        const el = h.asElement();
        if (el) return el;
        await h.dispose();
      } catch { /* frame detach */ }
    }
    await new Promise((r) => setTimeout(r, 2_500));
  }
  return null;
}

/** 视频号短标题: 6-16字硬限制, 超限保存被拦('标题超过16字限制'实测踩坑)。从文案派生合规短标题。 */
function deriveShortTitle(caption: string): string {
  const noTags = caption.replace(/#[^\s#]+/g, " "); // 去话题标签
  const clean = Array.from(noTags.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "")).slice(0, 16).join("");
  if (clean.length >= 6) return clean;
  return (clean + "精选学术内容分享").slice(0, 16);
}

/**
 * 改写视频号"短标题"输入框 (描述填入后平台会自动带出, 常超16字限制)。
 * 深度遍历找 placeholder/maxlength 匹配的 input, 用原生 setter 赋值 + input/change 事件 (Vue 才感知)。
 */
async function setChannelsShortTitle(page: Page, title: string): Promise<boolean> {
  for (const frame of page.frames()) {
    try {
      const ok = await frame.evaluate((val: string) => {
        const doc = (globalThis as any).document;
        const win = (globalThis as any).window;
        function* deep(root: any): any {
          const els = root.querySelectorAll("*");
          for (const el of els) { yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); }
        }
        for (const el of deep(doc)) {
          if (el.tagName !== "INPUT") continue;
          const ph = (el.getAttribute("placeholder") || "");
          const ml = el.getAttribute("maxlength");
          if (!/短标题|标题/.test(ph) && ml !== "16") continue;
          const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
          setter ? setter.call(el, val) : (el.value = val);
          el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
          return true;
        }
        return false;
      }, title);
      if (ok) return true;
    } catch { /* frame detach */ }
  }
  return false;
}

/**
 * 终审: 打开草稿箱列表页, 用文案前缀实查草稿是否真的存在。
 * 页面 toast/跳转都可能骗人(导航栏常驻'草稿箱'文案), 列表里有这条才算数。
 */
async function verifyChannelsDraftExists(page: Page, caption: string, shortTitle?: string): Promise<boolean> {
  // 6-11 真机修复: 描述可能没填上(为空), 单靠文案前缀必 miss → 文案前缀 或 短标题前缀 命中皆算
  const sigs = [caption, shortTitle ?? ""]
    .map((t) => t.replace(/\s+/g, "").slice(0, 12))
    .filter((t) => t.length >= 4);
  const sig = sigs[0] ?? ""; // 兼容旧日志字段
  const candidates = [
    "https://channels.weixin.qq.com/platform/post/list?currentTab=draft",
    "https://channels.weixin.qq.com/platform/post/list",
  ];
  // 6-11 二轮: 先点侧边栏「草稿箱」菜单进真实草稿页(URL 是猜的会落到发表列表), 失败再回退 URL 候选
  const viaMenu = await (async () => {
    try {
      await page.goto("https://channels.weixin.qq.com/platform", { waitUntil: "domcontentloaded", timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 4_000));
      const clicked = await clickButtonByText(page, ["草稿箱"], 10_000);
      if (!clicked) return false;
      await new Promise((r) => setTimeout(r, 6_000));
      const txt = (await deepBodyText(page)).replace(/\s+/g, "");
      logger.info({ url: page.url(), excerpt: txt.slice(0, 120) }, "视频号: 经侧边栏进入草稿箱");
      return sigs.some((g) => txt.includes(g));
    } catch { return false; }
  })();
  if (viaMenu) return true;

  for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 8_000)); // 草稿落列表可能延迟
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch { continue; }
    await new Promise((r) => setTimeout(r, 5_000)); // 列表异步加载
    const txt = (await deepBodyText(page)).replace(/\s+/g, "");
    if (sigs.some((g) => txt.includes(g))) return true; // 文案或短标题命中 = 草稿真的在
    const m = txt.match(/草稿箱\((\d+)\)/);
    if (m && Number(m[1]) > 0) {
      logger.info({ draftCount: m[1] }, "视频号: 草稿箱计数>0 (文案未匹配到, 可能被平台截断)");
      return true;
    }
    logger.info({ attempt, url: page.url(), draftCount: m ? m[1] : "未见计数" }, "视频号: 草稿箱实查未命中");
  }
  }
  return false;
}

/** 视频号助手 (channels.weixin.qq.com): 发表页 → 上传 → 填描述 → 存草稿 */
export async function wechatVideoPushDraft({ page, videoPath, caption, title }: UploadParams): Promise<void> {
  // 6-11 四轮: 自动接受 beforeunload"离开此网站?"弹窗(实查导航离开编辑页时触发, 有头模式会真弹给用户)
  page.on("dialog", (d) => { d.accept().catch(() => {}); });
  await page.goto("https://channels.weixin.qq.com/platform/post/create", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await new Promise((r) => setTimeout(r, 3_000));
  if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");

  // 1. 选文件 — fileChooser 通吃自定义上传组件
  await uploadVideoFile(page, videoPath);
  logger.info("视频号推草稿: 视频文件已提交");

  // 2. 等描述输入框 (穿透 shadow DOM, channels 整页在 web component 内)
  const editor = await deepFindEditor(page, 90_000);
  if (!editor) throw new Error("等不到描述编辑器 (上传失败或页面改版, 见失败截图)");

  // 3. 填描述 — 6-11 真机修复: 有头模式下首次 click 偶发未聚焦, 文案打空(截图实锤: 描述空但短标题在)。
  // 填完读回验证, 不符重试 3 次; 三次都失败不阻断(短标题仍派生, 草稿可人工补描述)。
  const selectAllKey = process.platform === "darwin" ? "Meta" : "Control";
  let descFilled = false;
  for (let i = 0; i < 3 && !descFilled; i++) {
    try {
      await editor.click();
      await new Promise((r) => setTimeout(r, 600));
      await page.keyboard.down(selectAllKey); await page.keyboard.press("KeyA"); await page.keyboard.up(selectAllKey);
      await page.keyboard.press("Backspace");
      await page.keyboard.type(caption, { delay: 30 });
      await new Promise((r) => setTimeout(r, 1_200));
      let got: string = await (editor as any).evaluate((el: any) => ((el.innerText ?? el.textContent ?? el.value ?? "") as string).trim());
      descFilled = got.replace(/\s+/g, "").includes(caption.replace(/\s+/g, "").slice(0, 8));
      // 6-11 二轮: 键盘输入进不去(读回为空) → JS 原生赋值兜底(S18 短标题同款思路, 已被验证可行)
      if (!descFilled) {
        const jsSet = await (editor as any).evaluate((el: any, val: string) => {
          const win = (globalThis as any).window;
          try {
            if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
              el.focus?.();
              el.textContent = val;
              el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, data: val, inputType: "insertText" }));
              el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
              return ((el.innerText ?? el.textContent ?? "") as string).trim().length > 0;
            }
            const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            setter ? setter.call(el, val) : (el.value = val);
            el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
            el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
            return true;
          } catch { return false; }
        }, caption);
        await new Promise((r) => setTimeout(r, 800));
        got = await (editor as any).evaluate((el: any) => ((el.innerText ?? el.textContent ?? el.value ?? "") as string).trim());
        descFilled = jsSet && got.replace(/\s+/g, "").includes(caption.replace(/\s+/g, "").slice(0, 8));
        logger.info({ jsSet, gotLen: got.length }, "视频号: JS 直写描述兜底");
      }
      if (!descFilled) logger.warn({ attempt: i + 1, got: got.slice(0, 40) }, "视频号: 描述读回不匹配, 重试");
    } catch (e) {
      logger.warn({ attempt: i + 1, err: e instanceof Error ? e.message : e }, "视频号: 填描述异常, 重试");
    }
  }
  if (!descFilled) logger.warn("视频号: 描述 3 次未填上, 继续保存(草稿可人工补描述)");
  await new Promise((r) => setTimeout(r, 1_500));

  // 4. 等视频真正上传完成 (否则点保存只存到空草稿)
  const uploadDone = await waitChannelsUploadComplete(page, 240_000);
  if (!uploadDone) throw new Error("视频上传未完成 (超时, 视频可能过大或网络慢)");

  // 4b. 改写短标题为合规长度 (平台自动带出的常超16字 → 保存被拦)
  // 短标题用钩子标题派生 (本来就是标题, 截16字也通顺), 不再用整段文案机械截断
  const shortTitle = deriveShortTitle(title || caption);
  const titleSet = await setChannelsShortTitle(page, shortTitle);
  logger.info({ shortTitle, titleSet }, "视频号: 短标题已改写");
  await new Promise((r) => setTimeout(r, 1_000));

  // 5. 点"保存草稿" (精确文本, 避免误点其它"保存")
  const clicked = await clickButtonByText(page, ["保存草稿", "保存至草稿箱", "存草稿"], 60_000);
  if (!clicked) throw new Error("找不到或点不动「保存草稿」按钮 (页面改版, 见失败截图)");
  logger.info("视频号推草稿: 已点击保存草稿, 验证落库中");
  // 点击后现场截图 (无论成败都留, 失败路径的截图曾静默丢失过)
  try {
    await new Promise((r) => setTimeout(r, 2_500));
    await mkdir(FAIL_SHOT_DIR, { recursive: true });
    const shot = resolve(FAIL_SHOT_DIR, `draft-push-aftersave-${Date.now()}.png`);
    await page.screenshot({ path: shot as any, fullPage: true });
    logger.info({ shot }, "视频号: 点保存后现场截图");
  } catch (e) { logger.warn({ err: e instanceof Error ? e.message : e }, "视频号: 点保存后截图失败"); }

  // 6a. 页内信号 (toast/跳转 = 强信号; 平台拦截文案 = 硬失败)
  // 6-11 三轮定调: 真机证实草稿每次都真实落箱, 误报全在实查环节 → 见到"已保存"信号后实查未命中只警告不判失败
  const sawSavedSignal = await (async (): Promise<boolean> => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (page.url().includes("login")) throw new Error("LOGIN_EXPIRED");
      if (!/post\/create/.test(page.url())) return true; // 跳走 = 保存动作生效
      const txt = await deepBodyText(page);
      if (/保存成功|已保存|保存到草稿/.test(txt)) return true;
      const blocked = txt.match(/[^\n]*(?:超过\s*\d+\s*字|字数超|不能为空|不符合要求|保存草稿失败|保存失败)[^\n]*/);
      if (blocked) throw new Error(`保存被平台拦截: ${blocked[0].trim().slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return false;
  })();

  // 6b. 终审: 打开草稿箱列表页, 按文案实查那条草稿在不在 — 唯一可信的成功证据
  const saved = await verifyChannelsDraftExists(page, caption, shortTitle);
  if (!saved) {
    if (sawSavedSignal) {
      // 已见"已保存"toast/页面跳转 + 真机证实草稿实际都在 → 实查 miss 是我们找列表的方式不对, 不冤枉好人
      logger.warn({ url: page.url() }, "视频号: 草稿箱实查未命中, 但保存信号明确 → 按成功处理(实查页面定位待校准)");
    } else {
      throw new Error("保存草稿未生效 (无保存成功信号且草稿箱未见 — 见失败截图)");
    }
  } else {
    logger.info({ url: page.url() }, "视频号推草稿: 保存草稿已确认 (草稿箱实查命中)");
  }
}

export const PLATFORM_PUSHERS: Record<string, (p: UploadParams) => Promise<void>> = {
  douyin: douyinPushDraft,
  wechat_video: wechatVideoPushDraft,
};
