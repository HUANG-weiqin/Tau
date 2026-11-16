# Tau Knowledge Index

`updated: 2026-11-16`

知识库记录当前架构、已做的决定和容易破坏的不变量。源码和测试是实现证据。[MVP 设计稿](../docs/design/mvp.md)描述 MVP 要做成什么样。[内核 v2 设计稿](../docs/design/kernel-v2.md)描述 v2 还没实现的部分。[v2 执行清单](../docs/plan/kernel-v2-checklist.md)记录按什么顺序做。

源码在 `src/`，测试在 `test/`，入口见[总览](kb-overview.md#入口)。已有模块页的模块，细节以模块页为准；还没有模块页的，以设计稿为准。每实现一个模块，就为它建一页 kb，并把设计稿里对应的章节改成指向这一页的链接。

## 按任务找入口

| 你要解决的问题 | 先读 |
|---|---|
| 初次接手 | [AGENTS.md](../AGENTS.md)，再读[总览的认知模型](kb-overview.md#认知模型) |
| 判断一个功能该不该做、放在内核还是上层 | [kb-extending.md 的取舍顺序](kb-extending.md#取舍顺序)，AGENTS.md 的“准入规则”，设计稿的 [MVP 不做](../docs/design/mvp.md#mvp-不做) |
| 加功能：接在哪里，按什么原则接 | [kb-extending.md 的推导顺序](kb-extending.md#推导顺序) |
| 某个设计为什么是这样，当初放弃过什么 | [决策记录](kb-decisions.md) |
| 想加一个看起来合理的机制（压缩、wait 工具、只读 bash 审查、按项目存数据） | 先读 [Pi Web 的教训](kb-piweb-lessons.md) |
| 改纯函数层：类型、`decide`、流程、换段和换段阈值、用量估算、投影的字段 | [kb-kernel.md](kb-kernel.md) |
| 改存储：表、处理输入的事务、库内工具的结果 | [kb-store.md](kb-store.md) |
| 改执行器、启动恢复、崩溃注入测试 | [kb-executor.md](kb-executor.md) |
| 改 `read`、`write`、`edit`、`bash`：路径、编码、shell、结束进程、输出 | [kb-tools.md](kb-tools.md) |
| 改服务、线协议、CLI、`tau ps` 的文字、正常退出 | [kb-service.md](kb-service.md) |
| 改记忆：接口、上限、视图格式、版本号 | [kb-memory.md](kb-memory.md) |
| 改预设的格式和读取规则 | [设计稿第 2 节](../docs/design/mvp.md#2-预设) |
| v2 要改什么、为什么改 | [内核 v2 设计稿](../docs/design/kernel-v2.md) |
| 下一步做什么 | [v2 执行清单](../docs/plan/kernel-v2-checklist.md) |

## 每类事实由谁负责

一个事实只写在负责它的文件里，其它地方用链接。

| 文件 | 负责的事实 |
|---|---|
| [AGENTS.md](../AGENTS.md) | 用词、必须遵守的规则、准入规则、依赖和工具链、工作习惯、完成门槛 |
| [设计稿](../docs/design/mvp.md) | 还没有模块页的模块细节：预设（含读取规则）、总体结构、自省的内容；“MVP 不做”清单；风险 |
| [内核 v2 设计稿](../docs/design/kernel-v2.md) | v2 还没实现的部分：原语的做法、要改的规则、上层建筑的做法、冻结规则、第 1 节的不变量 |
| [v2 执行清单](../docs/plan/kernel-v2-checklist.md) | v2 的步骤顺序、每步的任务和验收、当前进度 |
| [MVP 执行清单](../docs/plan/mvp-checklist.md) | 已完成，留作记录 |
| [kb-overview.md](kb-overview.md) | 产品边界、运行循环、状态分层、最小心智模型（含模型知道事情的三个入口）、源码入口 |
| [kb-kernel.md](kb-kernel.md) | 纯函数层的类型、`start`、`decide`、`effectOf`、`buildContext`、`observe` 和投影的字段、派生值、常量、工具描述、第 5 节的流程、纯函数层不变量 |
| [kb-store.md](kb-store.md) | 库的位置、表结构和 PRAGMA、三个存储事务、图片（`blobs`）的存取、待办副作用表的同步、处理一条输入读什么、存储层不变量、库内工具的参数、结果和文字格式 |
| [kb-executor.md](kb-executor.md) | 待办副作用表一行的一生、执行器的三个事务、中止、失败怎样变成结果、模型和库外工具的调用、启动恢复、崩溃窗口、崩溃注入和竞态测试 |
| [kb-memory.md](kb-memory.md) | `Memory` 接口的语义和契约、谁有记忆库、三个上限和 `set` 的检查顺序、视图的格式、版本号、键和值的编码 |
| [kb-tools.md](kb-tools.md) | `read`、`write`、`edit`、`bash` 的接口、行为和结果文本；参数被 pi-ai 改写的方式；路径解析；编码和换行；bash 用哪个 shell、包装脚本、超时、中止、怎样结束进程、输出上限、后台进程 |
| [kb-service.md](kb-service.md) | 服务的启动顺序、`pump`、观察者和最终回复、线协议和请求校验、图片的入口检查和 `blob` 请求、进程 ID、流式文本、CLI 的命令、输出和退出码、`tau ps` 的文字格式、启动脚本、正常退出 |
| [kb-decisions.md](kb-decisions.md) | 决定的理由、核实过的事实、放弃的方案、未确认的默认值 |
| [kb-piweb-lessons.md](kb-piweb-lessons.md) | Pi Web 的实测问题，以及 tau 对应的规则 |
| [kb-extending.md](kb-extending.md) | 扩展的核心原则、取舍顺序（放内核还是上层）、加功能的推导顺序、大致方向 |
| [_template.md](_template.md) | 新页模板 |

已建立的模块页：`kb-kernel.md`、`kb-store.md`、`kb-executor.md`、`kb-memory.md`、`kb-tools.md`、`kb-service.md`。计划中的模块页都已建立。预设和自省没有单独的模块页，细节留在设计稿第 2 节和第 9 节。

## 维护规则

- 每个长期主题只有一个负责的文件。其它文件只写本层的不变量，并链接过去。
- 新增、删除、重命名页面，或改变章节结构时，同步本索引和相关链接。
- 不写短期进度、单次测试数量、临时性能数字。保留仍然影响决策的原因和失败边界。
- 实现和设计稿冲突时，先明确写出差异，再决定改哪一边。不能用整理文档的方式悄悄撤销一条规则。
