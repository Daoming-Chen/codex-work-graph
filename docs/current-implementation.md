# 架构与安全边界

本文说明当前源码的职责与边界。用户操作见[使用指南](usage.md)，安装见[安装与打包](install-lifecycle.md)。验证结论以当前提交的实际测试结果为准。

## 模块职责

| 入口 | 职责 |
| --- | --- |
| `src/server.mjs`、`src/http.mjs` | MCP／HTTP 传输，共用面板资源 |
| `src/git.mjs`、`src/graph.mjs` | Git 查询、NUL 解析、有界 diff、拓扑与 WIP 布局 |
| `src/actions.mjs` | 文件清单、逐文件 diff、prepare/execute 与状态校验 |
| `src/remote-actions.mjs`、`src/history-actions.mjs` | 远程引用、历史和工作区写操作校验 |
| `src/review.mjs` | 元数据、历史／工作目录比较、文件内容 |
| `src/work-graph.mjs`、`src/ui/work-live.js` | 工作记录读取、提交归属、工作轨道和实际差异展示 |
| `src/work-analysis.mjs`、`src/work-context.mjs` | 有界分析材料、只读 Codex 调用、增量合并、自动维护与阶段计时 |
| `src/preferences.mjs` | 仓库配置与审阅进度持久化 |
| `src/workspace-context.mjs`、`src/codex-context.mjs`、`src/ui/workspace.js` | 本机聊天／项目与 MCP roots 解析、仓库切换与旧请求失效 |
| `src/panel-manager.mjs` | HTTP 服务复用、容量与空闲回收 |
| `src/ui/` | HTTP／MCP 共用面板，筛选、审阅和操作表单 |
| `test/` | 使用真实 Git 的 fixture、通信和压力测试 |

## 仓库上下文与请求隔离

MCP 模式优先使用显式 `repositoryPath`，无效时直接报错。没有显式路径时，先尝试本机 Codex 适配：按每次请求 `_meta.thread_id`／`threadId` 精确读取聊天工作目录。聊天索引采用 `CODEX_HOME`（默认 `~/.codex`）下版本号最高的 `state_*.sqlite`，只读查询 `id` 对应的 `cwd` 和 `thread_source`，不读取聊天正文，不使用进程环境中的聊天 ID。

新建聊天的固定入口可能使用未持久化的临时传输会话；查不到聊天记录或记录标记为 `mcp_extension_host` 时，读取 `.codex-global-state.json` 的 `selected-project`，只接受本地项目对应的 `local-projects.rootPaths`。不使用旧的 `active-workspace-roots` 或最近访问记录猜测。路径须经 Git 校验；当前聊天路径无效、索引不可读或项目含多个仓库时不转到其他仓库。

该适配依据桌面宿主 26.1021 的本机实现，使用非标准字段和本地存储格式；读取 SQLite 需要支持 `node:sqlite` 的 Node.js。选中项目记录为宿主共享状态，尚未验证多个窗口各自处于不同项目时的新建聊天入口。已有聊天始终优先使用其精确工作目录，不被全局项目选择覆盖。

没有本机适配信息时，读取宿主支持的标准 MCP roots：只接受可解析为本地 Git 仓库的 `file:` URI，并对仓库路径去重。唯一候选自动绑定；多个候选、非空 roots 无可用仓库、读取失败或 roots 超过 32 项时提示选择，不回退到环境变量。

