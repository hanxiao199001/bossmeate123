/**
 * puppeteer-extra / stealth 插件的宽松模块声明。
 *
 * 为什么需要: monorepo 根 node_modules 只 hoist 了 puppeteer 本体,
 * 本包未跑 pnpm install 时 tsc 解析不到 puppeteer-extra 的类型 (TS2307)。
 * 运行时按 server browser-session.ts 同款 CJS interop unwrap (.default ?? 自身),
 * 代码里全是 any 调用, 这里声明成 any 不损失任何类型安全。
 */
declare module "puppeteer-extra" {
  const puppeteerExtra: any;
  export default puppeteerExtra;
}

declare module "puppeteer-extra-plugin-stealth" {
  const stealthPlugin: any;
  export default stealthPlugin;
}
