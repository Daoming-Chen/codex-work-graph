# 贡献指南

## 开发环境

需要 Node.js 22+、npm 和 Git。在仓库目录执行：

```powershell
npm install
npm run build
npm run check
npm test
```

`check` 只做部分入口文件的语法检查，不能代替测试。测试在 `.test-output/` 创建和修改独立 fixture；受限环境可能阻止回环连接或 Git 子进程，应记录实际报错，并在允许这些操作的本地终端复查。

需要交互查看时，构建后运行：

```powershell
npm run demo
```

演示会在 `.test-output/` 创建独立仓库，不修改本项目历史。面板中的写操作会改变演示仓库。

## 本地快速开发

日常开发直接运行仓库源码；插件声明、技能和安装流程的验收使用[安装与打包](docs/install-lifecycle.md)中的完整安装流程。源码入口不会更新已安装的插件缓存。

### 本地面板预览

在仓库目录执行，`--repo` 指定面板要查看的仓库：

```powershell
npm run build
npm start -- --repo "D:\MyGithub\codex-git-graph"
```

打开终端输出的完整面板链接。源码目录可以沿用旧名称 `codex-git-graph`，插件名称为 `workgraph`。测试 Git 写操作时，优先使用上方的 `npm run demo` 创建独立演示仓库。

当前没有自动监听或热更新。修改界面后重新运行 `npm run build`；修改服务端后需要重启服务。为加载最新界面，构建后也应重启服务，并打开新输出的链接。旧链接可能失效。

### 在 Codex 中连接源码

1. 安装依赖并运行 `npm run build`，确保界面文件已生成。
2. 备份用户配置 `~/.codex/config.toml`。Windows 默认路径为 `C:\Users\<用户名>\.codex\config.toml`。
3. 将以下配置合并到文件中。将 `command` 改为本机 Node.js 22+ 的绝对路径，将 `args` 和 `cwd` 改为本机源码目录。已有 `work_graph_dev` 条目时修改原条目，避免重复定义。

   ```toml
   [mcp_servers.work_graph_dev]
   command = 'C:\Program Files\nodejs\node.exe'
   args = ['D:\MyGithub\codex-git-graph\src\server.mjs']
   cwd = 'D:\MyGithub\codex-git-graph'
   ```

4. 若已安装 WorkGraph 插件，开发期间停用该插件，避免同名工具重复出现。保留其他插件和 MCP 配置。
5. 保存配置后重启 Codex，在新聊天中明确要求「使用 work_graph_dev 打开当前仓库的 WorkGraph」，并提供目标仓库的绝对路径。确认工具来自 `work_graph_dev`，面板显示正确仓库。

这个 MCP 入口直接运行 `src/server.mjs`，界面读取仓库内构建生成的 `plugins/workgraph/dist/graph.html`。不要给 stdio MCP 入口添加 `--http`，也不要默认固定 `WORKGRAPH_REPO`，以便按聊天传入的路径打开不同仓库。配置字段见 [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers)。

修改服务端或重新构建界面后，需要让 Codex 重新连接 MCP 服务，再重新打开面板。如果宿主没有可用的重新连接入口，重启 Codex。源码连接的握手验证不能代替桌面面板和聊天切换验收。

需要恢复已安装插件时，先将 `[mcp_servers.work_graph_dev]` 下的 `enabled` 设为 `false`，再启用所需插件并重启 Codex。插件声明、技能、安装缓存和分发包的变化仍需通过完整安装流程验收。

## 修改与验证

保持改动范围清晰，说明解决的问题、行为变化和实际执行的验证。涉及 Git 写操作时，测试应覆盖目标校验、仓库状态变化、失败与冲突路径；不要用开发仓库验证破坏性操作。

插件打包逻辑的测试位于 `test/packaging.test.mjs`，上下文、面板生命周期和偏好存储测试分别位于对应的 `workspace-*`、`panel-manager`、`preferences` 测试文件。涉及这些行为时运行对应测试；真实桌面宿主行为需另行实测，不能由模拟宿主测试代替。

文档按读者任务分工：README 提供入口；安装、使用和故障排查解释用户操作；[架构说明](docs/current-implementation.md)记录内部边界。功能变化先更新负责该事实的文档，其他页面只保留简短说明和链接。

## 报告问题与提交改动

在 [GitHub Issues](https://github.com/Daoming-Chen/codex-work-graph/issues) 报告问题时，请提供版本或提交 SHA、操作系统、Node.js／Git／Codex 版本、启动方式、复现步骤，以及预期和实际结果。附上必要的错误信息或截图；分享前删除令牌、私有仓库地址和敏感文件内容。

提交改动的基本流程：

1. Fork 仓库并创建工作分支。
2. 完成修改，按影响范围更新文档。
3. 运行相关验证，在 PR 中说明执行结果和未验证范围。
4. 向本仓库提交 Pull Request，说明问题和修改后的行为。

仓库目前没有项目 LICENSE，项目许可证尚未确定。第三方声明不等同于项目授权，以上贡献流程也不构成使用或分发授权。

## 架构与维护原则

实现入口和安全约束见[架构与安全边界](docs/current-implementation.md)。

功能替换时同步删除废弃实现、测试、脚本和文档引用；不为已淘汰的原型或旧名称保留兼容层。设计决定更新到当前文档，历史截图和阶段性验收报告不提交到源码仓库。需要追溯时使用 Git 历史。