宿主不支持 roots 或返回空列表时，才尝试 `WORKGRAPH_REPO`。MCP 模式不会用进程当前目录猜测仓库。直接 HTTP 模式的路径顺序见[故障排查](troubleshooting.md#打开的仓库不对或要求选择仓库)。

MCP Apps 面板在连接、宿主上下文变化、重新聚焦时检查上下文，前台每 5 秒串行检查一次，不定时重读同一仓库的 Git 历史。显式路径或手动选择不会被首次上下文查询立即覆盖，后续宿主上下文变化才触发重新绑定或选择。

切换时中止旧 HTTP 请求、丢弃旧 MCP 响应，并清空操作状态；A → B → A 也不能让旧请求恢复界面或触发后续执行。服务端已开始的 Git 操作不能靠切换撤销。

## HTTP 与 MCP 权限边界

HTTP 服务绑定单个仓库，只监听 `127.0.0.1`，API 要求随机 Bearer 令牌并校验 Host／Origin，不开放 CORS。GET 只查询，写入使用 POST JSON。

模型使用 `workgraph_open` 打开面板，使用 `workgraph_work_status` 查询分析状态，并在用户要求初始化或更新时通过 `workgraph_work_analyze` 启动分析；上下文、详情、偏好和 Git 操作接口声明为仅供 App 使用。工具可见性由宿主执行，不是额外的仓库授权隔离，MCP 仍继承进程文件权限。

## Git 写入

Git 写入经过 prepare/execute：绑定已审阅状态与文件内容指纹，执行前重新校验，准备结果两分钟过期，按 Git common dir 在本进程内串行执行。删除、丢弃、Reset、Rebase 和 Drop 在准备阶段要求明确确认。文件操作绑定所属 Worktree 与已审阅版本，Stash 操作绑定提交 SHA 与列表状态；远程分支删除绑定最近获取的 SHA。

operationId 去重只在本进程内有效，重启或其他服务进程不共享记录。多次 Git 查询不是原子事务，外部进程仍可能在复核后修改仓库。失败保留输入；超时标记结果未知并读取实际 HEAD，不自动重试或清理残留目录。

Git 使用参数数组和 literal pathspec；目标 Worktree 校验 common dir，文件必须来自返回清单。未跟踪文件不读取符号链接目标内容，普通文件指纹流式计算，预览限制读取量。错误脱敏覆盖常见 URL userinfo、GitHub token 及 token/password/authorization/secret 字段，不能保证遮盖任意 hook 输出。

## 偏好存储

用户可见的保存位置和保留期限见[使用指南](usage.md#设置与审阅进度)。偏好写入独立于 Git prepare/execute，不修改 refs、index、Git config 或工作文件。

仓库状态文件限 1 MiB，拒绝符号链接、无效 JSON、未知字段和超限数据，不静默覆盖无效文件。写入使用临时文件替换，按 common dir 在本进程内排队，多进程不共享队列。配置导入上限为 64 KiB。浏览器布局使用 `localStorage` 键 `workgraph-layout-v3`，不属于仓库配置导出内容。

## 服务生命周期与性能

每个 MCP 进程最多保留 10 个 HTTP 仓库服务，达到上限时回收最近最少使用且没有请求执行的服务；30 分钟无认证 API 请求的服务也会回收。全部忙碌时拒绝新增并提示稍后重试。MCP 连接关闭、标准输入结束或收到 SIGINT／SIGTERM 时关闭所有监听器；异常进程是否由宿主重启取决于宿主。

历史查询单次上限 2000 条，可用 offset 分页继续读取。界面渲染所有已加载行，尚无虚拟列表，大量续载会增加查询和渲染开销。

没有代理运行状态或 PR／CI 状态联动。Issue／PR／MR URL 模板只打开页面或创建表单，不提交表单。宿主端到端安装、聊天切换、异常进程恢复、SSH／WSL 与跨主机访问仍需实际环境验证。

## 工作进展读取

`src/work-graph.mjs` 优先读取仓库 `.workgraph/state.json`，兼容旧 `.workgraph.json`，并读取 HEAD 最近 300 条提交，按完整 SHA 或 `Work-Item` 标识关联工作。HTTP `/api/work_graph` 与 App 工具 `workgraph_work_graph` 共用读取逻辑。`src/ui/work-live.js` 使用现有仓库请求隔离，切换时清空记录并丢弃旧响应。工作项状态来自记录，验证和用户接受不由提交推断；范围与限制见 [WorkGraph 使用说明](work-graph.md)。

`src/work-analysis.mjs` 加载插件内置初始化／更新 Skill，将 `src/work-context.mjs` 预收集的有界材料交给本机 Codex 只读分析。初始化成功后按代码指纹检测变化并调度增量分析，结果校验后原子保存，跨进程锁避免同一工作区并发分析。面板显示实际阶段与耗时，运行目录保留最近一次计时摘要。状态轮询与定时检测共享检查间隔和正在执行的扫描，避免每次查询重复计算指纹。自动维护仅在本地服务运行期间执行，没有接入聊天结束事件。材料边界、具体时序、重试和存储约束见 [WorkGraph 使用说明](work-graph.md)。
