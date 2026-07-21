# CC 落地清单 — 草稿箱饿死修复（2026-07-13）

## 问题
每个公众号收到 0 篇草稿。根因：草稿分发只从 `status='generated'`（已过质检/人工采用）取可发池，但所有文章卡在 `needs_review`（六维 65-71 未到 80）→ 可发池空 → 0 篇推送。这是"质检标尺 vs 内容真实水位"悬案的连锁后果。

## 修法（设计层想通，非降标准）
**草稿箱本身就是运营人工筛选台**——推进公众号草稿箱后运营还要手动挑、手动发（非自动群发）。所以"质检没过但不危险"的文章应带分数流进草稿箱让运营挑，质检门不该在草稿箱前二次拦死（那是双重拦截、把人工筛选台饿死）。

`draft-distributor.ts` 可发池条件改为：
- 纳入 `status='generated'`（已过/人工采用）**+** `status='needs_review'` 里的**质量类**（六维偏低）
- **仍剔除**（读 `metadata.needsReviewReason`）：`title_data_fabricated`（标题数据造假）、`title_body_inconsistent`（标题正文矛盾）、`sixdim_degraded`（评分降级=分数不可信，该重评不该进箱）——信任事故与不可信分永远留人工

改动文件：`packages/server/src/services/publisher/draft-distributor.ts`（单文件，tsc 零错误）

## 提交 + 部署（桌面提交流）

```bash
cd ~/Desktop/02_AI项目与产品/【007】bossmate/bossmate-project
git add packages/server/src/services/publisher/draft-distributor.ts
git commit -m "fix(draft): 修草稿箱饿死 — 可发池纳入'六维偏低非红线'的needs_review文章(草稿箱=运营人工筛选台,质检门不该二次拦死), 仍剔除标题造假/标题正文矛盾/评分降级三类留人工"
git push && pnpm deploy:smart
```

## 验证
1. 部署后手动触发一轮：`POST /api/v1/admin/draft-distribute`（JWT 自签），看返回 perAccount 明细——现在应有文章推给各号
2. 登对应公众号后台草稿箱，确认草稿在、封面在
3. 抽查：推进草稿箱的文章都不是红线类（metadata.needsReviewReason 不含 fabricated/inconsistent/degraded）
4. 前端矩阵总览「草稿待选」数应 > 0

## 说明（给老韩）
- 这不是"放松质检"。质检分照打、待审列表照旧，只是**草稿箱这道人工筛选台不再被质检门二次拦死**——运营在公众号后台看到候选（带六维分参考）自己挑，红线危险文仍进不了草稿箱。
- 根治仍需**质检标尺校准**（老韩人工采用/驳回攒样本→定线，之前欠的悬案）。本修复是止血：先让内容流到运营手上、别让分发链空转。校准完成后可再收紧草稿箱入池标准。
