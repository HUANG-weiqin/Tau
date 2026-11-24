# Tau Agent Guide

## 项目目标

tau 是本机常驻的个人 Agent harness，目标是连续运行很多年。小而硬：代码精简干净，先保证崩溃后状态正确，再加功能。严格 YAGNI。

用户要三种 Agent：一个全局助手、每个项目多个带记忆的 Agent、不带记忆的临时 Agent。它们是写预设的三种方式，不是代码里的类型（见[设计稿第 2 节](docs/design/mvp.md#2-预设)）。

代码标识使用英文。文档、知识页和面向用户的文本使用中文，句子要短，一句只说一件事。

## 必读顺序

1. 本文件：用词、必须遵守的规则、工作习惯。
2. [`.knowledge/INDEX.md`](.knowledge/INDEX.md)：每类事实由哪个文件负责。
3. [总览的认知模型](.knowledge/kb-overview.md#认知模型)：一屏讲完 tau 的最小心智模型。
4. [`.knowledge/kb-contract.md`](.knowledge/kb-contract.md)：内核冻结了什么，每个原语为什么在内核。
5. [`docs/design/mvp.md`](docs/design/mvp.md)：模块细节和“MVP 不做”清单。
6. [`docs/plan/kernel-v2-checklist.md`](docs/plan/kernel-v2-checklist.md)：当前做到哪一步。

加功能前，按 [kb-extending 的推导顺序](.knowledge/kb-extending.md#推导顺序)逐条回答。

修改行为前，先读对应的源码和测试。

## 用词

同一个东西永远用同一个词。

| 词 | 意思 |
|---|---|
| 预设 | `~/.tau/presets/<id>.md`。文件名就是预设 ID，也就是 Agent 的身份。 |
| 工具定义 | `~/.tau/tools/<name>.json`。模型能调用的外部命令：名称、说明、参数和命令（[kb-tools](.knowledge/kb-tools.md#工具定义)）。请求里给模型看的工具名、说明和参数叫“工具描述”。 |
| 模型补充文件 | `~/.tau/models/<provider>.json`。上层写，内核每次查模型时现读：同 `id` 的条目替换 pi-ai 目录里的模型，新 `id` 加进目录（[D105](.knowledge/kb-decisions.md#d105-模型补充文件copilot-的模型列表跟着账号走)）。 |
| 进程 | 一条正在工作的线：一份会话快照、一个信箱、一个状态。 |
| 会话快照 | 进程出生时由预设读成的配置，之后属于这个会话，只经 `reconfigure` 改（[D71](.knowledge/kb-decisions.md#d71-会话配置reconfigure会话快照可改)）。预设文件只管出生，改它不影响已有的进程。 |
| 待换配置 | 会话快照里换段时才生效的改动，存在进程记录的 `next` 里。 |
| 调用参数 / 结构性字段 | 会话快照里 `thinking`、`options`、`handoff` 是调用参数，`reconfigure` 立即生效；其余（提示词、工具、模型、工作目录、上下文文件）是结构性字段，换段时生效。 |
| 上下文文件 | 会话快照声明的一组文件，每次开段重读进系统提示词（[D72](.knowledge/kb-decisions.md#d72-上下文文件开段重读)）。 |
| 开段 | 建进程，和每次换段被接受。记忆视图和上下文视图在这时重取。 |
| 工作段 | 进程当前的模型上下文。 |
| 换段 | 写交接说明，开一个新的工作段。 |
| 简略视图 | 一段消息每条截成一行的摘录。换段时内核把它写进新段第一条，按长度往下带（[D103](.knowledge/kb-decisions.md#d103-换段时带上旧段的简略视图)）；`history_dump` 也把每个旧段写成简略视图文件。 |
| 安全点 | 当前这条助手消息的工具结果全部写完或补完、调用 `continueTurn` 之前。运行中到的信在这里并进段。 |
| 信箱 | 发给一个进程的所有输入排成的队。 |
| 信件 | 信箱里的一条人或进程写来的消息：发送者、内容块、跳数、回信对象（[kb-kernel](.knowledge/kb-kernel.md#信的头和合并)）。 |
| 回信 | 一轮结束时，寄给等回信的进程的信。正文是这一轮的最终回复，头写结束原因（[kb-kernel](.knowledge/kb-kernel.md#回信)）。 |
| 输入 | 信箱里的一条：信件、模型结果、工具结果、停止、换配置。 |
| 内核 | tau 自己：`src/` 的代码，加上它的文件格式、协议和 CLI。和它相对的是上层。 |
| 上层 | 建在内核之上的功能，不改内核。 |
| 纯函数层 | `src/kernel/`。 |
| 工具描述 | 请求里给模型看的工具名、说明和参数。 |
| 副作用 | 纯函数层之外的动作。库内副作用（记忆工具、`self`、`handoff`、`post`、`spawn`、`stop_process`，以及工具定义在结果里声明的库内动作）在事务里执行；库外副作用（模型、read、write、edit、bash、工具定义）由执行器执行。 |
| 记忆库 | 一个带版本号的键值存储，`ns` 等于预设 ID。 |
| 领地 | 带记忆的 Agent 自己的目录：`~/.tau/extras/home/<预设 ID>/`。放什么、怎样组织由它定；别的 Agent 只读不写，这是约定，不是边界（[D98](.knowledge/kb-decisions.md#d98-领地带记忆的-agent-有一块自己的目录)）。 |
| 投影 | 纯函数 `observe` 的结果。CLI 和 `self` 工具看的是同一份。 |

## 必须遵守的规则

这一节和下面的准入规则是 tau 的架构宪法。每条规则都能对照代码检查。细节见括号里的 [MVP 设计稿](docs/design/mvp.md)章节和各模块页；冻结的内容见 [kb-contract](.knowledge/kb-contract.md)。要破例，先在[决策记录](.knowledge/kb-decisions.md)写清理由，再改这里。

**状态**（第 4 节）

- 进程的状态 = 进程记录 + 当前工作段。
- 阶段是带标签的联合类型，所有 `switch` 必须穷尽。禁止用布尔标志表示阶段。只在某个阶段有意义的数据，放在那个阶段里。
- 同一个事实只有一个来源。能从工作段算出来的值不存。
- `decide`、`effectOf`、`observe` 是纯函数：不 `await`，不读时钟，不生成随机数，不做 I/O。时间、记忆视图和上下文视图由环境参数传入。
- `src/kernel/` 只导入 kernel 内部的文件，外部类型只能 `import type`。一个扫描 import 的测试负责检查。
- 流式文本不是状态，不进库。

**提交与执行**（第 4.4 节、第 6 节）

- 一条输入一个事务。事务里做哪几件事，只写在 [kb-store](.knowledge/kb-store.md#处理一条输入)。
- `decide` 不发出副作用。回信由 `decide` 的 `out` 给出，存储层在同一个事务里投递。待办副作用表由 `effectOf` 同步，只有在等的副作用编号变了才动。
- 执行器只做开始、中止、催、上报。它不做决策，自己也不重试；模型请求在拿到成功的响应之前的重试，交给 pi-ai。
- 崩溃后，正在运行的库外副作用一律作为“被中断”送回。不自动重做任何库外副作用。

**上下文与记忆**（第 5 节、第 8 节）

- 换段是唯一缩短上下文的办法。例外：一次请求里，旧图成批省略，库不变（[D40](.knowledge/kb-decisions.md#d40-第-6-步前一半的选择)）。处理一条输入只读进程记录和当前工作段。两个例外（[D36](.knowledge/kb-decisions.md#d36-第-4-步第二部分进程之间的工具的执行和两处例外)）：`post`、`stop_process` 还读收件人的进程记录，`spawn` 还读预设文件、它用到的工具定义文件和模型补充文件（[D105](.knowledge/kb-decisions.md#d105-模型补充文件copilot-的模型列表跟着账号走)）。开段还读会话快照声明的上下文文件（[D72](.knowledge/kb-decisions.md#d72-上下文文件开段重读)）。工具定义在结果里声明的同样动作，读的也一样（[D64](.knowledge/kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)）。
- 每次调用模型都计一步。运行中收到的信件排队到下一个安全点。
- 记忆只能通过记忆接口访问。写入必须带读到的版本号。

**边界与存储**（第 2 节、第 7 节、第 9 到 11 节）

- `self` 只读，这是接口的范围，不是权限边界。没有沙箱。不做能被 bash 绕过的假边界。
- 预设是 `~/.tau/presets/` 下的文件，工具定义是 `~/.tau/tools/` 下的文件，模型补充文件是 `~/.tau/models/` 下的文件（内核只读，[D105](.knowledge/kb-decisions.md#d105-模型补充文件copilot-的模型列表跟着账号走)），上层的数据在 `~/.tau/extras/<名字>/`（例外：共享手册装在 `~/.tau/handbook.md`，原型在仓库 `extras/handbook/`，[D99](.knowledge/kb-decisions.md#d99-共享手册的原型进仓库安装脚本装到-tauhandbookmd)），凭据（api key 和 OAuth 令牌）在 `~/.tau/auth.json`（[D83](.knowledge/kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)，这是不进库的内核数据之一）。另一个是 bash 工具的输出文件：写在 `~/.tau/extras/shell/<进程 ID>/`（[D90](.knowledge/kb-decisions.md#d90-bash-接管后台命令先等没跑完转后台输出写文件跑完寄信)），不进库、不备份、7 天清理，这是内核唯一写 `extras/` 的地方。其余数据都在 `~/.tau/tau.db`，包括图片（`blobs` 表）。项目目录里不写任何东西。
- 服务只在命名管道上监听，监听成功才算持锁。MVP 只支持 Windows。

## 准入规则

- **YAGNI**：MVP 里没有用户的功能不做。“以后会用到”“很便宜”都不是理由。
- **自由度**：内核给上层四类自由度：事实可读、控制对称、动作可组合、参数可传。D64 一次补齐，它的原语不要求本机用过；以后内核加一样事实或控制，同时给上层。功能本身照旧按 YAGNI 和取舍顺序判（[D64](.knowledge/kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)，[kb-extending 的核心原则 8](.knowledge/kb-extending.md#核心原则)）。
- 外部工具能完整替代的功能不做：Git 负责 diff 和历史，编辑器负责浏览和编辑文件，终端负责交互式 shell。
- 上层能完整接管、不付出代价的功能，内核不做。取舍顺序见 [kb-extending](.knowledge/kb-extending.md#取舍顺序)。
- 进内核的功能不加阶段，阶段固定是 3 个。不在状态之外加可变字段。不推翻[不变量](.knowledge/kb-contract.md#不变量)。
- 只调用依赖的公开、无状态函数。不碰私有 API，不打补丁。
- 设计稿“MVP 不做”清单里的任何一项，要做之前先更新设计稿和清单。
- 决定要做以后，接在哪里、按什么原则接，见 [kb-extending](.knowledge/kb-extending.md)的原则和推导顺序。

## 内核契约

内核契约已冻结。完整清单、参与启动检查的量和不算改契约的事，见 [kb-contract](.knowledge/kb-contract.md#契约清单)。下面只是摘要：

- 不变量，和进程、信件、阶段、投影这些类型的字段，以及表结构。
- 行为：回信、安全点投递、停止、跳数，事务和两张表的规则，`decide` 的输出，bash 先等 `timeout` 秒、没跑完转后台（命令不被结束，输出写文件，跑完寄信，D90），正常结束时不结束后台进程。
- 线协议、CLI、环境变量，以及预设和工具定义的文件格式和运行。
- `decide` 写进段的固定文字，和内置工具的名字。
- 入口条件：图片检查、消息和工具定义的大小上限、工具定义 `timeout` 的范围、跳数上限。
- 演进：类型、线协议和段里消息的 JSON 以后只加可选键，客户端忽略不认识的键（D64）。

改契约的程序：

1. 先在[决策记录](.knowledge/kb-decisions.md)写清理由：上层为什么做不到，或者要付出哪一种代价。
2. 按 [kb-contract 的做法](.knowledge/kb-contract.md#推导测试的做法)出新题，做推导测试并通过，结果也写进决策记录。
3. 然后才改。

## 小而硬规矩

- `src/` 的依赖白名单：`@earendil-works/pi-ai`（`package.json` 写 `^` 范围，实际版本由锁文件定；它会经常升级，文档和注释里不写它的版本号，[D84](.knowledge/kb-decisions.md#d84-pi-ai-升级版本不再写死)；怎样升级见 [kb-executor](.knowledge/kb-executor.md#升级-pi-ai)），开发依赖 `typescript` 和 `@types/node`。加新依赖要在[决策记录](.knowledge/kb-decisions.md)里写明理由。
- `extras/`（上层建筑）不导入 `src/`。它的依赖随便加，写在 `extras/` 自己的 `package.json` 里，精确锁定版本（pi-ai 除外，它和根目录同一个范围、同一个版本，见上），不进上面的白名单（[D63](.knowledge/kb-decisions.md#d63-上层的依赖随便加)）。`test/extras-imports.test.ts` 只检查不导入 `src/`（和其它 extras/ 之外的仓库文件）。细节见 [kb-extras](.knowledge/kb-extras.md#依赖规则)。
- SQLite 用内置的 `node:sqlite`。
- 没有构建步骤：Node 24（不低于 24.21）直接运行 `.ts`。只用可擦除的 TS 语法（不用 enum、namespace、参数属性）；import 写 `.ts` 扩展名。
- tsconfig：strict 全开，`noEmit`、`erasableSyntaxOnly`、`allowImportingTsExtensions`、`verbatimModuleSyntax`。
- 测试用 `node:test`。类型检查只跑 `tsc`。
- 代码量预算：不算测试，`src/` 不超过 4460 行（D64 从 3000 放宽，D87 到 3610，D88 到 3640，D89 到 3670，D90 到 3950，D92 到 4100，D103 到 4120，D104 到 4150，D105 到 4210，D108 到 4280，D109 一并含 D110，到 4460）。写到一半时校准这个数字。
- 不写兼容代码。例外：改表结构要带迁移（[D74](.knowledge/kb-decisions.md#d74-迁移的规矩)）。不提前建抽象：只有记忆有接口，因为它明确要被替换。
- 对崩溃、竞态和生命周期，先写最小反例测试，再改代码。

## 工作习惯

- 搜索和读取优先用专用工具（grep / find / ls / read），不用 shell 的 `cat`、`grep` 代替。
- 修改文件用精确替换。只有新建文件或整体重写才整份写入。
- 保留用户已有的未提交改动，不顺手整理无关文件。
- 一个事实只写在负责它的文件里，其它地方用链接（负责关系见 `.knowledge/INDEX.md`）。
- 完成清单里的一步时：勾选清单，更新或新建对应的 kb 页。kb 页只写长期事实，不写短期进度。
- 子 Agent 默认只读分析，返回具体文件、行号、反例和验证证据。

## 完成门槛

代码改动至少运行（清单第 0 步建立这些命令）：

```bash
npm test
npm run typecheck
git diff --check
```

`npm test` 包括 import 扫描、随机序列、崩溃注入和长跑测试。
