# CC 落地清单 — 混剪提质四件套（2026-07-02）

> 片头钩子卡（期刊封面背景+大标题两行+fade in）/ 字幕关键词强调（数字/分区/IF 黄色加粗放大）/ BGM ducking（人声出 BGM 自动压低，~11dB 呼吸感）/ B-roll 中段插层（图表/封面 overlay，不切主轴口型安全）。
> tsc exit 0；**ffmpeg 滤镜图已在与生产同版本（4.4.2）真跑验证**：增强全量出片、B-roll PSNR 确认生效、ducking 电平实测、ASS 真烧成功、降级路径通过。

## 0. 提交（桌面 git 有锁，CC 先清）

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add packages/server/src/services/digital-human/subtitle-emphasis.ts \
        packages/server/src/services/digital-human/remix-assets.ts \
        packages/server/src/__tests__/subtitle-emphasis.test.ts \
        packages/server/src/services/digital-human/video-remix.ts \
        packages/server/src/services/digital-human/video-postprocess.ts \
        packages/server/src/routes/admin.ts \
        packages/server/src/scripts/sample-dvh-video.ts \
        packages/server/src/config/env.ts .env.example
git commit -m "feat(remix): 混剪提质四件套 — ①片头钩子卡(期刊封面背景+w/14大标题两行+fadein) ②字幕关键词强调(SRT→ASS内联标签, 数字/分区/IF黄色加粗x1.35, env DVH_SUBTITLE_EMPHASIS 默认开) ③BGM ducking(sidechaincompress, 人声压BGM~11dB呼吸感, ffmpeg4.4需显式aformat已注释) ④B-roll中段插层(overlay不切主轴口型安全, 图表/封面25%-80%区间seed抖动, chart-renderer复用). 全链路失败自动降级老图"
git push
```

## 1. 部署 + 测试

```bash
pnpm deploy:smart   # + 3 项 verify（mtime/字面/health）
# 服务器跑新单测（沙箱跑不了 vitest）:
cd /home/projects/bossmate/packages/server && npx vitest run src/__tests__/subtitle-emphasis.test.ts
# 顺带回归 pr252/pr253/pr-f 那几条 grep 防回归测试
```

`.env` 不用改（DVH_SUBTITLE_EMPHASIS 默认 true）。

## 2. 冒烟

1. 挑一条**有 journalId** 的文章产出的 DVH 视频，`POST /api/v1/admin/videos/:id/remix`（JWT 自签模式）
2. 看日志三处：`dvh.remix_assets.resolved`（cover/brolls 命中数）→ `dvh.remix.start`（introBg/brolls/ducking 字段）→ `dvh.remix.done`
3. 成片肉眼核对：封面片头+两行大标题、中段 2-3 次图表插层带平移、BGM 人声处压低停顿处浮起
4. **字幕强调要新出片才见效**（烧在 DVH 后处理阶段）：新触发一条 article→video，日志无 `dvh.postprocess.emphasis_*_fallback` 即走的 ASS 新路径

## 3. 异常与回退

- 增强观感异常 → 看 `dvh.remix.enhanced_failed_downgrade`（已自动降级老图，不阻塞）
- 字幕强调翻车 → `.env` 置 `DVH_SUBTITLE_EMPHASIS=false` 重启 pm2，一键回老路径
- 素材解析失败只 warn，混剪照跑（回到纯色片头/无 B-roll）

## 4. 已知限制

- 耗时 +25~40%（90s 竖屏片 ~2min → ~2.5-3min），仍在 5min 超时护栏内；降级重跑最坏双倍
- 图表 B-roll 依赖 journals jsonb 填充率（国际刊 ~91%；国内刊低 → 自动回退无素材混剪）——期刊清洗线在补的正是这个
- ducking 参数（0.30/0.02/10/20/400）首版手感值，写死未 env 化，上线听感后可调
- 封面可能既当片头又顶一张 B-roll（图表不足时），轻微重复曝光

## 5. 验收（老韩按评分表打分）

出 3 条样片对照《内容质量评分标准》数字人视频维度打分——这四件正好打"混剪节奏 15% + 配音 20%（BGM 呼吸感）+ 字幕 + 片头钩子"。目标：混剪相关维度 ≥8，总分冲 80。低于 8 的维度报回来单点修（下一批候选：卡点转场、数字人画中画）。
