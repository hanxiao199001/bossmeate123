# PathB · 剪映草稿生成(试验)

用 pyJianYingDraft 把「场景图 + 配音 + 字幕」生成一个剪映草稿工程,在剪映里手动导出,
用来对比"剪映级效果"的质量天花板。**这是逆向草稿格式的开源库,非官方 API**;
只当试验/手动精修工具,别绑进卖给客户的核心链路(详见项目备忘的抖音/剪辑策略)。

## 跑法(在你的 Mac 上)

```bash
pip3 install pyJianYingDraft            # 草稿生成 Mac 可用; 导出在剪映里手动点
# 1) 找到剪映草稿文件夹路径: 剪映 → 全局设置 → 草稿位置
# 2) 准备好本地的 场景图(png) + 配音(mp3) — 可从 sample:card 那次的 OSS 地址下载下来
# 3) 改 manifest.example.json 里的 draftsFolder / 各绝对路径 / 字幕
python3 draft_from_manifest.py manifest.example.json
# 4) 打开剪映 → 目录页找到「bossmate-sample」(可能要进退一次刷新)→ 检查时间轴 → 导出
```

## 已实测(沙盒 Linux 生成验证通过)
- 视频段(逐场景) + 渐显入场 + 段间叠化转场
- 字幕(打字机入场 + 自动换行,最大行宽 0.82)
- 配音音轨;create_draft(1080×1920,30fps)
- 输出有效 draft_content.json

## 注意
- 剪映 6+ 对草稿加密 → 模板模式受限;纯生成支持剪映5+。
- Mac 只支持"生成草稿",导出要在剪映里手动点(自动导出仅 Windows)。
- 字体/动画名是剪映自带枚举,想换风格在脚本里改 IntroType/TransitionType/TextIntro。
