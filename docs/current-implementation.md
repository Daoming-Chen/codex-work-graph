# 架构与安全边界

本文说明当前源码的职责与边界。用户操作见[使用指南](usage.md)，安装见[安装与打包](install-lifecycle.md)。验证结论以当前提交的实际测试结果为准。

## 模块职责

`src/work-model.mjs` 提供独立版本的共用快照、来源观察、冲突检测、纯函数更新及旧记录适配，接口见[共用模型与兼容契约](work-model-contract.md)。它尚未接入页面或云端服务；现有本地读写继续使用原格式，适配不会改写记录文件。

| 入口 | 职责 |
| --- | --- |
| `src/server.mjs`、`src/http.mjs` | MCP／HTTP 传输，共用面板资源 |
| `src/git.mjs`、`src/graph.mjs` | Git 查询、NUL 解析、有界 diff、拓扑与 WIP 布局 |
| `src/actions.mjs` | 文件清单、逐文件 diff、prepare/execute 与状态校验 |
| `src/remote-actions.mjs`、`src/history-actions.mjs` | 远程引用、历史和工作区写操作校验 |
| `src/review.mjs` | 元数据、历史／工作目录比较、文件内容 |
| `src/work-resume.mjs` | 生成有界只读续接说明，复核历史记录与当前元数据，不调用模型或执行写操作 |
| `src/work-graph.mjs`、`src/ui/work-live.js` | 工作记录读取、提交归属、工作轨道和实际差异展示 |
| `src/work-analysis.mjs`、`src/work-context.mjs` | 有界分析材料、显式分析、增量合并、可靠保存与阶段计时 |
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

仓库状态文件限 1 MiB，拒绝符号链接、无效 JSON、未知字段和超限数据，不静默覆盖无效文件。写入使用临时文件替换，按 common dir 在本进程内排队，并通过共用 Git 目录中的 `workgraph-state.lock` 串行化不同 WorkGraph 进程的完整「读取—修改—替换」流程，避免不同审阅记录的并发保存丢失。保存配置仍是替换整个配置对象，同一审阅键仍以最后一次保存为准；锁不会将这类显式替换合并成字段级修改。读取不获取跨进程锁，只读取原子替换前或后的完整快照。

偏好锁使用同目录硬链接原子发布已完整写入的所有者信息，需要支持硬链接的本地文件系统。竞争者最多等待 5 秒；锁损坏、符号链接、进程退出或锁文件很旧都不会触发自动抢锁。正常退出保存流程时只释放属于当前调用的锁，任务失败也会尝试释放。进程异常退出后的恢复步骤见[故障排查](troubleshooting.md#偏好保存锁等待超时)。此锁只协调采用该协议的 WorkGraph 偏好保存，不协调外部文件编辑器，不扩展到 Git 写操作或工作地图分析锁。

配置导入上限为 64 KiB。浏览器布局使用 `localStorage` 键 `workgraph-layout-v3`，不属于仓库配置导出内容。

## 服务生命周期与性能

每个 MCP 进程最多保留 10 个 HTTP 仓库服务，达到上限时回收最近最少使用且没有请求执行的服务；30 分钟无认证 API 请求的服务也会回收。全部忙碌时拒绝新增并提示稍后重试。MCP 连接关闭、标准输入结束或收到 SIGINT／SIGTERM 时关闭所有监听器；异常进程是否由宿主重启取决于宿主。

历史查询单次上限 2000 条，可用 offset 分页继续读取。界面渲染所有已加载行，尚无虚拟列表，大量续载会增加查询和渲染开销。

没有代理运行状态或 PR／CI 状态联动。Issue／PR／MR URL 模板只打开页面或创建表单，不提交表单。宿主端到端安装、聊天切换、异常进程恢复、SSH／WSL 与跨主机访问仍需实际环境验证。

## 工作进展读取

`src/work-graph.mjs` 优先读取仓库 `.workgraph/state.json`，兼容旧 `.workgraph.json`，并读取 HEAD 最近 300 条提交，按完整 SHA 或 `Work-Item` 标识关联工作。HTTP `/api/work_graph` 与 App 工具 `workgraph_work_graph` 共用读取逻辑。`src/ui/work-live.js` 使用现有仓库请求隔离，切换时清空记录并丢弃旧响应。工作项状态来自记录，验证和用户接受不由提交推断；范围与限制见 [WorkGraph 使用说明](work-graph.md)。

`skills/workgraph` 是唯一对外 skill，构建生成独立 CLI 与工作地图页面。`src/workgraph-cli.mjs` 提供 `context`、`save`、`status`、`open` 和 `doctor`；Agent 在当前聊天中组织工作记录，通过 CLI 共用校验与原子保存。内部首次建立／增量更新规范位于 skill 的 references，不作为独立 skill 发现。插件保留 Git 界面及显式分析入口，调用本机 Codex 只读分析；默认自动判断流程，但不自动启动分析。

`src/work-analysis.mjs` 负责跨进程分析锁、代码及记录复核、结果合并、原子保存和计时。状态查询、打开面板、代码变化和旧自动化标记均不触发分析。Git 写操作继续由插件界面调用，未加入 skill。材料与存储边界见 [WorkGraph 使用说明](work-graph.md)。

## 只读续接

`src/work-resume.mjs` 为 CLI `resume --repo <path> --work <id>`、鉴权 GET `/api/work_resume?workId=...` 和仅供 App 使用的 MCP 工具 `workgraph_work_resume` 提供同一份说明。独立工作地图允许这个只读查询；其他 Git 写接口仍不开放。界面只预览、复制或选择文本，不依赖宿主向聊天发送消息的能力。

续接按规范化的具体 Worktree 路径读取记录。记录 revision 包含解析后的完整记录及来源，能识别新旧存储路径切换；它不是文件字节摘要。Git 查询使用有界读取、参数数组和 `--no-optional-locks`，不读取源码、差异正文或未提交文件内容。生成前后观察记录、HEAD、分支与状态清单，变化时最多重试一次；这不能检测所有并发内容修改，也不能提供原子仓库快照。

只有基线的完整 SHA、受限分支字符串和有效 UTC 时间参与说明，其他 `analysis` 字段不输出。工作文本按 JSON 数据封装，固定说明要求使用前复核，不把记录中的下一步或提交内容解释成授权。界面以仓库 epoch、所选工作项和请求序号隔离旧响应，复制前重新读取；切换仓库或详情后旧请求不能触发复制。范围、截断与错误行为见[准备续接说明](work-graph.md#准备续接说明)。
