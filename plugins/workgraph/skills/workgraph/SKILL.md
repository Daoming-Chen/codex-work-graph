---
name: workgraph
description: 打开当前仓库的 WorkGraph 面板，查看分支合并历史、Worktree 状态和提交差异。适用于要求可视化本地 Git 状态的任务。
---

从当前任务取得仓库绝对路径；不要将插件安装目录当作仓库路径。调用插件的 `workgraph_open` 工具并传入 `repositoryPath`。

支持 MCP Apps 的宿主可以通过工具的 UI 资源展示面板。工具还会返回 `panelUrl`。如果侧边面板入口未显示，使用 Codex 的 `open_in_codex` 工具，以 `target.type: "browser"`、`target.url: panelUrl`、`placement: "right"` 打开。没有该工具时，将完整链接提供给用户。

若 MCP 工具尚未加载，可通过 Node.js 运行本技能目录下的 `../../dist/server.mjs --http --repo <仓库绝对路径>`，读取标准输出的完整链接并打开。保持服务进程运行；Windows 后台启动使用隐藏窗口。不要在标准输出中自行拼接访问令牌。

Agent 使用 `workgraph_open` 打开面板。用户要求初始化或更新工作记录时，分别遵循 `workgraph-init` 或 `workgraph-update` Skill，先调用 `workgraph_work_status` 检查是否运行中，再调用 `workgraph_work_analyze`，显式传入当前仓库绝对路径和对应模式。启动成功只表示任务已启动，不表示分析已完成。详情查询、偏好保存和 Git 操作工具仅供 App 调用，不应由 Agent 绕过面板调用。面板支持历史筛选、分页、逐文件审阅、两端点及工作目录比较，以及文件暂存与提交、分支与标签管理、远程同步、Merge／Rebase／Cherry-pick／Revert／Reset／Drop、Stash、指定文件丢弃或清理、冲突后的继续／中止，以及新分支新目录 Worktree 创建。

Git 写入在面板中经过检查和执行，删除及历史重写需确认具体目标和后果。打开面板本身不授权执行 Git 写入或远程推送。失败后核对实际状态；冲突应保留，用户处理内容后刷新，再标记解决并继续或中止。提交遵循本机 hooks 和签名配置，不绕过失败。

仓库偏好和审阅进度由面板保存到 Git common dir 的插件数据文件，跨 Worktree 共用，不修改 refs、index 或 Git config。服务重启或旧链接失效时，重新调用 `workgraph_open` 获取新链接；不要自动重试结果未知的写操作。远程操作使用现有本机 Git 认证；读取本地数据不要求 GitHub、GitLab 登录，不应因此修改认证配置。不提供普通强制推送、交互式 Rebase 编辑器或 Worktree 删除；Drop 仅处理单父线性历史。

浏览器入口仅监听运行插件的机器的 `127.0.0.1`。远程 SSH 或 WSL 任务的地址不一定能从桌面直接访问；先检查宿主是否支持 MCP Apps 面板，不能直接访问时说明限制，不公开仓库服务或创建公网隧道。
