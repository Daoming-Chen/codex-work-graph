# 共用工作模型与本地兼容契约

本文定义阶段 0 的程序契约。实现入口为 [`src/work-model.mjs`](../src/work-model.mjs)，专项测试为 [`test/work-model.test.mjs`](../test/work-model.test.mjs)。产品边界与实施状态见[本地版与云端版设计](local-cloud-design.md)。

## 版本与存储边界

共用快照使用 `format: "workgraph.snapshot"`、`schemaVersion: 1`。本地文件继续使用原有 `version: 1`，两个版本空间独立。现有 CLI、分析保存和页面读写保持原格式；不能把共用快照写入 `.workgraph/state.json`。当前未增加云端端点、持久化服务或分支扫描器。

`validateWorkSnapshot` 拒绝未知字段、未知版本、重复工作或来源 ID、无效来源、缺失父项和循环。每个来源内最多三层工作。`parseWorkSnapshot` 和 `serializeWorkSnapshot` 执行相同验证，解析结果为独立数据副本。

## 快照字段

| 字段 | 契约 |
| --- | --- |
| `repository` | `id` 由调用方提供并持久保存；`provider` 为 `local` 或 `github`，后者必须提供 `providerId`；`locators` 是可变化的定位信息，不从路径自动生成身份 |
| `revision` | 非负安全整数，用于更新时比较与交换，初次导入为 0 |
| `sources` | 每项含 `id`、`kind`、`object`、`revision`、`observedAt`；类别为 `legacy`、`human`、`git`、`platform` 或 `agent`；时间为有效 UTC ISO 时间 |
| `works` | 每项含稳定 `id` 和非空 `observations`；同一来源在一个工作中最多一份观察 |
| `coverage` | `scope`、`observedAt`、`complete`、`gaps` 表达采集范围；更新观察不自动刷新覆盖声明 |
| `legacy` | 可选兼容封装，保存原记录及来源 ID；原始 JSON 数据、投影和摘要一起校验 |

观察包含 `sourceId`、`title`、可选 `parentId`、`kind`、`progress`、`summary`、`next`、`outcomes`、`issues` 及以下独立维度：

| 字段 | 值与条件 |
| --- | --- |
| `progress` | `not-started`、`in-progress`、`blocked`、`paused`、`implemented` |
| `verification` | `state: unknown`，或 `passed` / `failed` 并提供 `sha`、`scope`、`evidence` |
| `integration` | `state: unknown`，或 `pending` / `partial` / `integrated` / `needs-review` 并提供 `target`、`sha`、`evidence` |
| `acceptance` | `state: unknown`，或 `accepted` / `rejected` 并提供 `actor`、`criteria`、`evidence`；非未知值只允许来自 `human` 来源 |
| `associations` | 每项含 `kind`（`commit`、`branch`、`pr`、`issue`）、`object`、`basis`（`explicit` 或 `inferred`） |

证据引用是定位信息，模型校验不会访问引用或证明真实性。验证及集成的 SHA 接受完整 SHA-1 或 SHA-256，时间取自所属来源。不同来源分别保留观察，消费者不能将字段存在等同于结论已获独立验证。

快照最多容纳 1000 个来源、10000 个工作、每工作 100 份观察；单份观察最多 1000 个关联、各 20 条成果和问题。超限拒绝输入，不静默截断。这些限制不构成大型仓库性能承诺。

## 旧记录适配

`importLegacyWorkRecord(manifest, options)` 接收原记录和显式仓库身份、来源 ID、来源对象、观察时间及范围。先运行现有本地校验，保存原始 JSON 数据，再生成投影。`loadCommonWorkRecord(root, options)` 复用现有加载器，优先新目录记录，其次旧根目录文件；损坏文件仍报错，不回退覆盖。

| 原状态 | 共用进度 |
| --- | --- |
| 待开始 | `not-started` |
| 进行中 | `in-progress` |
| 已搁置 | `paused` |
| 已完成 | `implemented` |

验证、集成和验收全部设为 `unknown`。原始更新时间、可选字段是否缺省、分析基线、自动化元数据及原校验器允许的顶层扩展保留在兼容封装中。来源类别为 `legacy`，不假定原记录经过人工确认。来源 revision 为规范化原始 JSON 的 SHA-256 摘要，不是文件字节摘要。

导入只做内存转换，不移动或重写文件。`exportLegacyWorkRecord` 仅提取未扩展的兼容快照，返回与原记录等价的 JSON 数据，不保证空白、键顺序或文件字节一致。增加其他来源后导出失败，防止新信息丢失。投影被修改或原始数据与 revision 不符时也拒绝导出。重新观察旧文件需重新导入，不通过共用更新接口修改兼容来源。

## 更新与冲突

`applyWorkObservations(snapshot, update, { actorKind })` 是纯函数。`update` 包含 `expectedRevision`、完整 `source` 及该来源的完整工作观察列表。它保留其他来源，移除本次省略的本来源观察；没有剩余观察的工作从快照移除。后续存储层负责另行保留历史版本，该函数不提供归档。

快照 revision 不匹配时拒绝请求。相同来源 ID 不得改变类别或对象身份。相同来源 revision 与相同内容在当前基线上重放不推进快照；重复 revision 携带不同内容则拒绝。新来源版本使快照 revision 加一。来源 revision 是不透明值，是否代表最新外部事实由采集器核对，不能按字符串排序。

`actorKind` 必须来自可信身份上下文，不能从请求正文取得。模块阻止 Agent 冒用人工来源或写入验收结果；不承担身份认证或同类别用户之间的权限判断。后续服务必须限制调用者可更新的来源 ID，并在持久化事务中原子核对 revision 与写入结果。纯函数不提供跨进程锁或数据库事务。

`workConflicts` 返回存在差异的工作 ID、来源 ID 和字段名，不生成唯一状态。工作身份须由调用方明确关联；独立工作误用同一 ID 需核对并重映射，相同标题不构成合并依据。

## 验证范围

专项测试覆盖旧记录 JSON 往返、旧状态、空地图、两种文件路径与优先级、损坏文件保护、重复身份、多来源差异、无效层级、证据字段要求、旧版本拒绝及人工验收隔离。现有测试继续验证本地读写和分析。跨分支采集、集中持久化、完整权限和云端部署属于后续阶段。
