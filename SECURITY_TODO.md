# SECURITY TODO(安全遗留事项)

> 创建于 2026-08-28 治理分支。本文件不复述任何具体 IP / 密钥,只记录待办。

## 1. 曾公开暴露的内容(已在工作区处理,但仍存在于 git 历史)

- 文档(CLAUDE.md / AGENTS.md / 腾讯云迁移阿里云操作手册.md / docs/ 下若干)中曾
  明文出现:生产与旧服务器公网 IP、服务器部署绝对路径、JWT 自签验证操作流程。
  当前版本已替换为 `<SERVER_IP>` / `<OLD_SERVER_IP>` / `<DEPLOY_PATH>` 等占位符。
- 根目录曾长期存放内部办公文档(V5 升级实施方案 docx、项目介绍 pptx、
  两份开发计划 xlsx),已移至 `docs/internal/`。这些文件曾随公开仓库分发,
  若其中含报价、客户名单、账号或架构敏感信息,应视为已泄露。

## 2. 建议动作(按优先级)

1. 服务器侧止损(与仓库无关,最优先):
   - 轮换生产服务器 `.env` 中的 `JWT_SECRET` 及所有云厂商 AK/SK;
   - 检查服务器安全组,收紧 SSH 来源 IP;确认旧腾讯云机器已彻底下线。
2. 若确认上述内容敏感,用 git filter-repo 从历史中清除(会改写全部 commit hash,
   需团队协调,操作前全量备份):

   ```bash
   pip install git-filter-repo
   git clone --mirror <repo-url> repo-mirror && cd repo-mirror

   # 清除整个文件(按历史中的原路径,含移动前的根目录路径)
   git filter-repo \
     --invert-paths \
     --path 'BossMate-V5升级实施方案.docx' \
     --path 'BossMate-项目介绍.pptx' \
     --path 'BossMate全项目开发计划.xlsx' \
     --path 'BossMate项目开发计划表.xlsx'

   # 清除文本中的敏感串(replacements.txt 每行: 敏感串==>占位符, 该文件不要提交)
   git filter-repo --replace-text replacements.txt

   git push --force --mirror <repo-url>
   # 之后所有协作者必须重新 clone;并在 GitHub 支持页申请清除悬挂对象缓存
   ```

3. `scripts/deploy-with-fallback.sh` 的默认服务器地址仍硬编码在脚本中
   (可用环境变量 `BOSSMATE_DEPLOY_SERVER` 覆盖)。建议改为无默认值、
   由部署者本地 env 提供;apps/packages 内少量脚本/文档同样引用了服务器地址,
   本次治理未触碰业务代码,需另行排查。
4. 未来内部文档不再入库:`.gitignore` 已忽略 `docs/internal/`,新文件请走
   网盘/内部知识库。
