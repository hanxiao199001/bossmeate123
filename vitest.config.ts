import { defineConfig } from "vitest/config";

/**
 * 根 vitest 配置 —— 唯一目的: 把 `pnpm test` 的扫描范围锁在**本项目自己的代码**上。
 *
 * 7-25 交接前修: 此前仓库根没有任何 vitest.config.*, `vitest` 走默认 include
 *   (`** /*.{test,spec}.?(c|m)[jt]s?(x)`) + 默认 exclude(只排 node_modules/dist),
 *   于是会一路爬进两个"不该看的目录":
 *     - `worldmonitor/`  —— 误入本仓库的**无关第三方项目**(见 .gitignore 注释), 自带一整套测试与依赖
 *     - `.clean-main/`   —— 旧仓库副本(4 个 .test.ts), 只作历史留档
 *   实测结果: 文件句柄被这两坨吃光 → `EMFILE: too many open files` → 一个测试都跑不起来。
 *   接手人第一天敲 `pnpm test` 就会撞到, 且报错完全指不到真因。
 *
 * ⚠️ 维护须知:
 *   - 这里的 exclude 会**覆盖** vitest 的默认 exclude, 所以 node_modules/dist 必须自己写全。
 *   - packages/* 目前没有各自的 vitest.config; 若将来某个包要加, 加在包内即可,
 *     包内配置优先, 不需要动这个文件。
 *   - 新增"非本项目代码"目录(第三方仓库副本/备份/产物)时, 记得同步加进 exclude,
 *     否则 EMFILE 会再来一次。
 */
export default defineConfig({
  test: {
    exclude: [
      // ---- vitest 默认 exclude(覆盖后必须自己带上) ----
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",

      // ---- 本仓库特有: 不是我们的代码, 绝不要扫 ----
      "worldmonitor/**",   // 误入的第三方仓库(.gitignore 已忽略), 自带测试+依赖, 是 EMFILE 主因
      ".clean-main/**",    // 旧仓库副本(历史留档), 含 4 个 .test.ts
      ".review-stash/**",  // 评审暂存区
      ".gstack/**",

      // ---- 构建/打包产物 ----
      "**/build/**",
      "**/dist-client/**",
      "**/dist-portable-*/**",
      "packages/agent/.chromium-cache/**",

      // ---- 运行时数据落盘目录(语料/上传/lancedb, 文件数极多) ----
      "data/**",
      "packages/server/data/**",
      ".daily-reports/**",
    ],
  },
});
