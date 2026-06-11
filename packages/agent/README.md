# BossMate 本地发布 Agent

跑在**你自己电脑**(macOS / Windows)上的小工具:用本机的浏览器和家用网络,把 BossMate 生成的视频发到**视频号 / 抖音**。服务器只负责派单,扫码登录态全部留在你本机(`~/.bossmate-agent/profiles/`),不经过服务器。

**两个平台的自动化程度不同(平台差异,非工具能力):**
- **视频号 = 全自动**:Agent 自动上传 + 填描述 + 存草稿,直接进草稿箱,你到视频号助手后台点发布即可。
- **抖音 = 半自动**:抖音对网页端"发布"动作有短信验证(程序化点发布会被风控拦),所以 Agent 只自动到"填好标题/简介/话题 + 选『仅自己可见』 + 停在发布页",**最后由你在弹出的浏览器窗口点【发布】、过一次短信验证**(通常每设备一次)。发完关掉那个窗口即可。抖音全自动需等官方开放平台 API(企业认证 + 能力申请通过后)。

> 当前为命令行版;Electron 托盘壳(开机自启/图形界面)排在二期。

## 前置条件

- Node.js **20+**(推荐 22,与仓库 `engines` 一致):https://nodejs.org 下载 LTS 安装即可
- 本机能打开浏览器(Agent 会自动下载并驱动一个 Chrome)
- 能访问 BossMate 服务器地址(公司网/防火墙需放行)

## 安装与首次使用

### 1. 网页端生成配对码

登录 BossMate 网页 →「设置 → 本地发布 Agent」→ 点「生成配对码」。
得到一个 6 位数字配对码(**10 分钟有效、一次性**,过期重新生成)。

### 2. 构建

在仓库根目录:

```bash
pnpm install
pnpm --filter @bossmate/agent... build
```

构建产物在 `packages/agent/dist/`,命令入口 `dist/cli.js`(bin 名 `bossmate-agent`)。
下文命令可用 `node packages/agent/dist/cli.js <命令>`,或 `pnpm --filter @bossmate/agent exec bossmate-agent <命令>`。

### 3. 配对

```bash
node packages/agent/dist/cli.js pair https://你的服务器地址 123456
```

成功后 token 等配置写入 `~/.bossmate-agent/config.json`(token 明文只下发这一次,删了只能重新配对)。

### 4. 扫码登录平台账号

```bash
node packages/agent/dist/cli.js login        # 列出账号,输序号选择
node packages/agent/dist/cli.js login --all  # 全部账号依次扫码
```

每个账号会弹出一个浏览器窗口,用**该账号绑定的手机 App**(抖音 / 微信)扫码。登录成功后窗口自动关闭,登录态持久化在本机 `~/.bossmate-agent/profiles/<账号ID>/`。

### 5. 挂着跑

```bash
node packages/agent/dist/cli.js run
```

每 15 秒向服务器领一个任务:打开对应账号浏览器 → 下载视频 → 自动传到平台草稿箱 → 回报结果。**保持这个终端窗口开着、电脑不休眠**即可。网页端派单后稍等片刻就能在平台后台草稿箱看到视频,人工确认后发布。

随时 `Ctrl+C` 退出(会先做完手头任务;再按一次立即退出)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pair <服务器> <配对码> [设备名]` | 配对(设备名缺省取本机名) |
| `login [--all]` | 扫码登录账号 |
| `status [--fast]` | 服务器连通 + 各账号登录态体检(`--fast` 只看本地档案不开浏览器) |
| `run` | 主循环领任务执行(视频号自动完成;抖音填好后停在发布页等你点发布,该窗口不会自动关) |

## 常见问题

**Q: 任务一直报 login_expired / run 时大字提醒登录失效?**
平台把本机登录态踢了(常见于久未使用、平台风控、修改密码)。重新 `bossmate-agent login` 扫对应账号即可,任务会被服务器重新派发。

**Q: 电脑休眠/合盖后任务不跑?**
Agent 是前台进程,休眠即暂停。挂机期间请关闭自动休眠(macOS: 系统设置 → 电池/能源;Windows: 电源和睡眠设置),或仅在需要发视频的时段开着。

**Q: 配对/领任务报网络错误?**
检查服务器地址是否带 `https://`、公司防火墙是否放行该域名 443 端口;`bossmate-agent status` 可快速验证连通。配对码过期(10 分钟)需在网页端重新生成。

**Q: 推送中途弹出的浏览器窗口能不能动?**
不要动。任务执行时 Agent 在驱动那个窗口,手动点击/关闭会导致任务失败(失败会自动截图到 `~/.bossmate-agent/screenshots/` 便于排查)。

**Q: 想换电脑 / 重置?**
新电脑重新 `pair`(旧设备可在网页端吊销)。删除 `~/.bossmate-agent/` 即完全重置(登录档案也会清掉,需重新扫码)。

## 目录约定

```
~/.bossmate-agent/
├── config.json        配对配置 (服务器地址/token/设备ID)
├── profiles/<账号ID>/  每账号浏览器登录档案 (登录态只在本机)
├── tmp/               任务视频临时下载 (用完即删)
└── screenshots/       推送失败/留证截图
```

## 与服务端的对应关系

- 接口契约: `packages/server/src/routes/agent.ts`(`/api/v1/agent/*`,鉴权头 `x-agent-token`)
- 推草稿选择器逻辑: `src/pushers.ts` **整段移植自** `packages/server/src/services/publisher/draft-push.ts`,服务器侧改了要同步这里
