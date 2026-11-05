# 安装与打包

## 准备环境

运行 skill 需要 Node.js 22+ 和 Git；从源码重新构建还需要 npm，插件接入另需 Codex 桌面应用。执行主机的 PATH 必须能找到 `node` 和 `git`。当前实测平台为 Windows；真实桌面宿主的插件安装、缓存目录加载和聊天切换流程仍需验证。

尚未配置插件时，可先按 [README](../README.md#开始使用)直接启动，检查面板是否能读取目标仓库。

## 独立 skill

独立 skill 需要 Node.js 22+ 和 Git，不要求配置 MCP 或安装 Codex 插件。当前以源码构建和目录分发为准，尚未提供预构建下载地址。

仓库的 `skills/workgraph/` 包含 `SKILL.md`、`references/` 和随包交付的 `scripts/`，可整体安装，运行时不需要源码、npm 或 node_modules。不要仅复制 SKILL.md。修改实现后，在源码目录运行 `npm install`、`npm run build` 重新生成并同步交付的运行文件；插件构建也复用这份完整 skill。

将整个 `skills/workgraph` 复制到 Agent 的技能目录：Codex 项目级为目标项目的 `.agents/skills/workgraph`，个人级为 `~/.agents/skills/workgraph`。存在同名目录时先核对并保留已有内容。需要独立分发时运行：

```powershell
node scripts/package-skill.mjs "D:\release\workgraph"
node "D:\release\workgraph\scripts\workgraph.mjs" doctor
```

输出目录必须尚不存在，且父目录已存在。打包目录可迁移到其他位置；安装后按 Agent 的技能发现机制重新加载，并要求「更新当前项目的工作地图」。首次建立与增量更新自动选择；要求「打开工作地图」只展示。独立页面不提供 Git 管理入口。

插件构建时复制同一份 skill，因此可以选择独立 skill 或插件安装方式，避免重复安装同名 skill。移除 skill 不会删除目标仓库的 `.workgraph/state.json`。本实现不修改用户全局配置，也不自动安装或更新技能。

## 从源码安装本地插件

频繁修改代码时，优先按[贡献指南的本地快速开发](../CONTRIBUTING.md#本地快速开发)直接连接源码；以下流程用于验证插件安装与分发。

以下操作在本仓库目录执行。配置文件存在时，合并条目并保留原有内容，不要整文件覆盖。

1. 安装依赖并构建：

   ```powershell
   npm install
   npm run build
   ```

2. 按下方源码示例布局，在本仓库的 `.agents/plugins/marketplace.json` 保存完整配置；目录不存在时先创建。已有配置时合并插件条目，保留其他内容。配置预期让 `./plugins/codex-work-graph` 指向仓库内插件目录；本地 marketplace 的发现与相对路径解析尚未在真实桌面宿主中实测。
3. 重启 Codex，在插件目录选择「WorkGraph · 本地开发」并安装。入口的实际显示取决于宿主版本。
4. 在目标仓库的聊天中输入「打开当前仓库的 WorkGraph，显示所有 Worktree」。插件的 `git_graph_open` 接受仓库绝对路径；统一 skill 使用独立 CLI 查看工作地图，Git 管理由插件入口提供。

源码示例布局：

```text
codex-work-graph/
├─ .agents/plugins/marketplace.json
└─ plugins/codex-work-graph/
   ├─ plugin.json
   ├─ mcp.json
   └─ dist/
```

本地源码配置与根目录的 `marketplace.example.json` 相同：

```json
{
  "name": "codex-work-graph-local",
  "interface": { "displayName": "WorkGraph · 本地开发" },
  "plugins": [
    {
      "name": "codex-work-graph",
      "source": { "source": "local", "path": "./plugins/codex-work-graph" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

支持 MCP Apps 的宿主可以显示原生面板；工具也会返回 `panelUrl`，可在 Codex 右侧浏览器打开。未出现入口或连接失败时，见[故障排查](troubleshooting.md)。

## 打包到其他目录或机器

先完成构建。以下示例要求 `D:\release` 已存在，`D:\release\codex-work-graph` 尚不存在；按实际路径修改。

```powershell
node scripts/package.mjs "D:\release\codex-work-graph"
```

脚本拒绝覆盖现有目录。输出包含根 `plugin.json`、根 `mcp.json`、`dist/`、技能和第三方声明；运行依赖已打包，目标主机不需要执行 `npm install`，但仍需 Node.js 22+ 和 Git。

将整个输出目录复制到目标机器，再按分发示例布局配置本地 marketplace：

```text
D:\release\
├─ .agents/plugins/marketplace.json
└─ codex-work-graph/
   ├─ plugin.json
   ├─ mcp.json
   └─ dist/
```

在 `D:\release\.agents\plugins\marketplace.json` 保存上方完整 JSON，并将 `source.path` 改为 `./codex-work-graph`。示例预期指向 `D:\release\codex-work-graph`，随后通过 Codex 的插件入口安装。

上述目录与路径是配置示例。本地 marketplace 如何被发现、相对路径如何解析，以及安装入口如何显示，均尚未在真实桌面宿主中实测。若宿主没有识别配置，先保留错误信息，并按[故障排查](troubleshooting.md)直接启动面板。

根 `mcp.json` 使用 `${PLUGIN_ROOT}/dist/server.mjs`，由宿主替换安装目录。构建生成的 `.mcp.json` 是含本机路径的旧版开发配置，不随分发包交付；不要把它当作可迁移配置。

## 安装验证范围

仓库有打包迁移、stdio 握手和服务关闭重开的自动化测试，测试位置见[贡献指南](../CONTRIBUTING.md)。这些测试不能代替真实桌面宿主验收。安装后仍需确认插件能加载、能打开正确仓库，并能在服务重启后重新打开面板。

## 更新、卸载与数据保留

从旧版 `codex-git-graph` 更新时，将 marketplace 名称改为 `codex-work-graph-local`，插件名称改为 `codex-work-graph`，源码路径改为 `./plugins/codex-work-graph`，完整配置见上方示例。插件安装标识已改变，需按宿主流程安装新插件并停用旧插件，避免重复入口。`git_graph_*` 工具、`GIT_GRAPH_*` 环境变量和配置存储名称保持兼容，已有仓库偏好与审阅记录继续使用。

从源码更新时，获取所需版本后重新运行 `npm install` 和 `npm run build`。构建会重写插件的 `dist/`、本机开发 `.mcp.json` 和第三方声明；已运行的服务需重新启动才能加载新代码。宿主安装缓存如何刷新、是否需要重新安装，尚未实测。

重新打包时使用新的输出目录。打包脚本不会覆盖旧包，也不会替宿主切换已安装版本；更新 marketplace 路径后，按实际宿主提供的安装流程操作。

构建与打包脚本不提供卸载功能。宿主中的卸载入口、缓存清理和异常恢复流程尚未验证，不能承诺卸载会清除哪些文件。

仓库配置和审阅记录保存在目标仓库的 Git 共用目录，布局偏好保存在浏览器，详见[使用指南](usage.md#设置与审阅进度)。构建和打包不负责清理这些数据；移除插件目录也不等于删除仓库数据。需要清理时，先备份并确认实际保存位置，不要删除整个 Git 共用目录。
