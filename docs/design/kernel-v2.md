# tau 内核 v2 契约（设计稿）

`status: 已冻结，细节都在 kb 页，本稿只留链接` · `updated: 2026-11-16`

## 0. 这份稿子管什么

本稿是索引：v2 的设计已经实现并冻结，细节都移进了 kb 页。每一节只留一两句话和指向负责页的链接。

- 标题全部保留，因为决策记录和源码注释还链接到这些章节。
- 现有机制以 kb 页和代码为准。哪个事实由哪个页负责，见 [INDEX](../../.knowledge/INDEX.md#每类事实由谁负责)。
- 冻结了什么、怎样改契约：[kb-contract](../../.knowledge/kb-contract.md)。
- 做到哪一步：[v2 执行清单](../plan/kernel-v2-checklist.md)。

## 1. 目标和不变量

目标和不变量已移进 kb-contract：[目标](../../.knowledge/kb-contract.md#目标)、[不变量](../../.knowledge/kb-contract.md#不变量)。

## 2. 准入原则

五种代价、四条取舍顺序（第 4 条分三支）和“怎样用这个顺序”，见 [kb-extending 的取舍顺序](../../.knowledge/kb-extending.md#取舍顺序)。核心一句：上层能完整接管、不付出代价的功能，内核不做。

每个原语为什么在内核、上层做要付什么代价：[kb-contract 的原语和它在内核的理由](../../.knowledge/kb-contract.md#原语和它在内核的理由)。写设计稿时的要求（需求取自 Pi Web、现在就把原语定全）：[D47](../../.knowledge/kb-decisions.md#d47-v2-的来由六个缺口和-v1v2-的对照)。

## 3. 现在的缺口

v1 上，Pi Web 的功能放在上层要付代价。代价来自六个缺口，列在 [D47](../../.knowledge/kb-decisions.md#d47-v2-的来由六个缺口和-v1v2-的对照)。

## 4. v2 的心智模型

一句话：进程是带持久信箱的 actor，所有输入都是信件，信件来自人或别的进程。v1 和 v2 的对照在 [D47](../../.knowledge/kb-decisions.md#d47-v2-的来由六个缺口和-v1v2-的对照)；类型见 [kb-kernel 的状态](../../.knowledge/kb-kernel.md#状态)和[输入、副作用、环境](../../.knowledge/kb-kernel.md#输入副作用环境)；投影的字段见 [kb-kernel 的投影与命令](../../.knowledge/kb-kernel.md#投影与命令)；最小心智模型见 [kb-overview](../../.knowledge/kb-overview.md#认知模型)。

## 5. 原语

每个原语的做法、状态、事务和崩溃、模型和人怎样知道、测试，都在下面链接的 kb 页。每个原语上层做的代价，集中在 [kb-contract 的原语和它在内核的理由](../../.knowledge/kb-contract.md#原语和它在内核的理由)。

### 5.1 信件和发送者

发送者、信的头和合并、两种形状、张数和省略行、结束原因的文字：[kb-kernel](../../.knowledge/kb-kernel.md#信的头和合并)（[两种形状](../../.knowledge/kb-kernel.md#消息的两种形状)、[张数和省略行](../../.knowledge/kb-kernel.md#张数和省略行)、[结束原因的文字](../../.knowledge/kb-kernel.md#结束原因的文字)）。每封信的张数在入口限制：[kb-service 的图片](../../.knowledge/kb-service.md#图片)。选定的细节见 [D31](../../.knowledge/kb-decisions.md#d31-第-2-步信的头两种形状张数累计用量)。

### 5.2 安全点投递

做法、步数先查、写入不计步、阈值证明不变、坑点：[kb-kernel 的安全点投递](../../.knowledge/kb-kernel.md#安全点投递)。选定的细节见 [D32](../../.knowledge/kb-decisions.md#d32-第-3-步前一半安全点投递和-handoff)，真模型核实见 [D34](../../.knowledge/kb-decisions.md#d34-第-3-步真模型核实)。

### 5.3 进程之间：寄信、派生、停止、回信、跳数

- 工具 `post`、`spawn`、`stop_process` 的参数、结果、检查顺序、停止的语义、跳数、事务和崩溃：[kb-store 的进程之间的工具](../../.knowledge/kb-store.md#进程之间的工具)。
- 回信和 `replyTo`、`hops` 并进 `turn` 的规则：[kb-kernel 的回信](../../.knowledge/kb-kernel.md#回信)。
- 环境变量 `TAU_PROCESS`、`TAU_PIPE`：[kb-tools 的包装脚本](../../.knowledge/kb-tools.md#包装脚本)、[kb-service 的启动脚本和入口](../../.knowledge/kb-service.md#启动脚本和入口)。
- 等子进程的做法：[kb-extras 的多 Agent 的等待](../../.knowledge/kb-extras.md#多-agent-的等待)。
- 选定的细节见 [D35](../../.knowledge/kb-decisions.md#d35-第-4-步第一部分回信outagents-的描述)、[D36](../../.knowledge/kb-decisions.md#d36-第-4-步第二部分进程之间的工具的执行和两处例外)、[D37](../../.knowledge/kb-decisions.md#d37-第-4-步第三部分环境变量tau_pipetau-脚本)。

### 5.4 主动换段

`handoff` 工具、结果、触发条件、不变量：[kb-kernel 的主动换段](../../.knowledge/kb-kernel.md#主动换段handoff)。选定的细节见 [D32](../../.knowledge/kb-decisions.md#d32-第-3-步前一半安全点投递和-handoff)。

### 5.5 工具定义

“工具定义”专指 `~/.tau/tools/` 下的文件，请求里给模型看的叫“工具描述”（[AGENTS.md 的用词](../../AGENTS.md#用词)）。格式、读取、冻结、大小上限、运行：[kb-tools 的工具定义](../../.knowledge/kb-tools.md#工具定义)、[运行工具定义](../../.knowledge/kb-tools.md#运行工具定义)；工具描述：[kb-kernel](../../.knowledge/kb-kernel.md#工具描述)。取舍见 [D43](../../.knowledge/kb-decisions.md#d43-第-7-步前一半工具定义的格式读取和冻结)、[D44](../../.knowledge/kb-decisions.md#d44-第-7-步后一半运行工具定义)。

### 5.6 内容块和图片

- 入口检查：[kb-service 的图片](../../.knowledge/kb-service.md#图片)。存储、引用、不收图片的模型：[kb-store 的图片](../../.knowledge/kb-store.md#图片)。
- 请求里的图片、用量估算和换段阈值、启动检查：[kb-kernel](../../.knowledge/kb-kernel.md#请求里的图片)（[换段阈值](../../.knowledge/kb-kernel.md#换段阈值)、[启动检查](../../.knowledge/kb-kernel.md#启动检查和交接以后的检查)）。
- 带图的工具结果：[kb-executor](../../.knowledge/kb-executor.md#失败怎样变成结果)。
- 取舍和核实：[D40](../../.knowledge/kb-decisions.md#d40-第-6-步前一半的选择)、[D41](../../.knowledge/kb-decisions.md#d41-第-6-步后一半的选择)、[D42](../../.knowledge/kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)、[D45](../../.knowledge/kb-decisions.md#d45-第-7-步带图的工具结果的真模型核实)；文档估算见 [D48](../../.knowledge/kb-decisions.md#d48-量-image_tokens-的文档估算和思考级别重试的需求来源)。

### 5.7 调用模型：思考级别和重试

思考级别、输出上限的算法、重试：[kb-executor 的调用模型](../../.knowledge/kb-executor.md#调用模型actionsts)。预设的 `thinking` 见 [mvp.md 第 2 节](mvp.md#2-预设)。取舍见 [D33](../../.knowledge/kb-decisions.md#d33-第-3-步后一半思考级别输出上限重试)，真模型核实见 [D34](../../.knowledge/kb-decisions.md#d34-第-3-步真模型核实)，需求来源见 [D48](../../.knowledge/kb-decisions.md#d48-量-image_tokens-的文档估算和思考级别重试的需求来源)。

### 5.8 累计用量

规则：[kb-kernel 的累计用量](../../.knowledge/kb-kernel.md#累计用量)。投影和 `self` 里的那一行：[kb-kernel 的投影与命令](../../.knowledge/kb-kernel.md#投影与命令)。

### 5.9 协议

请求和回复、分帧、请求的校验：[kb-service 的线协议](../../.knowledge/kb-service.md#线协议srcprotocolts)。`history` 和 `watch`：[历史和订阅](../../.knowledge/kb-service.md#历史和订阅)。CLI、`tau` 脚本、`TAU_PIPE`：[CLI](../../.knowledge/kb-service.md#clisrcclimaints)、[启动脚本和入口](../../.knowledge/kb-service.md#启动脚本和入口)。容易踩的坑（半关闭、`tau.cmd` 的 `&`）：[坑点](../../.knowledge/kb-service.md#坑点)。选定的细节见 [D39](../../.knowledge/kb-decisions.md#d39-第-5-步后一半协议的-historywatch-和-text-的编号)。

## 6. v2 也不做的

v2 也不做的三张表，已移进[决策记录 D46](../../.knowledge/kb-decisions.md#d46-v2-也不做的)。

## 7. 要改的规则

各步要改的规则句子，都在对应的那一步改完了（AGENTS.md、kb 页、mvp.md 和决策记录里的就地改正）。逐步的任务和验收见[执行清单](../plan/kernel-v2-checklist.md)。以后改规则，按 [kb-contract 的改契约的程序](../../.knowledge/kb-contract.md#改契约的程序)。

## 8. 上层建筑的做法

上层建筑的做法已移进 [kb-extras](../../.knowledge/kb-extras.md)：[放在哪里](../../.knowledge/kb-extras.md#放在哪里)、[依赖规则](../../.knowledge/kb-extras.md#依赖规则)、[Pi Web 功能的做法和代价](../../.knowledge/kb-extras.md#pi-web-的功能在-v2-上的做法)、[`tx`](../../.knowledge/kb-extras.md#上层的命令行-tx)、[多 Agent 的等待](../../.knowledge/kb-extras.md#多-agent-的等待)、[后台命令的配方](../../.knowledge/kb-extras.md#后台命令和完成通知的配方)、[HTTP 桥的检查](../../.knowledge/kb-extras.md#http-桥要做的检查)。

## 9. 实现顺序

实现顺序、每一步的任务和验收，在[执行清单](../plan/kernel-v2-checklist.md)。第 7 步的真模型核实见 [D45](../../.knowledge/kb-decisions.md#d45-第-7-步带图的工具结果的真模型核实)。

推导测试的做法已移进 [kb-contract 的推导测试的做法](../../.knowledge/kb-contract.md#推导测试的做法)。

## 10. 冻结规则

冻结的契约清单、参与启动检查的量、改契约的程序和不算改契约的事，已移进 [kb-contract](../../.knowledge/kb-contract.md#契约清单)。

## 11. 未决问题

未决问题已定：常量和它们的状态在 [kb-kernel 的常量](../../.knowledge/kb-kernel.md#常量)和 [kb-service 的图片](../../.knowledge/kb-service.md#图片)；内部常量的默认值和 OAuth 在[决策记录的未确认的默认值](../../.knowledge/kb-decisions.md#未确认的默认值)。`ps` 和 `self` 变慢见 [kb-contract 的不算改契约](../../.knowledge/kb-contract.md#不算改契约)，目录写着收图片却被拒的模型见 [kb-contract 的风险表](../../.knowledge/kb-contract.md#风险表)。

## 12. 风险

风险表已移进 [kb-contract 的风险表](../../.knowledge/kb-contract.md#风险表)。
