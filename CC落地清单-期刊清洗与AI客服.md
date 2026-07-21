# CC 落地执行清单 — 期刊清洗 + 企微 AI 客服（2026-07-02）

> 代码已全部写完并验证：server `tsc --noEmit` exit 0，web `tsc -b` exit 0。桌面 git 有锁（index.lock 删不掉），**提交由 CC 完成**。

## 0. 提交

```bash
cd /home/projects/bossmate && rm -f .git/*.lock
git add packages/server/src/scripts/journals-health-check.ts \
        packages/server/src/scripts/journals-reenrich.ts \
        packages/server/src/scripts/journals-schedule-refresh.ts \
        packages/server/package.json
git commit -m "feat(journals): 数据清洗三件套 — health-check体检报告 / reenrich批量再富化(限速+熔断+diff留痕) / schedule-refresh周补刀(BullMQ幂等入队)"

git add packages/server/src/services/work-wechat/kf-client.ts \
        packages/server/src/services/work-wechat/kf-responder.ts \
        packages/server/src/routes/work-wechat-kf.ts \
        packages/server/src/routes/work-wechat-callback.ts \
        packages/server/src/services/work-wechat/inbound-parser.ts \
        packages/server/src/models/schema.ts \
        packages/server/src/models/migrations.ts \
        packages/server/src/index.ts \
        apps/web/src/pages/KfServicePage.tsx \
        apps/web/src/App.tsx \
        apps/web/src/components/layout/Sidebar.tsx \
        apps/web/src/components/ui/Icons.tsx
git commit -m "feat(kf): 企微微信客服AI客服 — 混合模式(期刊库实时查数/FAQ RAG自动答, 拿不准转人工). kf-client(token缓存/sync_msg游标/send_msg/转接) + kf-responder(意图分类+红线禁编数) + migration 021(4表) + admin API + web管理页. 修inbound-parser真bug(kf事件无FromUserName被误throw)"
git push
```

## 1. 部署

正常发版（前端要重新 build）。启动时 migration runner 自动跑 `021_work_wechat_kf`。**无新依赖、无新 env**。

沙箱跑不了 vite build（缺 linux 原生二进制），CC 在 mac/服务器补跑：
```bash
pnpm --filter @bossmate/web build
npx vitest run src/__tests__/work-wechat-callback.test.ts   # 回调改动回归
```

## 2. 线 A：期刊清洗执行序列（部署后在服务器跑）

```bash
cd /home/projects/bossmate/packages/server && set -a && source ../../.env && set +a
npx tsx src/scripts/journals-health-check.ts        # ① 体检，出 journals-health-report.md（top50 脏刊）
npx tsx src/scripts/journals-reenrich.ts --dry-run --limit 20   # ② 看将处理哪些
npx tsx src/scripts/journals-reenrich.ts --limit 20             # ③ 小批量试跑，盯 diff 和 LetPub 熔断
npx tsx src/scripts/journals-health-check.ts        # ④ 复检
npx tsx src/scripts/journals-reenrich.ts --limit 200            # ⑤ 放量（幂等，可反复跑）
```

要点：
- 已有调度别重复建：scheduler.ts 每日 03:00 有 journal-trust-reverify（≤100本/日）、每月 1 日有 pool 刷新。新脚本 `journals:schedule-refresh` 是"专攻 confidence<60 脏刊的周补刀"，**建议方案 A：先不挂 cron**，观察 daily reverify 两周够不够；要挂就 `30 4 * * 1`（错开 03:00/04:00）。
- LetPub 熔断（5 连败 abort）可能被"本来就查不到的国内刊"误触发——看 journals-reenrich-log.jsonl 区分；国内刊可 `ENRICH_SKIP_LETPUB=true` 跑。
- ai_fabricated 期刊的删除**必须走护栏三步**（dry-run count → 查引用 → han 拍板），脚本不自动删。

## 3. 线 B：企微配置（han + CC 配合）

1. **han 在企微管理后台**：
   - 开通「微信客服」，创建客服账号；「开发配置」拿 **kf Secret**
   - 回调地址：`https://<域名>/api/v1/work-wechat/callback`，配 Token + EncodingAESKey（43 位）——URL 验证走现有 GET handshake
   - 服务器出口 IP 加「可信 IP」（否则 gettoken 报 60020）；记下 corpId
2. **写配置**（owner/admin 登录后）：
   ```
   PUT /api/v1/admin/work-wechat/config
   { "corpId": "...", "agentId": "...", "token": "...", "encodingAesKey": "...", "kfSecret": "..." }
   ```
3. **录 FAQ**：web「AI 客服 → FAQ 管理」先录 5-10 条（服务介绍/报价话术/常见问题）。FAQ 为空时 service_faq 一律转人工。
4. **联调冒烟**（微信里给客服账号发消息）：
   - 问期刊：「Cancer Cell 影响因子多少」→ 应返回库里真实数据，缺的字段说"暂无数据"
   - 问服务：FAQ 覆盖的问题 → 自动答；覆盖不了 → 转人工
   - 发投诉/砍价 → 「已转人工」+ 会话在管理页标红
   - 管理页切 manual → AI 静默，人工回复能发出

## 4. 已知限制（v1）

- 单租户（配置 LIMIT 1），多租户要按 openKfid 反查
- 只处理 text 消息；企微端接待人员的回复不回流到 kf_messages
- 48h/5 条限制触发时消息"已记录未送达"（前端有提示）
- handoff 通知运营 = 日志 + 会话标红（仓库无现成 notify 机制，扩展点在 kf-responder 的 handoffToHuman）
- 意图分类靠 LLM JSON，解析失败一律转人工（宁转不瞎答）；每条消息 2 次 LLM 调用（Qwen-Plus）
