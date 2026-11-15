# Tau Knowledge Index

`updated: 2026-11-15`

知识库记录当前架构、已做的决定和容易破坏的不变量。源码和测试是实现证据。[设计稿](../docs/design/mvp.md)描述 MVP 要做成什么样，[执行清单](../docs/plan/mvp-checklist.md)记录按什么顺序做。

现在还没有源码。实现之前，模块细节以设计稿为准。每实现一个模块，就为它建一页 kb，并把设计稿里对应的章节改成指向这一页的链接。

## 按任务找入口

| 你要解决的问题 | 先读 |
|---|---|
| 初次接手 | [AGENTS.md](../AGENTS.md)，再读[总览](kb-overview.md) |
| 判断一个功能该不该做 | AGENTS.md 的“准入规则”，设计稿的 [MVP 不做](../docs/design/mvp.md#mvp-不做) |
| 某个设计为什么是这样，当初放弃过什么 | [决策记录](kb-decisions.md) |
| 想加一个看起来合理的机制（压缩、wait 工具、只读 bash 审查、按项目存数据） | 先读 [Pi Web 的教训](kb-piweb-lessons.md) |
| 改内核、存储、记忆、自省或工具 | 设计稿的对应章节（模块页建立之前） |
| 下一步做什么 | [执行清单](../docs/plan/mvp-checklist.md) |

## 每类事实由谁负责

一个事实只写在负责它的文件里，其它地方用链接。

| 文件 | 负责的事实 |
|---|---|
| [AGENTS.md](../AGENTS.md) | 用词、必须遵守的规则、准入规则、依赖和工具链、工作习惯、完成门槛 |
| [设计稿](../docs/design/mvp.md) | 模块细节：类型、流程、表、接口、协议；“MVP 不做”清单；风险 |
| [执行清单](../docs/plan/mvp-checklist.md) | 步骤顺序、每步的任务和验收、当前进度 |
| [kb-overview.md](kb-overview.md) | 产品边界、运行循环、状态分层 |
| [kb-decisions.md](kb-decisions.md) | 决定的理由、核实过的事实、放弃的方案、未确认的默认值 |
| [kb-piweb-lessons.md](kb-piweb-lessons.md) | Pi Web 的实测问题，以及 tau 对应的规则 |
| [_template.md](_template.md) | 新页模板 |

计划中的模块页，随实现建立：`kb-kernel.md`、`kb-store.md`、`kb-executor.md`、`kb-tools.md`、`kb-memory.md`、`kb-service.md`（自省、服务、CLI）。模块页建立后，它接管设计稿里对应章节的细节。

## 维护规则

- 每个长期主题只有一个负责的文件。其它文件只写本层的不变量，并链接过去。
- 新增、删除、重命名页面，或改变章节结构时，同步本索引和相关链接。
- 不写短期进度、单次测试数量、临时性能数字。保留仍然影响决策的原因和失败边界。
- 实现和设计稿冲突时，先明确写出差异，再决定改哪一边。不能用整理文档的方式悄悄撤销一条规则。
