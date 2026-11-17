# 内核契约

`updated: 2026-11-17`

## 这个模块是干什么的

本页负责四件事：冻结了哪些东西、每个原语为什么在内核、怎样改契约、怎样证明文档足够让人把新功能放对地方。

- 冻结的内核契约：清单、参与启动检查的量、改契约的程序、不算改契约的事。
- 目标和不变量：契约的底座，也是[取舍顺序](kb-extending.md#取舍顺序)判断“推翻不推翻”的依据。
- 原语和它在内核的理由：每个原语上层做的代价。
- 推导测试的做法。
- 风险表。

本页只写“冻结什么”和“怎样改”。每一项的细节在定义它的页，这里只链接，不重抄。

本页不负责：功能放内核还是上层（[kb-extending](kb-extending.md)）、上层的做法（[kb-extras](kb-extras.md)）、每个常量为什么是这个值（各模块页和[决策记录](kb-decisions.md)）。

“内核”是 tau 自己：`src/` 的代码，加上它的文件格式、协议和 CLI。和它相对的是“上层”。

## 架构

### 目标

1. 冻结内核契约。以后 Pi Web 那类功能都在上层做，不再改内核。
2. 功能放在上层，不因此变差：仍然原子、持久、看得见，崩溃后说得清。
3. 内核只做上层做不了、或者做了要付出代价的事（[取舍顺序](kb-extending.md#取舍顺序)）。
4. 功能仍然遵守 YAGNI。原语有两种来由：为真实用过的功能加的；补齐内核对上层的四类自由度的（事实可读、控制对称、动作可组合、参数可传），按类给，不要求用过（[D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)、[kb-extending 的核心原则 8](kb-extending.md#核心原则)）。
5. 判据：推导测试通过（见[推导测试的做法](#推导测试的做法)）。只读文档的 Agent（Sonnet、Haiku 级别）能把文档没写过的新功能放对地方。

### 不变量

这是 v2 实现以后的样子，已经含 v2 自己的新增和例外。[取舍顺序](kb-extending.md#取舍顺序)按这张表判断，下面的契约清单把它冻结。

1. 3 个阶段：`idle`、`awaitingModel`、`awaitingTool`。
2. 2 种副作用：调用模型、运行工具。工具分库内和库外。
3. `effects` 表和信箱的结构。
4. 一条输入一个事务。`decide`、`effectOf`、`observe` 是纯函数。
5. 崩溃后，库外动作报“被中断”，不自动重做。
6. 快照冻结：进程是一份启动时冻结的预设快照。
7. 回信只在一轮结束时寄出，每个进程一封（[kb-kernel 的回信](kb-kernel.md#回信)）。信的 `replyTo` 并进哪一轮（并进 `turn` 的规则也在那里），就由那一轮结束时回，之后的几轮不回。信还在排队时这一轮异常结束，也在这一轮结束时回。
8. 换段是唯一缩短上下文的办法。图片有一个例外（[D40](kb-decisions.md#d40-第-6-步前一半的选择)）。
9. 处理一条输入不读旧段，也不读别的进程的工作段。`fork` 不是处理一条输入：它是协议请求，读源进程的当前段，和 `history` 一样（[D49](kb-decisions.md#d49-fork-进内核)）。
10. 内核不自己删数据。旧段、进程、图片只经三个删除原语删，由上层调用（[D59](kb-decisions.md#d59-删除原语旧段和空闲进程)）。删除原语不碰记忆：记忆的键只经 `Memory` 接口的 `delete` 删，入口是库内工具 `memory_delete`（模型调用或工具定义声明）和协议的 `memory_write`（[D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)）。
11. 服务只在命名管道上监听。

另外不变的规矩：`src/` 的依赖白名单（`extras/` 的依赖不在其中，见 [D63](kb-decisions.md#d63-上层的依赖随便加)）；代码量预算 3600 行（D64 从 3000 放宽；都在 [AGENTS.md](../AGENTS.md#小而硬规矩)）。

### 原语和它在内核的理由

v2 的原语都按[取舍顺序](kb-extending.md#取舍顺序)第 4 条第 3 支进内核：上层做不到，或者上层做会不原子、丢数据。每个原语写出“上层做的代价”。写不出来，它就放上层（[D47](kb-decisions.md#d47-v2-的来由六个缺口和-v1v2-的对照)）。表末 D64 的四行不同：它们按 [kb-extending 的核心原则 8](kb-extending.md#核心原则) 按类给，不经取舍顺序判；代价一列只说明上层为什么补不上。

| 原语 | 负责的页 | 上层做的代价 |
|---|---|---|
| 信件和发送者 | [kb-kernel 的信的头和合并](kb-kernel.md#信的头和合并) | 做不到。信怎样写进工作段，只有 `decide` 能决定 |
| 安全点投递 | [kb-kernel 的安全点投递](kb-kernel.md#安全点投递) | 做不到。什么时候把信写进段，只有 `decide` 能决定 |
| 进程之间：`post`、`spawn`、`stop_process`、回信、跳数 | [kb-store 的进程之间的工具](kb-store.md#进程之间的工具)、[kb-kernel 的回信](kb-kernel.md#回信) | 不原子：用工具定义运行 `tau send`、`tau start`、`tau stop`，也能寄信、建进程、停进程。但它们是库外工具，在做完和写结果之间崩溃，模型看到“被中断”，再做一次。信就重复，子进程就多一个，停止就可能停掉对方后来的一轮。重做有害，所以不放上层。丢数据：回信要和一轮的结束在同一个事务里寄出。上层只能盯着 `watch`，它没在运行时，回信就漏了 |
| 主动换段 | [kb-kernel 的主动换段](kb-kernel.md#主动换段handoff) | 做不到。换段只能由 `decide` 发起 |
| 工具定义 | [kb-tools 的工具定义](kb-tools.md#工具定义) | 做不到。模型能调用哪些工具，只由内核给的工具描述决定。没有工具定义，上层的功能只能让模型自己拼 bash 命令：没有参数说明，没有 bash 的预设也用不了 |
| 内容块和图片 | [kb-service 的图片](kb-service.md#图片)、[kb-store 的图片](kb-store.md#图片)、[kb-kernel 的请求里的图片](kb-kernel.md#请求里的图片) | 做不到。上层没有办法把图片放进模型的上下文 |
| 思考级别 | [kb-executor 的调用模型](kb-executor.md#调用模型actionsts) | 做不到。它是调用模型的参数 |
| 重试 | [kb-executor 的调用模型](kb-executor.md#调用模型actionsts) | 丢数据。上层只能等这一轮出错结束，再寄“继续”。这时回信已经寄出，新的一轮没有 `replyTo`，等回信的父进程拿不到结果。上层没在运行时也不会重试 |
| 累计用量 | [kb-kernel 的累计用量](kb-kernel.md#累计用量) | 丢数据。交接回复和没写进段的回复，用量哪里都没存，上层从段里算不全。上层盯着 `watch` 累加，它没在运行时就漏了 |
| fork（含换角色） | [kb-kernel 的 fork](kb-kernel.md#fork)、[kb-service 的线协议](kb-service.md#线协议srcprotocolts)、[D49](kb-decisions.md#d49-fork-进内核)、[D52](kb-decisions.md#d52-fork-带-preset给进程换角色) | 做不到。上层只能 `history` 读出再 `start`，第一封信最多 `MESSAGE_MAX_BYTES`（32 KiB），带不过去完整的段。本机的 Pi Web 用过 4 次（[D49](kb-decisions.md#d49-fork-进内核)）。带 `preset` 的换角色：上层只能让新进程按需 `history` 读回旧段，慢而且失真，见 [D52](kb-decisions.md#d52-fork-带-preset给进程换角色) |
| 协议：`history`、`blob`、`watch` | [kb-service 的线协议](kb-service.md#线协议srcprotocolts)、[历史和订阅](kb-service.md#历史和订阅) | 做不到：上层只能通过协议看内核，读不了历史，就做不了历史检索；拿不到流式文本，页面就看不到实时输出。慢：没有 `watch`，上层只能反复 `ps`，`ps` 读全部进程，随年头变慢 |
| 删除：`prune`、`remove`、`sweep` | [kb-store 的删除](kb-store.md#删除)、[kb-service 的删除](kb-service.md#删除)、[D59](kb-decisions.md#d59-删除原语旧段和空闲进程) | 做不到。库里的东西只有内核能删；上层停服务直接改库，就绕开了事务和存储层不变量 |
| 事实可读：`inspect`、限度和 `check`、段里消息的 `tau`、`since`、`watch` 推追加的消息、流式预览的种类 | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) | 做不到：快照、排队的信、`replyTo`、跳数只在记录里，上层不读库；阈值要内部常量，抄一份就漂移。丢数据：信并进段以后只剩文字。慢：每走一步都要再读一次段 |
| 控制对称：`memory`、`memory_write`、换段信、`send` 带 `from` 和 `reply`、调用方定的进程 ID | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) | 做不到：记忆只能让模型读写；换段只能请模型调 `handoff`，它可以不照做。丢数据、不原子：一轮的结果要上层盯着转寄；回执丢了再重试，会多建一个进程 |
| 动作可组合：工具定义在结果里声明库内动作 | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) | 不原子：工具里用 `tau send/start/stop`，崩溃后模型重做，信就重复，子进程就多一个（同“进程之间”一行） |
| 参数可传：预设的 `options` | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) | 做不到：它是调用模型的参数，同思考级别 |

### 契约清单

冻结以后，下面这些是契约。每一项只写冻结什么，定义在右边那页。

| 冻结什么 | 定义在 |
|---|---|
| 上面的不变量 | 本页 |
| 类型：`Input`、`Letter`、`Sender`、`Phase`、`Turn`、`Effect`、`ToolResultContent`、`Limits`，`Process`、`PresetSnapshot`、`Projection` 的字段，段里消息的 `tau` 结构。内容块用 pi-ai 1.0.0 的类型。D64 加的字段见 [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) | [kb-kernel 的状态](kb-kernel.md#状态)、[输入、副作用、环境](kb-kernel.md#输入副作用环境)、[投影与命令](kb-kernel.md#投影与命令) |
| `decide` 的输出：新记录、追加的消息、回信 | [kb-kernel 的函数](kb-kernel.md#函数) |
| 行为：回信的时机和正文的算法，`replyTo` 和 `hops` 并进 `turn` 的规则，`endTurn` 的顺序，排队的信的处理（`done` 时合并并开新一轮，只取这批信的 `replyTo` 和 `hops`；不是 `done` 时合并写进段、停在 `idle`） | [kb-kernel 的回信](kb-kernel.md#回信)、[流程：两个辅助步骤](kb-kernel.md#流程两个辅助步骤) |
| 行为：安全点投递 | [kb-kernel 的安全点投递](kb-kernel.md#安全点投递) |
| 行为：`fork` 复制什么（预设快照、当前段的前缀或全部、记忆视图；不复制 `parent`、用量、旧段），新进程的阶段，什么时候拒绝（没有进程、`before` 越界或不是用户消息、不带 `before` 而源进程不是 `idle`、启动检查不通过）。带 `preset` 是换角色：快照和记忆视图用新预设的；新模型不收图片时图片换成 `IMAGE_UNSUPPORTED`；不带锚点的估算要低于新预设的换段阈值，否则拒绝（[D52](kb-decisions.md#d52-fork-带-preset给进程换角色)）。事务：读源进程和当前段、建新进程、写消息，一个事务，抛错回滚 | [kb-kernel 的 fork](kb-kernel.md#fork)、[kb-store 的存储事务](kb-store.md#存储事务) |
| 行为：删除原语。`prune` 删段号小于 `before` 的旧段，当前段永不删，`before` 大于当前段号拒绝。`remove` 在进程不是 `idle`、信箱里有它的输入、有进程的 `parent` 是它、它在 `turn.replyTo` 或排队的信的 `replyTo` 里、执行器还有它的动作没收尾时拒绝，拒绝时什么都不删。`sweep` 的引用收自三处：全部进程的全部段、信箱、进程记录里的 `turn.queued`。`history` 读已删的段回 `error`。`remove` 先推 `removed` 再回执 | [kb-store 的删除](kb-store.md#删除)、[kb-service 的删除](kb-service.md#删除) |
| 行为：停止的语义、跳数怎样增加 | [kb-kernel 的流程](kb-kernel.md#流程每种输入)、[kb-store 的进程之间的工具](kb-store.md#进程之间的工具) |
| 行为：bash 工具正常结束时，不结束命令留在后台的进程。上层的配方靠它 | [kb-tools 的退出之后](kb-tools.md#退出之后排空和后台进程) |
| 行为：换段信什么时候生效、什么时候作废；工具定义声明的库内动作在哪个事务里、按什么条件和顺序执行、能声明哪些；`send` 带 `from` 的信怎样构造、什么时候拒绝；调用方定的进程 ID 的字符集和“已存在”的拒绝；`check` 和 `start` 走同一条读预设的路径（读预设时的拒绝只加在 `loadPreset`、`loadToolDefs`、`startError` 里） | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) |
| 演进：`Process`、`PresetSnapshot`、`Letter`、`Turn`、`Request`、`Reply` 和段里消息的 JSON 只加可选键，客户端忽略不认识的键 | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) |
| 事务清单，以及每个事务做什么（D64 加第 8 个 `writeMemory`；`handleNext` 先执行工具结果里声明的库内动作） | [kb-store 的存储事务](kb-store.md#存储事务)、[处理一条输入](kb-store.md#处理一条输入)、[kb-executor 的一行的一生](kb-executor.md#一行的一生) |
| `effects` 和 `mailbox` 的规则 | [kb-store 的同步副作用](kb-store.md#同步副作用)、[存储层不变量](kb-store.md#存储层不变量)、[kb-executor 的一行的一生](kb-executor.md#一行的一生) |
| 线协议：管道名和分帧，包括“客户端不能半关闭”；`Request`（含 `fork`、`prune`、`remove`、`sweep`，D64 的 `inspect`、`check`、`memory`、`memory_write` 和各请求新加的可选字段）、`Reply`（含 `removed`、`swept`，D64 的 `process`、`inspected`、`check`、`memory`、`namespaces`、`memory_written`、`memory_rejected`）；`fork` 的回执在提交之后、订阅的 `update` 之后；`history` 每行的消息格式和结束行；`watch` 的推送规则（先快照后增量；`update` 只带 `self`；流式文本带进程和编号；不推最终回复；写缓冲超限就断开） | [kb-service 的线协议](kb-service.md#线协议srcprotocolts)、[历史和订阅](kb-service.md#历史和订阅)、[坑点](kb-service.md#坑点) |
| 表结构。索引不算（见[不算改契约](#不算改契约)） | [kb-store 的表](kb-store.md#表) |
| 文件格式：预设（含 D64 的 `options`） | [设计稿第 2 节](../docs/design/mvp.md#2-预设) |
| 文件格式：工具定义 | [kb-tools 的工具定义](kb-tools.md#工具定义) |
| 工具定义的运行（原文在这一节），含 D64 的 `call` 项 | [kb-tools 的运行工具定义](kb-tools.md#运行工具定义) |
| 环境变量：`TAU_PROCESS`、`TAU_PIPE` | [kb-tools 的包装脚本](kb-tools.md#包装脚本)、[kb-service 的启动脚本和入口](kb-service.md#启动脚本和入口) |
| CLI：v1 的命令、输出和退出码，加上 `TAU_PIPE`。入口是仓库里的 `tau`、`tau.cmd` 和 `node src/main.ts` | [kb-service 的 CLI](kb-service.md#clisrcclimaints)、[启动脚本和入口](kb-service.md#启动脚本和入口) |
| `decide` 写进段的固定文字：信的头、结束原因的文字、D25 的说明、`HANDOFF_HEADER`、`CARRY_HEADER`、`INTERRUPTED`、`SKIPPED`、图片的占位行。还有段里消息的 `tau` 结构：上层显示“谁说的”，读它，不解析文字（[D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)） | [kb-kernel 的信的头和合并](kb-kernel.md#信的头和合并)、[结束原因的文字](kb-kernel.md#结束原因的文字)、[常量](kb-kernel.md#常量)、[请求里的图片](kb-kernel.md#请求里的图片)、[kb-store 的图片](kb-store.md#图片) |
| 内置工具和工具组的名字。工具定义不能和它们重名，所以加一个内置工具，会让用户已有的同名定义启动失败 | [kb-kernel 的工具描述](kb-kernel.md#工具描述) |
| 入口条件：图片检查的全部条件（张数、大小、类型按魔数收 png、jpeg、gif、webp、尺寸） | [kb-service 的图片](kb-service.md#图片) |
| 入口条件：`MESSAGE_MAX_BYTES`、`HOPS_MAX` | [kb-kernel 的常量](kb-kernel.md#常量) |
| 入口条件：`TOOL_DEF_MAX_BYTES`、`TOOL_DEFS_MAX_BYTES`、工具定义 `timeout` 的范围 | [kb-tools 的工具定义](kb-tools.md#工具定义) |
| 入口条件：`CALLS_PER_RESULT`、`OPTIONS_MAX_BYTES`、`options` 的白名单和各键的类型、进程 ID 的字符集 | [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作) |

入口条件的松紧：

- 收紧算改契约，包括删类型、加新的拒绝条件。
- 放宽 `HOPS_MAX`、`TOOL_DEF_MAX_BYTES`、`TOOL_DEFS_MAX_BYTES`、工具定义 `timeout` 的范围、`CALLS_PER_RESULT`、`OPTIONS_MAX_BYTES`，以及跟着 pi-ai 给 `options` 的白名单加键，不算改契约，先在决策记录写理由。
- 放宽 `MESSAGE_MAX_BYTES` 和图片的条件（含加图片类型），先做下面“参与启动检查的量”里写的检查。

### 参与启动检查的量

启动检查和阈值除了快照，还用到下面这些。它们从代码现取，不在快照里：

- `MESSAGE_MAX_BYTES`、`IMAGES_PER_MESSAGE`、`IMAGE_TOKENS`、`MARGIN_TOKENS`、`BYTES_PER_TOKEN`、`outputMax` 占窗口的比例（1/8）：决定 R 和阈值（[kb-kernel 的换段阈值](kb-kernel.md#换段阈值)）。
- 预设的 `handoff` 不在这一类：它冻结在快照里，不是从代码现取，改预设文件只影响新启动的进程（[D51](kb-decisions.md#d51-预设加-handoff换段阈值只能调低)）。
- `MEMORY_VIEW_MAX_BYTES`：决定启动检查里记忆的上界（[kb-memory](kb-memory.md#上限)）。
- 系统提示词的拼法（工作目录那一行、记忆的标题），内置工具的描述和参数：算进固定部分（[kb-kernel 的启动检查](kb-kernel.md#启动检查和交接以后的检查)）。

改这些量时：

- `BYTES_PER_TOKEN` 调小、其余调大，阈值就降低，或者启动检查更严。已经启动的进程跟着变，原来能启动的预设也可能启动失败。
- 改其中任何一样之前，用现有的预设和库里全部进程的快照重算启动检查，空闲的进程也算。有不通过的，按改契约处理。
- 放宽 `IMAGE_MAX_EDGE`、`IMAGE_MAX_BYTES` 之前，先重量 `IMAGE_TOKENS`（量法见 [D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)，文档估算见 [D48](kb-decisions.md#d48-量-image_tokens-的文档估算和思考级别重试的需求来源)）。
- 调大 `IMAGE_MAX_BYTES` 或 `IMAGES_PER_REQUEST` 之前，先重算请求上界：张数 × 字节上限 × 4/3，再加上文字。结果不能超过在用 provider 的请求上限，例如 Anthropic 的 32 MiB、Google 的 20 MiB。
- 加图片类型之前，先核实在用的模型收它（核实过什么见 [D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)）。

### 改契约的程序

改契约，要先在决策记录里写清两件事：

1. 上层为什么做不到，或者要付出[取舍顺序](kb-extending.md#取舍顺序)里的哪一种代价。
2. 推导测试的结果：按[推导测试的做法](#推导测试的做法)出新题，并通过。

### 不算改契约

- 修 bug。契约里写的行为不算 bug。
- 调内部的常量：没在上面列出的常量都是内部常量，例如 `WATCH_BUFFER_MAX`、`MODEL_RETRIES`、`STEPS_PER_TURN`。`IMAGES_PER_REQUEST` 和每批省略的张数也是；调大前者之前，先按上面重算请求上界。
- 放宽上面写明可以放宽的入口条件。
- 跟着 pi-ai 改适配，消息 JSON 不变时。
- 不改接口的性能优化，包括加索引。索引由 `openDb` 每次打开时用 `CREATE INDEX IF NOT EXISTS` 补上，不提高 `SCHEMA_VERSION`。对 `state_json` 的表达式索引也一样。
- `ps` 和 `self` 随进程数变慢：`self` 要数空闲的子进程，仍然读全部记录。真的变慢时加索引、改查询。

### 推导测试的做法

推导测试检验文档，不检验代码：只读文档的 Agent，能不能把一个文档没写过的新功能放对地方。第一次是冻结前的最后一步，以后改契约、重测时都照这个做法。

**出题的时机**

- 文档改完、提交，记下提交号，然后再出题。这样文档不会照着题目写。
- 测试时，受试者读的就是记下的那个提交，只多决策记录里 sha256 那一行。
- 出题以后要改文档，这批题作废，改完重新出题。

**题目的要求**

- 写定 5 个功能、每个的正确落点和理由、评分标准。
- 每道题写明本机的使用情况：这个功能和它的各个部分，用没用过、用过几次。受试者查不到会话记录，取舍顺序的第 2 条和第 4 条第 2 支都靠它。使用情况按全部 `.piweb` 目录统计（[D54](kb-decisions.md#d54-使用数据重核)）。
- 题目只出受试者的文件清单里没给过落点的功能。凡是文件清单里的文档写过落点的，都算给过：设计稿第 5、6、8 节（搬走以后，是接手它们的页）、kb-extending 的方向表、决策记录、kb-piweb-lessons、mvp.md 的“MVP 不做”。以前推导测试的题目也算。
- 每次测试都出新题。没通过以后的重测、改契约，都一样。

**题目放哪里**

- 写定的文件放在仓库外。决策记录里先只记它的 sha256。
- 测完再把题目、答卷、判分和结论并进决策记录。并进以后，这些题就作废。

**受试者**

- 受试者是 Claude Code 的子 Agent，Sonnet 和 Haiku 各答一次。不经 tau，不用 pi 的凭据。
- 子 Agent 只给 Read、Grep、Glob，不给 Bash。
- 读取只放行仓库目录：写定的题目和历次审阅的记录都在仓库外。
- 给它的提示只有题目、本机使用情况和文件清单：AGENTS.md、INDEX 和它们链接的文档。

**通过线**

- 每个功能的关键点全对才算推对。
- Sonnet 和 Haiku 都把 5 题全部推对，才算通过。
- 通过线不随题目改。

## 决策

- 契约的范围、不变量合成一张表：[D26](kb-decisions.md#d26-内核-v2-的方向和准入原则)。
- v2 的来由、六个缺口：[D47](kb-decisions.md#d47-v2-的来由六个缺口和-v1v2-的对照)；文档估算和需求来源：[D48](kb-decisions.md#d48-量-image_tokens-的文档估算和思考级别重试的需求来源)。
- 为什么冻结，以及冻结的判据是推导测试：[D26](kb-decisions.md#d26-内核-v2-的方向和准入原则)、[D28](kb-decisions.md#d28-v2-的原语)。
- 推导测试的记录：[D55](kb-decisions.md#d55-推导测试第一次)、[D56](kb-decisions.md#d56-推导测试第二次)没通过，[D57](kb-decisions.md#d57-推导测试第三次)通过，契约从那里起冻结。为 D59 改契约做的：[D60](kb-decisions.md#d60-推导测试第四次)、[D61](kb-decisions.md#d61-推导测试第五次)、[D62](kb-decisions.md#d62-推导测试第六次)没通过，用户决定不等通过就合并（D59 的破例）。为 D64 改契约做的：[D65](kb-decisions.md#d65-推导测试第七次)、[D66](kb-decisions.md#d66-推导测试第八次)没通过，[D67](kb-decisions.md#d67-推导测试第九次)通过。
- 删除原语是冻结以后第一次改契约，见 [D59](kb-decisions.md#d59-删除原语旧段和空闲进程)。第二次是内核的四类自由度，见 [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)，它也改了目标 4。
- 常量的状态（已定、暂定）只写在 [kb-kernel 的常量](kb-kernel.md#常量)的表里，这里不重复。
- 常量的出处：`IMAGE_TOKENS` 见 [D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)；图片的其余常量和 `HOPS_MAX` 见 [kb-kernel 的常量](kb-kernel.md#常量)和 [kb-service 的图片](kb-service.md#图片)；`MESSAGE_MAX_BYTES` 见 [D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)；工具定义的两个上限见 [kb-tools 的工具定义](kb-tools.md#工具定义)。
- `WATCH_BUFFER_MAX`、`MODEL_RETRIES` 和 OAuth 订阅：[未确认的默认值](kb-decisions.md#未确认的默认值)。

## 认知模型

判断一个改动算不算改契约，按顺序问四个问题：

1. 它动的是[入口条件](#契约清单)里写明可以放宽的量吗？是，先按[入口条件的松紧](#契约清单)做完检查，再在决策记录写理由，不算改契约。这一问是第 2 问的例外，先问它。
2. 它动的东西，在上面的契约清单里吗？在，就是改契约。
3. 它动的是[参与启动检查的量](#参与启动检查的量)吗？是，先用现有的预设和库里全部进程的快照重算启动检查。有不通过的，按改契约处理。
4. 它是内部常量、修 bug、适配 pi-ai 或不改接口的性能优化吗？是，不算。调大 `IMAGES_PER_REQUEST` 之前，先重算请求上界。

拿不准的，按改契约处理：先写决策记录，再做推导测试。

## 投影与命令

本页不新增状态，不新增命令。契约清单里的投影字段和 CLI 的命令，见 [kb-kernel 的投影与命令](kb-kernel.md#投影与命令)和 [kb-service 的 CLI](kb-service.md#clisrcclimaints)。

## 入口

没有源码。契约靠这些测试守住，它们都在[完成门槛](../AGENTS.md#完成门槛)里：

- `npm test` 里的 import 扫描：纯函数层只导入 kernel 内部的文件（[kb-kernel](kb-kernel.md#入口)）。
- 随机序列、崩溃注入、长跑测试：[kb-kernel](kb-kernel.md#入口)、[kb-executor](kb-executor.md#入口)。
- 服务测试：线协议和 CLI 的行为（[kb-service](kb-service.md#入口)）。

## 坑点

- **契约清单里的常量和快照里的量，不是一回事。** 快照冻结的是预设；启动检查用到的常量从代码现取（见[参与启动检查的量](#参与启动检查的量)）。改常量会让已经启动的进程跟着变。
- **“放宽不算改契约”有边界。** 只有上面逐条写明的量可以放宽。没写明的入口条件，收紧和放宽都算改契约。
- **推导测试的题目不能留在仓库里。** 受试者能读到，下次就不准了。

### 风险表

| 风险 | 对策 |
|---|---|
| 一次设计多个原语，抽象设计错 | 推导测试；按[执行清单](../docs/plan/kernel-v2-checklist.md)逐个实现 |
| 库越长越大：内核不自己删；上层不清理，库照样一直长 | 上层用三个删除原语定清理策略（[D59](kb-decisions.md#d59-删除原语旧段和空闲进程)）。`sweep` 扫全库，期间服务停着。库文件不缩小：删掉的页被新数据复用，要缩小就停服务做 `VACUUM` |
| 安全点投递改变了模型看到的消息形状 | 第 3 步核实在用的模型（[D34](kb-decisions.md#d34-第-3-步真模型核实)），第 7 步再核实带图的工具结果（[D45](kb-decisions.md#d45-第-7-步带图的工具结果的真模型核实)）。换到没核实过的模型，按 [kb-executor 的坑点](kb-executor.md#坑点)核实 |
| `spawn` 的扇出没有上限，进程和花费暴涨 | 跳数只挡循环。只给需要的预设 `agents` 和能运行命令的工具。上层用 `watch` 和 `stop` 尽力而为地停，只能数在运行的后代；本机没出现过失控，Pi Web 的上限只触发过 4 次，都挡在一次有意的大扇出上（[kb-extras](kb-extras.md#pi-web-的功能在-v2-上的做法)） |
| 子预设没有 `agents`，递归也不一定停 | 子预设没有 `agents`，也不能运行它控制的命令时，递归才在它这一层停住。bash、运行模型所给脚本的工具定义（如 codemode）、命令里调用 `tau` 的工具定义、在结果里声明 `spawn` 的工具定义（D64）、运行它能用 `write` 或 `edit` 改的文件的工具定义（如 `npm test`），都能运行 `tau start`，建出不挂在树上的进程 |
| 子进程的模型调用卡住，父进程永远等不到回信 | 模型调用没有超时，这是 v1 已有的行为。用户用 `tau stop` 停掉子进程，父进程收到“被停止”的回信 |
| `spawn` 在事务里读文件。工作目录在网络路径上时，查目录可能卡住几十秒，期间所有进程都等着 | 预设的工作目录用本机路径 |
| 图片文件头完好、数据损坏，进段后每次调用模型都失败 | 用 `history` 读出，再 `start` 一个新进程 |
| `IMAGE_TOKENS` 低于真实值，阈值证明不成立 | 在在用的模型上量（[D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)）；换成没量过的模型先量（用户没许真调用的模型的例外，见 [kb-executor 的坑点](kb-executor.md#坑点)） |
| 目录写着收图片，接口却拒绝 | 第 6 步核实过（[D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)、[D45](kb-decisions.md#d45-第-7-步带图的工具结果的真模型核实)）：在用的模型都没有被拒。换到没核实过的模型或类型，按 [kb-executor 的坑点](kb-executor.md#坑点)核实 |
| 64K 窗口的预设收图片，带图的信赶上换段时图会丢 | [kb-kernel 的坑点](kb-kernel.md#坑点) |
| 固定部分离阈值不到一份交接说明 | 交接以后的检查：每封信只交接一次就出错，报出各部分的数字。快照冻结，卡住的进程改不了：用缩小了提示词或工具定义的预设、或者大窗口的模型，新启动一个进程。记忆占得多时，也可以先用同一预设的另一个进程删掉一些记忆，下一次交接用新的记忆视图 |
| 重试只覆盖拿到成功的响应之前的错误 | 流式输出中途的错误，本轮出错结束。这比 Pi SDK 弱：它按最终消息判断要不要重试 |
| 预算路径上回答只剩 1,024 | 算法见 [kb-executor 的调用模型](kb-executor.md#调用模型actionsts)；换模型时先算 |
| 不发输出上限的 API（openai-codex-responses），总输出可能超过 `outputMax` | 不支持。tau 本来也调不了它 |
| 工具定义的 schema 内层不合法，进程第一次调用模型就失败 | 改文件，`start` 新进程。上层的中转生成定义时负责规整 schema |
| 工具定义冻结进每个 `state_json`，`self` 和 `ps` 变慢 | 定义有大小上限；真的变慢时加表达式索引 |
| `tau.cmd` 把正文里的 `&` 当成命令 | 外部程序直接连管道；bash 里用 `tau` 脚本；计划任务直接运行 node |
| 代码量超出预期 | 每步完成时校准；超出 3600 行（D64）先停下来复查设计 |

## 关联模块

- [AGENTS.md](../AGENTS.md)：摘要和改契约的程序。
- [kb-extending.md](kb-extending.md)：取舍顺序，按本页的不变量判断。
- [kb-kernel.md](kb-kernel.md)、[kb-store.md](kb-store.md)、[kb-executor.md](kb-executor.md)、[kb-tools.md](kb-tools.md)、[kb-service.md](kb-service.md)：契约清单里每一项的定义。
- [kb-decisions.md](kb-decisions.md)：改契约先写在这里；推导测试的题目和结论也并进这里。
