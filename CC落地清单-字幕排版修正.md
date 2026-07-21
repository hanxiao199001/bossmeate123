# CC 落地清单 — 字幕排版修正（2026-07-02，老韩截图"字体太大"）

## 根因（沙箱复现实锤，非新代码引入）

老路径 env 参数本身就是坏的，新 ASS 路径忠实复刻了它：
1. **FontSize=36 在 288 坐标系 = 实际 240px/字**（4.5 字占满 1080 宽）。像素账：实际px = 值/288×视频高。
2. **MarginV=200 = 距底 69%**，字幕顶到画面中间。
3. **libass 0.15（ffmpeg 4.4）不给中文自动换行**，超宽行直接溢出画面两侧。
之前"60→36 调好"没在 1080×1920 成片上验证过。

## 修复内容（tsc 0 错，全部沙箱真烧帧肉眼验证）

| 项 | 改动 |
|---|---|
| 字号 | env 默认 36→**15**（≈100px，抖音正常，11字/行） |
| 位置 | MarginV 默认 200→**84**（距底 29%，避 UI 不压脸） |
| 左右边距 | ASS 生成器 30→8（原值在竖屏坐标系占两侧 36% 屏宽） |
| 中文强制换行 | 新 `wrapCjkLine`：超宽行优先中点±3 标点断、否则硬切中点（libass 不折 CJK 的保底） |
| 强调上限 | `DVH_SUBTITLE_EMPHASIS_MAX=2`（默认）：每条按信息量权重挑 2 处（小数/%数值 > 分区 > 纯数字 > 硬词），防满屏黄字 |
| 合并规则修正 | 无空格连排（"影响因子26.3中科院1区录用率65%"）原会链式合并成整行黄字；现数字/分区后遇硬词断开 |
| 切句长度 | subtitle-from-text MAX 16→10 字/条（与新字号单行对齐） |

改动文件：subtitle-emphasis.ts / video-postprocess.ts / subtitle-from-text.ts / config/env.ts / .env.example / __tests__/subtitle-emphasis.test.ts（更新断言+新增 cap/wrap 用例）

## CC 执行

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add packages/server/src/services/digital-human/subtitle-emphasis.ts \
        packages/server/src/services/digital-human/video-postprocess.ts \
        packages/server/src/services/digital-human/subtitle-from-text.ts \
        packages/server/src/config/env.ts .env.example \
        packages/server/src/__tests__/subtitle-emphasis.test.ts
git commit -m "fix(subtitle): 字幕排版重校准 — 根因=36@288坐标系实际240px/字+MarginV200顶到画面中间+libass不折CJK溢出(老韩截图). 字号36→15(≈100px) MarginV200→84(距底29%) 边距30→8 + wrapCjkLine强制换行保底 + 强调上限2处按权重挑(防满屏黄字) + 连排链式合并断开 + 切句16→10字"
git push && pnpm deploy:smart
npx vitest run packages/server/src/__tests__/subtitle-emphasis.test.ts   # 新增 cap/wrap 用例
```

**⚠️ 关键：查服务器 .env**——若显式设了 `DVH_SUBTITLE_FONT_SIZE`（旧 60/36）或 `DVH_SUBTITLE_MARGIN_V=200`，**删掉或改成 15/84**，否则 env 覆盖新默认、白修。改完重启 pm2。

## 验收

字幕烧在出片阶段，**存量视频不变，样片 #1 需重渲**。建议节奏：han 丢 3 首 BGM 进 data/bgm/{calm,upbeat,energetic}/ → 重渲一条（~8元）→ 四件套 + 新字幕排版一次看全（字号/位置/黄字≤2处/长句换行/BGM 呼吸感），这条就是验收样片 #1v2。
