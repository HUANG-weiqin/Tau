# 纯函数层

`updated: 2026-11-18`

## 这个模块是干什么的

纯函数层是 `src/kernel/` 里的类型和纯函数。它不存任何东西。

它负责：

- 进程记录、阶段、输入、副作用、环境的类型。
- `start`、`decide`、`effectOf`：一条输入怎样改变进程记录和工作段，进程在等哪个副作用。
- 派生值：上下文用量、输出上限、换段阈值、待执行的工具调用、本段开始时间、最终回复、结束原因的文字。
- `buildContext`：模型请求。
- `observe`：投影。
- 工具描述：名称、参数、库内还是库外。包括会话快照里的工具定义。

它不负责：

- 读写库、处理输入的事务、同步待办副作用表：[kb-store.md](kb-store.md)。
- 读上下文文件、拼上下文视图：[kb-store.md](kb-store.md#上下文文件视图)。`reconfigure` 请求的校验和新快照的构造：[kb-service.md](kb-service.md#会话配置reconfigure)。
- 执行库外副作用：[kb-executor.md](kb-executor.md)。
- 工具的行为：[kb-tools.md](kb-tools.md)。记忆的语义和上限：[kb-memory.md](kb-memory.md)。
- 把投影格式化成文本：`self` 见 [kb-store.md](kb-store.md#self)，`tau ps` 见 [kb-service.md](kb-service.md#tau-ps-的文字格式)。

本页接管[设计稿](../docs/design/mvp.md)第 4.1 到 4.3 节和第 5 节的细节。纯度规则在 [AGENTS.md](../AGENTS.md)，由 `test/kernel-imports.test.ts` 检查（见 [D15](kb-decisions.md#d15-工具链没有构建步骤)）。

## 架构

### 状态

进程的状态 = 进程记录 + 当前工作段。两者都在库里。

```ts
interface Process {
  id: ProcessId;
  preset: PresetSnapshot;            // 会话快照：出生时由预设读成，之后属于这个会话（D71）
  next?: PresetSnapshot;             // 待换配置：换段时生效；没有就没有这个键
  createdAt: Instant;                // 毫秒时间戳
  segment: { seq: number; memoryView: string; contextView?: string };
  lastEffect: number;                // 最后发出的副作用编号，从 0 开始
  phase: Phase;
  parent?: ProcessId;                // 建好后不变；CLI 建的进程没有
  usage: Usage;                      // 累计用量；新进程全是 0
  since?: Instant;                   // 进入当前阶段、或发出当前副作用的时刻；旧记录没有
}

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

type Sender = { kind: "user" } | { kind: "process"; id: ProcessId; preset: string; reply?: { ended: Ended } };
interface Letter { from: Sender; content: Content[]; hops: number; replyTo?: ProcessId; handoff?: true }   // handoff：换段信，只由协议的 send 产生
type Content = TextContent | ImageContent;   // pi-ai 的类型

interface Turn { steps: number; queued: Letter[]; hops: number; replyTo: ProcessId[] }
type Purpose = "turn" | "handoff";

type Phase =
  | { tag: "idle"; ended?: Ended }   // ended 缺省：这个进程自己还没跑过一轮
  | { tag: "awaitingModel"; turn: Turn; purpose: Purpose }
  | { tag: "awaitingTool"; turn: Turn };

type Ended = "done" | "stepLimit" | "stopped" | { error: string };
```

- `PresetSnapshot` 有 `id`、`workdir`、`model`（`<provider>/<model-id>`）、`tools`、`prompt`、`contextWindow`、`input`（模型能收的输入，`text` 和 `image` 的子集），还有可选的 `thinking`（pi-ai 的思考级别，预设没写就没有这个键）和可选的 `handoff`（换段阈值的上限，正整数，单位 token，预设没写就没有这个键，见[换段阈值](#换段阈值)）和可选的 `options`（见[预设选项](#预设选项)）和可选的 `context`（上下文文件的路径，字符串数组，写的原样，没写就没有这个键，见[上下文文件](#上下文文件开段重读)）。`tools` 是 `read`、`write`、`edit`、`bash`、`memory`、`agents` 的子集：`agents` 是一组工具（`post`、`spawn`、`stop_process`），不是单个工具。`toolDefs` 是预设 `tools` 里写的工具定义（`ToolDef`：`name`、`description`、`parameters`、`command`、`timeout`、`output`，默认值已补上），按写的顺序；没用时是空数组。预设的 `tools` 一行里，内置工具进 `tools`，其余的名字都是工具定义，进 `toolDefs`（[D43](kb-decisions.md#d43-第-7-步前一半工具定义的格式读取和冻结)）。预设文件的格式见[设计稿第 2 节](../docs/design/mvp.md#2-预设)，工具定义的格式见 [kb-tools](kb-tools.md#工具定义)。
- 快照的键分两类（[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)）：调用参数是 `thinking`、`options`、`handoff`，改了立即生效；结构性字段是其余所有键（`id`、`workdir`、`model`、`tools`、`toolDefs`、`prompt`、`contextWindow`、`input`、`context`），改了在换段时生效。规则见[流程：会话配置](#流程会话配置reconfigure)。
- `next` 是待换配置：`reconfigure` 改了结构性字段、又不能马上采用时，存在这里；换段被接受时它才变成 `preset`。没有待换配置时没有这个键。投影的 `self.pending` 列出它和 `preset` 差在哪些字段。`fork` 不复制它。
- `segment.memoryView` 是开段那一刻的记忆视图，`segment.contextView` 是开段那一刻的上下文视图（[上下文文件](#上下文文件开段重读)）。以后算不出来，所以存。`contextView` 缺省和空串都表示没有上下文文件。开段指建进程和每次换段被接受。
- `turn.steps` 必须存：一轮可以跨越换段。
- `turn.queued` 存信件原样，写进段时才渲染。`turn.hops` 是本轮已经写进段的信的最大跳数，`turn.replyTo` 是本轮结束时要寄回信的进程，去重。并进 `turn` 的规则见[回信](#回信)。
- `Letter.hops` 是这封信被进程之间的信一路引出来的跳数。CLI 寄来的信 `hops` 为 0，没有 `replyTo`。`replyTo` 有值时，处理这封信的那一轮结束时把最终回复寄给它。
- `since`（D64 第 4 组）：`start`、`fork` 写建进程的时刻；`enter`（发出副作用、进入等待阶段）和 `endTurn`（回到 `idle`）写 `env.now`，`decide` 仍是纯函数。运行中排队的信、空闲时的 `stop`、编号对不上被忽略的结果都不动它。模型出错或被停止时段里不写消息，进入 `idle` 的时刻从段里算不出来，所以存。结束时有排队的信、接着开新一轮，走 `enter`，是新一轮发出调用的时刻。投影的 `ProcessView.since` 照抄它，旧记录没有就没有这个键。
- `parent` 由 `spawn` 设置，投影会带出来。`usage` 的累加规则见[累计用量](#累计用量)。
- `purpose` 存在阶段里：它保存进入等待时的决定。
- 进程在等的副作用编号就是 `lastEffect`，阶段里不另存。
- 工作段的消息是 pi-ai 的 `UserMessage`、`AssistantMessage`、`ToolResultMessage`。
- `Memory` 接口的类型也在 `types.ts`。语义见 [kb-memory.md](kb-memory.md#接口)。

### 输入、副作用、环境

```ts
type Input =
  | { kind: "letter"; letter: Letter }
  | { kind: "modelResult"; n: number; outcome: { status: "ok"; message: AssistantMessage } | { status: "interrupted" } }
  | { kind: "toolResult"; n: number; outcome: { status: "ok"; content: ToolResultContent; calls?: DeclaredCall[] } | { status: "interrupted" } }
  | { kind: "stop" }
  | { kind: "reconfigure"; preset: PresetSnapshot };   // 新的会话快照，服务算好、已过启动检查（D71）

interface ToolResultContent { content: Content[]; isError: boolean }
interface DeclaredCall { name: string; arguments: Record<string, unknown> }

type Effect =
  | { kind: "callModel"; n: number; purpose: Purpose }
  | { kind: "runTool"; n: number; call: ToolCall };

interface Env { now: Instant; memoryView: string; fresh?: { memoryView: string; contextView?: string } }
```

- 输入不带 ID 和时间。事务保证恰好处理一次，时间来自 `Env.now`。
- 模型失败写在助手消息的 `stopReason` 和 `errorMessage` 里，没有单独的输入。
- 工具失败是工具结果的 `isError`。
- `calls` 只由执行器原样转交工具定义 content 输出里的声明；存储层在 `decide` 之前执行并去掉它，`decide` 不读它（[kb-store](kb-store.md#声明的库内动作)）。
- `Env.memoryView` 是这个进程的记忆库现在的视图，没有记忆库时为空。`decide` 只在开段时用它。
- `Env.fresh` 是“可能被采用的那份快照”的开段视图：记忆视图和上下文视图。`decide` 在两处用它：`reconfigure` 直接采用快照，换段被接受。存储层只在需要的两种输入上算，别的输入没有这个键（算在哪、读什么见 [kb-store](kb-store.md#处理一条输入读什么)）。`contextView` 缺省表示没有上下文文件。`env.fresh` 缺省时 `decide` 不抛错：记忆视图用 `env.memoryView`，没有上下文视图。出生处（`start`）的上下文视图不放进 `Env`，是 `start` 的第 4 个参数：`env.fresh` 只用于换配置和换段。`reconfigure` 输入的字段名叫 `preset`，不叫 `process`（见[坑点](#坑点)）。

### 函数

| 函数 | 文件 | 做什么 |
|---|---|---|
| `start(id, preset, env, contextView = "")` | `decide.ts` | 建一个 `idle` 进程：段号 1，`lastEffect` 为 0，`createdAt` 取自 `env`。记忆视图取 `env.memoryView`，上下文视图是第 4 个参数；两个视图都由调用方读好交给它，不在纯函数层读。`contextView` 是空串（缺省）时 `segment` 里没有这个键 |
| `fork(id, source, seg, before, now, to?)` | `decide.ts` | 从源进程的当前段分叉出新进程：返回 `{ process, messages }`，规则见 [fork](#fork)。带 `to`（新预设的快照、记忆视图，和可选的上下文视图）是换角色。不合格就抛错 |
| `decide(p, seg, input, env)` | `decide.ts` | 返回 `{ process, append, out }`，不发出副作用。`out` 是要寄的回信：`{ to, letter }[]`。五种输入都在一个穷尽的 `switch` 里 |
| `effectOf(p, seg)` | `decide.ts` | `idle`：`null`。`awaitingModel`：`callModel(lastEffect, purpose)`。`awaitingTool`：`runTool(lastEffect, 第一个待执行的调用)` |
| `buildContext(p, seg)`、`tailStart(seg)`、`omitOldImages(messages)` | `context.ts` | 模型请求；段末用户消息的起点；请求里成批省略旧图 |
| `observe(p, seg, siblings, now)` | `observe.ts` | 投影 |
| `toolsFor(preset)`、`findTool(preset, name)` | `tools.ts` | 工具描述，含工具定义。参数只要 `tools` 和 `toolDefs` |
| `contextUsed`、`messageBytes`、`tokens`、`outputMax`、`handoffThreshold`、`resultReserve`、`fixedTokens`、`limits`、`startError`、`newSegmentUsed`、`pendingCalls`、`handoffRequested`、`segmentStartedAt`、`usageOf`、`clip`、`utf8Bytes` | `derive.ts` | 派生值和字节工具 |
| `finalReply(seg)`、`endedText(ended)`、`endedReason(error)` | `derive.ts` | [最终回复](#最终回复)；[结束原因的文字](#结束原因的文字) |

``decide` 的输出约定：

- `append` 一律写进 `process.segment.seq` 那一段。
- 段号最多加一。段号变了，`append` 就是新段的全部消息。
- 交接回复不写进旧段。换段前已有要追加的消息时，`decide` 抛错。所以一次只写一段。
- 只有 `enter` 让 `lastEffect` 加一。一次 `decide` 最多进入一次等待阶段。
- `out` 是要寄出的回信，只在 `endTurn` 里产生，规则见[回信](#回信)。存储层在同一个事务里把它们放进收件人的信箱（[kb-store](kb-store.md#处理一条输入)）。`decide` 自己不碰信箱。

`buildContext`：

- 系统提示词由四部分连接：预设提示词；`工作目录：<workdir>`；上下文视图不为空时，`## 上下文文件（开段时的快照）` 加视图；记忆视图不为空时，`## 记忆（开段时的快照）` 加视图。`systemPrompt(p)` = 固定部分（前两项）+ 上下文一节 + 记忆一节，上下文在记忆前面。每一节是空行、标题、空行、视图；标题常量放在 `context.ts`，和 `MEMORY_HEADING` 并排。视图取自 `p.segment`。
- 工具：`toolDescriptions(preset)`，只放 `name`、`description`、`parameters`。工具定义的 `command`、`timeout`、`output` 不给模型。交接调用带同样的工具，请求前缀不变。
- 消息就是工作段。`awaitingModel(handoff)` 时：
  - 去掉段末连续的用户消息（从 `tailStart` 起）。下标 0 总保留：第一条消息是写交接说明的依据。段末没有用户消息时什么都不去掉。
  - 末尾加一条不入库的用户消息 `HANDOFF_INSTRUCTION`。时间戳取保留下来的最后一条消息的，段空时取 `createdAt`。
- 去掉的消息在换段成功时原样带到新段（见[流程：换段](#流程换段)）。为什么不能带进交接请求，见坑点。

### fork

`fork(id, source, seg, before, now, to?)` 是纯函数：从源进程当前段分叉出一个新进程。它不是处理一条输入，不经过 `decide`。协议请求和事务见 [kb-service](kb-service.md#线协议srcprotocolts)、[kb-store](kb-store.md#存储事务)，为什么在内核见 [D49](kb-decisions.md#d49-fork-进内核)，换角色见 [D52](kb-decisions.md#d52-fork-带-preset给进程换角色)。

新进程：

- 预设快照：原样复制源进程的 `preset`（含 `toolDefs`、`input`、`thinking`、`handoff`、`options`、`context`），不重读预设文件。只复制 `preset`，不复制 `next`：新进程没有待换配置，用的是源进程现在的快照。对象用字面量建，不展开源进程的记录。
- 第 1 段：`before` 是当前段里一条用户消息的段内序号，也就是 `history` 每行的 `seq`。带 `before` 时，消息是序号小于 `before` 的全部消息；不带时是当前段的全部消息。原样复制，图片的 `blob:` 引用照用。
- `segment.memoryView` 和 `segment.contextView`：复制源进程当前段的，所以系统提示词和源进程一样。
- 阶段：带 `before` 时是不带结束原因的 `idle`。不带时复制源进程的 `idle`（含结束原因），下一封信前面的“上一轮的说明”就和源进程一样。
- 没有 `parent`，`usage` 从 0 开始，`lastEffect` 为 0，`createdAt` 是 `now`。
- 只复制当前段，不复制旧段。

拒绝（抛错）：

- 带 `before`：`before` 超出当前段的范围，或者那条消息不是用户消息。在一条用户消息之前切，前面一定停在一轮的结尾或一批工具结果之后（工具结果都在安全点之前写完或补完），所以源进程正在运行也能 fork。
- 不带 `before`：源进程不是 `idle`。运行中的段末尾可能是一条还没有结果的工具调用。

启动检查（[启动检查和交接以后的检查](#启动检查和交接以后的检查)）在存储层做，和 `start`、`spawn` 一样。

#### 带 `to`：换角色

不带 `to` 时上面都不变。带 `to = { preset, memoryView, contextView? }` 时，新进程带着完整上下文换预设，调用方在纯函数层之外读好 `to`：

- `preset` 是新预设的快照，`segment.memoryView` 是 `to.memoryView`，`segment.contextView` 是 `to.contextView`，都不用源进程的。`to.contextView` 可以不给，空串也一样：新进程没有 `segment.contextView` 这个键，不退回去用源进程的。其余字段和消息的取法同上，`before` 的规则也同上。
- 新模型不收图片（`preset.input` 不含 `image`）：复制的用户消息和工具结果里，每张图在原位置换成 `IMAGE_UNSUPPORTED`，和同一条消息里的文字用换行连成一段。用户消息成字符串，工具结果成一个文本块，所以[消息的两种形状](#消息的两种形状)不变。没有图片的消息原样；新模型收图片也原样。换段时采用待换配置，带过去的用户消息也用同一段代码（[换段时采用待换配置](#换段时采用待换配置)）。
- 大小检查：不带锚点的估算 `estimatedUsed`（系统提示词、工具描述和全段按 `BYTES_PER_TOKEN`，图片按 `IMAGE_TOKENS`，按新进程算），要低于新预设的 `handoffThreshold`（含 `handoff`）。否则抛错，报出估算和阈值。不用 `contextUsed` 的用量锚点：锚点是旧模型、旧固定部分的用量，和新进程的请求对不上。超过阈值时第一次调用就是交接调用，带着整段，换到小窗口会失败，所以在这里拒绝。

### 预设选项

- 预设的 `options` 是一行 JSON 对象，不超过 `OPTIONS_MAX_BYTES`（4096 字节，按字节算），读进会话快照的 `options`。`{}` 等于不写，快照里没有这个键。类型是 `PresetOptions`，从 pi-ai 的 `SimpleStreamOptions` 里 `Pick`。
- 检查在 `loadPreset`，所以 `start`、`fork`、`spawn`、`check` 的拒绝一致。白名单和类型：`temperature`（有限数）、`cacheRetention`（`none`、`short`、`long`）、`transport`（`sse`、`websocket`、`websocket-cached`、`auto`）、`timeoutMs` 和 `websocketConnectTimeoutMs`（正整数）、`maxRetryDelayMs`（非负整数）、`metadata`（对象）、`thinkingBudgets`（键 `minimal`、`low`、`medium`、`high`，值正整数）、`samplingParams`（对象，不许有请求结构键和输出上限键，清单在 `presets/load.ts`）。
- 白名单外的键报键名和类别：内核管的（`signal`、`sessionId`、`maxTokens`、`maxRetries`、`reasoning`）、一轮的语义（`toolChoice`、`deferred`）、凭据（`apiKey`、`headers`、`env`）、函数、`streamSimple` 不转发的（含 `serviceTier`）。
- `fork` 带新预设时用新预设的 `options`，不带时随快照原样复制。执行器的铺法见 [kb-executor](kb-executor.md#调用模型actionsts)。
- `reconfigure` 改 `options` 立即生效，不重读预设文件，白名单检查和这里同一个函数（[流程：会话配置](#流程会话配置reconfigure)）。

### 上下文文件（开段重读）

[D72](kb-decisions.md#d72-上下文文件开段重读)。快照的 `context` 是一组文件路径，写在预设文件头的 `context:` 一行（格式见[设计稿第 2 节](../docs/design/mvp.md#2-预设)）。

- 纯函数层不读文件。开段时，存储层把这些文件读成上下文视图，作为 `segment.contextView` 存下（怎么读、怎么拼见 [kb-store](kb-store.md#上下文文件视图)）。建进程和每次换段被接受时重读，所以文件改了，下一个工作段就看到新的。
- 视图在系统提示词里是一节，在记忆前面（见 [`buildContext`](#函数)）。
- 视图大小的上界是 `CONTEXT_VIEW_MAX_BYTES`，按整个视图的字节算：标题行、段间空行和各种说明都计入。它和记忆的上界一样进启动检查（[启动检查和交接以后的检查](#启动检查和交接以后的检查)）。
- 视图不并进 `fixedTokens`：固定部分是预设自己的，交接以后的检查要把固定部分、记忆、上下文各占多少分开报。
- 没声明 `context` 的快照，所有数字、报错文字和系统提示词，都和没有这个功能时一字不变。

### 工具描述

`tools.ts` 是纯数据：`ToolSpec { name, description, parameters, inStore }`。

| 工具 | 参数（`?` 为可选） | 库内 | 什么时候有 |
|---|---|---|---|
| `read` | `path`、`offset?`、`limit?` | 否 | `tools` 含 `read` |
| `write` | `path`、`content` | 否 | `tools` 含 `write` |
| `edit` | `path`、`old`、`new`、`replaceAll?` | 否 | `tools` 含 `edit` |
| `bash` | `command`、`timeout?` | 否 | `tools` 含 `bash` |
| `memory_get` | `key` | 是 | `tools` 含 `memory` |
| `memory_set` | `key`、`value`、`version?` | 是 | `tools` 含 `memory` |
| `memory_delete` | `key`、`version` | 是 | `tools` 含 `memory` |
| `post` | `to`、`text`、`reply?` | 是 | `tools` 含 `agents` |
| `spawn` | `preset`、`text` | 是 | `tools` 含 `agents` |
| `stop_process` | `process` | 是 | `tools` 含 `agents` |
| `self` | 无 | 是 | 总在 |
| `handoff` | 无 | 是 | 总在 |
| 工具定义 | 定义里的 `parameters` | 否 | 预设 `tools` 里写了它的名字 |

- 参数都是 `additionalProperties: false` 的对象。
- 顺序固定，按上表：工具定义最后，在 `handoff` 之后，按预设 `tools` 里的顺序。
- `memory_set` 的描述引用 `tools.ts` 里的三个记忆上限：`MEMORY_KEY_MAX_BYTES`、`MEMORY_VALUE_MAX_BYTES`、`MEMORY_VIEW_MAX_BYTES`。检查在记忆的实现里（[kb-memory.md](kb-memory.md#上限在哪里检查)）。
- `findTool` 对不认识的工具和预设里没有的工具都返回 `undefined`。

### 派生值

能从工作段算出来的值不存。

| 值 | 函数 | 怎么算 |
|---|---|---|
| 一条消息的字节数 | `messageBytes(m)` | 实际发出的原始 UTF-8 字节，不算 JSON 外壳和转义。用户消息：正文。工具结果：`toolCallId` + `toolName` + 文本。助手消息：文本 + 思考 + 每个工具调用的 ID + 名称 + `JSON.stringify(arguments)`（参数本来就按 JSON 发）。图片：`IMAGE_TOKENS × BYTES_PER_TOKEN` 字节，不看 `data`。孤立的代理项按 3 字节算 |
| 字节换成 token | `tokens(b)` | `ceil(b / BYTES_PER_TOKEN)`，只对总字节数取整一次 |
| 一条助手消息的用量 | `usageOf(m)` | `usage.totalTokens`；为 0 时取 `input + output + cacheRead + cacheWrite` |
| 上下文用量 | `contextUsed(p, seg)` | 段里最后一条用量不为 0 的助手消息（锚点）的用量，加上 `tokens(锚点之后各消息的 messageBytes 之和)` |
| 上下文用量（没有锚点） | `contextUsed(p, seg)` | `tokens(系统提示词的字节 + 工具描述 JSON 的字节 + 全段 messageBytes 之和)` |
| 一次回复的输出上限 | `outputMax(preset)` | `floor(contextWindow / 8)`。执行器请求 `min(model.maxTokens, outputMax)`（[kb-executor.md](kb-executor.md#调用模型actionsts)） |
| 换段阈值 | `handoffThreshold(preset)` | `min(contextWindow − 2 × outputMax − R − MARGIN_TOKENS, handoff)`，R 是 `resultReserve(preset)`；预设没写 `handoff` 时只有前一项，见[换段阈值](#换段阈值) |
| R | `resultReserve(preset)` | `tokens(MESSAGE_MAX_BYTES)`；`input` 含 `image` 时再加 `IMAGES_PER_MESSAGE × IMAGE_TOKENS`。只看快照 |
| 固定部分 | `fixedTokens(preset)` | `tokens(预设提示词 + 工作目录那一行 + JSON.stringify(工具描述)的字节)`，口径和 `contextUsed` 一样。工具描述含工具定义，所以启动检查也算上它们。不含记忆视图和上下文视图 |
| 限度 | `limits(preset)` | `{ fixed, memoryMax, contextMax, threshold }`，单位 token：`fixedTokens`、记忆的上界、上下文的上界、`handoffThreshold`。记忆的上界：预设含 `memory` 时是 `tokens(MEMORY_VIEW_MAX_BYTES + 标题的字节)`，否则 0。上下文的上界：快照有非空 `context` 时是 `tokens(CONTEXT_VIEW_MAX_BYTES + 一节标题的字节)`，否则 0。视图本身的总字节（标题行、段间空行、各种说明都计入）不超过 `CONTEXT_VIEW_MAX_BYTES`，所以这个上界不会低估。只看快照。协议的 `inspect`、`check` 把它交给上层 |
| 启动检查 | `startError(preset)` | 用 `limits`：`fixed + memoryMax + contextMax < threshold` 时返回 `null`，否则返回原因，文字见[启动检查和交接以后的检查](#启动检查和交接以后的检查)。`start`、`fork`、`spawn` 在存储层调用，`check` 和 `reconfigure` 在服务层调用（[kb-store](kb-store.md)、[kb-service](kb-service.md#读记录和干跑inspectcheck)） |
| 假想的新段 | `newSegmentUsed(p, memoryView, first, contextView = "")` | 新段只有 `first` 一条消息时的用量，返回 `{ used, fixed, memory, context }`：用量，加固定部分、记忆和上下文各多少 token。记忆视图和上下文视图都是传进来的实际视图，上下文按实际字节算，不按上界。交接以后的检查用 |
| 是否到阈值 | 内部 `overThreshold` | `contextUsed >= handoffThreshold` |
| 段末用户消息的起点 | `tailStart(seg)`（`context.ts`） | 段末最长一串用户消息的起点。段不空时最小为 1，段空时为 0 |
| 本段开始时间 | `segmentStartedAt(seg)` | 第一条消息的 `timestamp`；段空时没有 |
| 待执行的工具调用 | `pendingCalls(seg)` | 最后一条助手消息的工具调用，去掉前 k 个；k 是它后面的工具结果条数 |
| 正在等的副作用 | `effectOf(p, seg)` | 见上一节 |

### 常量

| 常量 | 值 | 状态 | 用途 |
|---|---|---|---|
| `STEPS_PER_TURN` | 1024 | 已定（[D68](kb-decisions.md#d68-steps_per_turn-定成-1024)） | 每轮最多调用多少次模型。它是收住换段循环的最后一道保险（见坑点） |
| `BYTES_PER_TOKEN` | 2 | 已定 | 按字节估算用量时，多少字节算一个 token |
| `MESSAGE_MAX_BYTES` | 32 KiB | 已定 | 每个工具结果和 `decide` 写入的每条用户消息的字节上限，超出时保留头尾 |
| `MARGIN_TOKENS` | 4096 | 已定 | 阈值之上的余量：交接指令、补的结果、ID、消息框架和估算误差 |
| `ENDED_REASON_MAX_BYTES` | 1024 | 已定 | 出错的原因经 `clip` 截到这个字节数：D25 的说明、`self` 和回信的头都用 |
| `HOPS_MAX` | 1024 | 暂定 | `post` 和 `spawn` 寄出的信，跳数超过它就失败。回信不受限制。只防库内工具的循环。检查在存储层 `post`、`spawn` 的执行里（[kb-store](kb-store.md#进程之间的工具)），常量放在 `derive.ts`。为什么是 1024，见 [D50](kb-decisions.md#d50-hops_max-放宽到-1024) |
| `IMAGE_TOKENS` | 5000 | 已定 | 一张图算多少 token，不看字节。取全部测量值（最大 4,763）、文档上限 4,784 和 5000 里的最大值（[D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)） |
| `IMAGES_PER_REQUEST` | 8 | 暂定 | 一次请求最多带段里最近的几张图（K）。放在 `context.ts` |
| `IMAGES_OMIT_BATCH` | 4 | 暂定 | 超出时每批省略几张（B）。放在 `context.ts` |
| `IMAGES_PER_MESSAGE` | 2 | 暂定 | 工具结果和新段第一条消息最多带几张图片（[张数和省略行](#张数和省略行)） |
| `CONTEXT_VIEW_MAX_BYTES` | 24 KiB | 已定（[D72](kb-decisions.md#d72-上下文文件开段重读)） | 整个上下文视图最多多少字节，UTF-8。标题行、段间空行、截断说明、读不到和没额度的说明都计入。进 `limits` 的 `contextMax`，参与启动检查；放宽或收紧要先重算启动检查（[kb-contract](kb-contract.md#参与启动检查的量)）。怎么用在读文件上，见 [kb-store](kb-store.md#上下文文件视图) |

已定的值为什么是这样，见 [D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)；`ENDED_REASON_MAX_BYTES` 见 [D25](kb-decisions.md#d25-上一轮没有正常结束时下一条消息加说明)。

| 固定文本 | 内容 | 用途 |
|---|---|---|
| `INTERRUPTED` | 被中断，结果未知 | `endTurn` 给正在等的调用补的结果 |
| `SKIPPED` | 未执行 | 其余补的结果 |
| `HANDOFF_HEADER` | （这是你在上一个工作段结束时写的交接说明。）加一个空行 | 新段第一条消息的开头 |
| `CARRY_HEADER` | （下面是写交接说明时还没处理的用户消息。） | 新段第一条消息里，带过来的用户消息之前的一行 |
| 上一轮的说明：停止 | （上一轮被停止。上面还没回复的消息都已取消：不要回应它们，只回应下面的信。） | 上一轮以 `stopped` 结束时，下一条用户消息的开头 |
| 上一轮的说明：步数用完 | （上一轮的步数用完了，停在中途。如果有进程在等你回信，它们已经收到上一轮的结束通知，之后的回复不会寄给它们。） | 以 `stepLimit` 结束时 |
| 上一轮的说明：出错 | （上一轮出错，没有做完：<原因>。如果有进程在等你回信，它们已经收到上一轮的结束通知，之后的回复不会寄给它们。） | 以 `error` 结束时 |
| `HANDOFF_INSTRUCTION` | 不调用工具，写交接说明：目标、做了什么和结果、下一步、没完成的事；写清还没回复完的用户请求要什么，最后几条还没处理的用户消息会原样附在后面。468 字节，估成 234 token | `buildContext` 加在末尾，不入库 |

### 换段阈值

W 是 `preset.contextWindow`。快照里只存它和 `input`，不存模型的输出上限。

- OUT = `outputMax` = `floor(W / 8)`。
- R = `resultReserve(preset)`，一个没检查的工具结果最多多少 token，是快照的纯函数：
  - 不收图片：`tokens(MESSAGE_MAX_BYTES)` = 16,384。
  - 收图片：16,384 + `IMAGES_PER_MESSAGE × IMAGE_TOKENS` = 26,384。
  - 一张图在估算里是 `IMAGE_TOKENS` 个 token（`messageBytes`）。锚点是真实用量，已经包括请求里真的图片；锚点之后的图片按这个估算。
- T0 = W − 2·OUT − R − `MARGIN_TOKENS`。阈值之上要放得下：一次回复、一个没检查的工具结果、交接说明的输出和余量。
- T = `handoffThreshold` = min(T0, `preset.handoff`)。预设没写 `handoff` 时 T = T0。`handoff` 只能把阈值调低：写得比 T0 大就等于没写（[D51](kb-decisions.md#d51-预设加-handoff换段阈值只能调低)）。下面的证明只要求 T 不高于 T0，所以调低它不破坏证明；下面的表都是没写 `handoff` 的值。会话配置可以随时改 `handoff`（[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)），每个值都不高于 T0，证明照旧；改了以后，已经存下的 `purpose` 可能和现算的阈值不一致，见[坑点](#坑点)。

证明梗概。U 是用量估算，I = 234 是交接指令，S 是补的结果以及工具结果的 ID 和名称。

1. 只有 U < T 时才发出用途 `turn` 的调用。写入的回复用量 ≤ 输入 + OUT。`length` 的回复不写入。
2. 一条回复之后，下次检查前最多写入一个工具结果（≤ R）。之后每写一个结果都检查。
3. 过了阈值，换段成功之前没有 `turn` 调用，只写补的结果和用户消息。
4. 这些用户消息总在段末，交接请求不带它们。
5. 所以交接请求不算指令时 < T + OUT + R + S。加上 I 和交接说明的 OUT：≤ W − `MARGIN_TOKENS` + I + S = W − 3,862 + S。
6. S + I 超过 `MARGIN_TOKENS` 的回复不写入（见[流程：模型回复](#流程模型回复用途-turn)），所以总量不超过 W。
7. 停止、步数用完、交接失败多少次、后来的消息多大，都不改变这个上界。重试发的是同一个请求。
8. `turn` 调用：T + OUT < W。

前提：真实的分词至少 2 字节一个 token；`IMAGE_TOKENS` 不低于在用模型一张图的真实 token 数，图按入口允许的各种形状算，不只正方形；固定部分加记忆加上下文的上界低于阈值，由[启动检查](#启动检查和交接以后的检查)保证。

| W | OUT | T（占 W） | 交接请求上界 T + OUT + R + I（不含 S） | 加交接说明 | 余下 | 提示词空间 |
|---|---|---|---|---|---|---|
| 65,536 | 8,192 | 28,672（43.8%） | 53,482 | 61,674 | 3,862 | 约 4.4 KB |
| 64,000 | 8,000 | 27,520（43.0%） | 52,138 | 60,138 | 3,862 | 约 2.1 KB |
| 128,000 | 16,000 | 75,520（59.0%） | 108,138 | 124,138 | 3,862 | 约 98 KB |
| 200,000 | 25,000 | 129,520（64.8%） | 171,138 | 196,138 | 3,862 | 约 206 KB |
| 1,000,000 | 125,000 | 729,520（73.0%） | 871,138 | 996,138 | 3,862 | 约 1.4 MB |

收图片的预设（R = 26,384）：

| W | T（占 W） | 提示词空间 |
|---|---|---|
| 64,000 | 17,520（27.4%） | 放不下最坏的新段，见坑点 |
| 128,000 | 65,520（51.2%） | 约 56 KB |
| 200,000 | 119,520（59.8%） | 约 164 KB |
| 1,000,000 | 719,520（72.0%） | 约 1.36 MB |

- 其余的列照式子代入 R，余下不变。
- 余下总是 `MARGIN_TOKENS` − I = 3,862，先给 S。S 用不完的部分留给消息框架和估算误差。
- 提示词空间：最坏的新段（全部内置工具、16 KiB 的记忆视图、32 KiB 的第一条消息）里，预设提示词还能有多少字节而不立即再换段。表里不含工具定义：每个工具定义的说明和参数的 JSON 字节，都要从提示词空间里扣。一个预设最多 `TOOL_DEFS_MAX_BYTES`（64 KiB，按整个 `ToolDef` 算，所以是上界）。收图片时，最坏的第一条还带 `IMAGES_PER_MESSAGE` 张图，多算 2 × `IMAGE_TOKENS` × `BYTES_PER_TOKEN` = 20,000 字节，上表已扣除。声明了 `context` 的预设，最坏的新段还多一份最多 `CONTEXT_VIEW_MAX_BYTES`（24 KiB）的上下文视图，提示词空间要再扣这么多，上表没扣；小窗口可能因此通不过启动检查。

### 请求里的图片

- 一次请求最多带段里最近的 `IMAGES_PER_REQUEST`（K）张。段里有 n 张：n 不超过 K 时全带；否则从最早的起整批省略，每批 `IMAGES_OMIT_BATCH`（B）张，省 B × ⌈(n − K) / B⌉ 张，请求里留最近的 K − B + 1 到 K 张。省略的每张换成一行 `[图片：较早的图片，已省略]`。
- K = 8、B = 4：n = 9 到 12 省 4 张，n = 13 到 16 省 8 张。省略的张数每来 B 张图变一次。成批省略是为了提示缓存：请求的前缀不是每来一张图都变。
- 这由 `buildContext` 调 `omitOldImages` 做，是段的纯函数，不改库。交接请求先去掉段末的用户消息，再数图。
- 所以一次请求里图片的数据不超过 8 × 1.5 MiB × 4/3 = 16 MiB。这低于 Anthropic 每次请求 32 MB 的上限，文字不超过约 4 MiB 时也低于 Google 的 20 MiB。
- 这是“换段是唯一缩短上下文的办法”的例外，理由见 [D40](kb-decisions.md#d40-第-6-步前一半的选择)。
- 用量估算：`messageBytes` 把一张图算成 `IMAGE_TOKENS × BYTES_PER_TOKEN` 字节，不看 `data`。段里只有收图片的预设才会有图片。

### 启动检查和交接以后的检查

- 启动检查：`start` 和 `spawn` 读出快照时，`startError(preset)` 要返回 `null`；`fork` 带 `preset` 和协议的 `reconfigure` 构造出新快照时也一样（[kb-service](kb-service.md#会话配置reconfigure)）。C 是上下文的上界，没声明 `context` 时为 0。没写 `handoff` 时，式子等价于 F + M + C + R + `MARGIN_TOKENS` + 2·OUT < W，比“交接请求放得进窗口”更严。写了 `handoff`，检查的是 F + M + C < T，T 是取了较小值的阈值：`handoff` 设得太低，这里或者交接以后的检查就会报错，要给固定部分、记忆和上下文的上界和一份交接说明留出空间。阈值不大于 0 的小窗口也被挡住。启动失败的原因是 `预设 <id> 的窗口太小，装不下：固定部分 <f> token，记忆的上界 <m> token，换段阈值 <T> token`；声明了 `context`（非空）时，在“记忆的上界”和“换段阈值”之间多一项 `上下文的上界 <c> token`，没声明时文字一字不变。纯函数层只算，调用在存储层：`startProcess` 抛错，`spawn` 是错误结果，什么都不建（[kb-store](kb-store.md)）。
- 它只挡固定部分加记忆加上下文到阈值的预设。差得不远的，新段的第一条（交接头加说明）还会把新段推到阈值。这一种由交接以后的检查兜住。
- 交接以后的检查：`onHandoff` 接受交接回复以后、建新段之前，用 `newSegmentUsed` 查假想的新段。记忆视图取 `env.memoryView`，上下文视图取 `env.fresh.contextView`（实际读到的，不是上界）；有待换配置时，快照、阈值和两个视图都按 `p.next` 和 `env.fresh`（[换段时采用待换配置](#换段时采用待换配置)）。段里只有一条 `HANDOFF_HEADER` 加交接说明，不带要带过去的信。用量不低于阈值（和 `continueTurn` 同一个判断）就按交接失败结束本轮：不写交接回复，不建新段，排队的信照 `endTurn` 合并写进旧段。原因：`交接失败：新段一开头就到阈值（固定部分 <f>、记忆 <m>[、上下文 <c>]、交接说明 <n>，共 <x> / <T> token）`。上下文视图不为空时才有 `、上下文 <c>` 一项，没有上下文视图时文字一字不变。丢弃了待换配置时，末尾再加 `；待换的配置已丢弃`（[换段时采用待换配置](#换段时采用待换配置)）。每封信最多浪费一次交接调用。
- 带过去的信让新段到阈值时，检查不拦，照常再换一次段。

### 信的头和合并

`decide` 把信写进工作段时加头。头写在信的正文前面，和正文隔一个换行。

发送者有两种：

- `user`：人，或者上层程序。CLI、bash 里运行的 `tau`、上层程序寄的信，都是用户的信。要标明来源，就在正文前加前缀，例如 `[Claude Code] `、`[后台任务] `。
- `process`：另一个进程。由库内工具（含工具定义声明的）、回信和协议的 `send` 带 `from` 产生。`from` 只收进程 ID，不是进程的来源照旧用正文前缀。

| 信 | 头 |
|---|---|
| 用户的信 | 没有头 |
| 用户的信，和进程的信（含回信）在同一条消息里 | `（来自用户）` |
| 进程的信 | `（来自进程 <id>，预设 <preset>）` |
| 进程的信，带 `replyTo` | `（来自进程 <id>，预设 <preset>。它在等回信：你这一轮结束时，最终回复会寄给它，之后的几轮不会。）` |
| 回信（`from.reply` 有值） | `（进程 <id> 的回信，这一轮<结束原因>）`，文字见[结束原因的文字](#结束原因的文字) |

- 一条消息的文本：D25 的说明（有的话）在最前面，空一行，然后是信。每封信是头、换行、正文；没有头的信只有正文。信之间空一行。
- 一批信里有没有进程的信，决定用户的信加不加头。空闲时收到的一封用户的信，没有头；排队的几封用户的信合并，也没有头。
- 回信同时带 `replyTo` 时，按回信算。回信不带 `replyTo`（`sendReplies` 保证）。
- 回信由 `decide` 产生，进程的信（`post`、`spawn`）由库内工具产生。CLI 寄的是用户的信。

### 消息的两种形状

写进段的用户消息只有两种形状：

- 没有图片：`content` 是字符串，头直接拼进文本，经 `clip` 截到 `MESSAGE_MAX_BYTES`。
- 有图片：`content` 是数组，一个文本块（文本为空时没有），后面接图片块。文本经 `clip`。

信的内容块由 `decide` 里的 `render` 拆成文本和图片；图片按信的顺序全带。合并几封信时不限张数，入口限每封信（[kb-service 的图片](kb-service.md#图片)）。

#### `tau`：消息带的结构

`decide` 写的消息可以带可选字段 `tau`（D64 第 3 组），让读段的人不用解析文字就能知道信的来历。旧消息没有它。类型在 `types.ts`，`Message` 的用户消息和工具结果各加一个可选键，助手消息不带。

- 用户消息：`tau: { letters: LetterMeta[]; after?: Ended; handoff?: true }`。
  - `LetterMeta = { from; hops; replyTo?; handoff?; at? }`，每封合并进这条消息的信一项，顺序同信。`handoff` 是信自己的换段标记（[换段信](#换段信)）。
  - `at` 是这封信的正文（不含头）在消息文本里的起止位置，按 UTF-16 算。消息文本：`content` 是字符串时就是它，是数组时是第一个文本块。
  - `after` 是 [D25](kb-decisions.md#d25-上一轮没有正常结束时下一条消息加说明) 那句说明对应的上一轮结束原因，只在加了说明的那条消息上有。说明在正文里，不在任何一封信的 `at` 里。
  - `handoff: true` 只在换段后新段的第一条上。
- 工具结果：`decide` 补的带 `tau: { filled: "interrupted" | "skipped" }`，对应 `INTERRUPTED` 和 `SKIPPED`。真实的工具结果没有 `tau`。
- 文本被 `clip` 截过（消息文本不再以渲染出的正文开头）：这条消息的 `at` 全部去掉，别的字段照留。`userMessage` 统一做这个检查。
- 换段：带过去的消息，它们的信带着 `at` 平移到新段第一条的文本里，仍然截得出原文。带过去的消息原来的 `after` 不带：说明的文字照旧在正文里，不属于任何一封信。没有文本的消息不占位，它的信没有 `at`。
- `buildContext` 发请求前去掉 `tau`，给模型看的文字一个字不变。`messageBytes` 只数内容，用量估算不受影响。
- `fork` 和 `history` 原样带着它。

### 张数和省略行

工具结果和新段的第一条消息，最多 `IMAGES_PER_MESSAGE` 张图片，由 `decide` 里的 `fit` 做：

- 图片不多于上限：原样。文本经 `clip`，成一个文本块；没有文本块就不加。
- 图片多于上限：从最早的起省略 k 张，留下最后几张。文本块末尾加一行 `[图片：省略了 <k> 张较早的图片]`。文本先 `clip` 到 `MESSAGE_MAX_BYTES` 减去这一行和换行的字节数，所以整条不超过上限。没有文本时，文本块就只有这一行。

用户消息和工具结果各有一个构造函数（`userMessage`、`toolResult`），都经过 `fit`。空闲时收信、`endTurn`、换段携带、工具结果都走它们。空闲和 `endTurn` 的用户消息不限张数；新段的第一条和工具结果限。

### 结束原因的文字

`endedText(ended)`（`derive.ts`）：`正常结束`、`步数用完`、`被停止`、`出错：<原因>`。

- 原因由 `endedReason` 处理：先 `clip` 到 `ENDED_REASON_MAX_BYTES`，再把回车和换行换成空格。顺序不能反：`clip` 插进去的省略标记也带换行。所以结果永远只有一行，处理两次和一次一样。
- `self`（[kb-store.md](kb-store.md#self)）、回信的头、D25 的出错说明都用它。段里存的出错原因仍是原文：`ended` 不变。

### 最终回复

`finalReply(seg)`（`derive.ts`）只看当前段，从末尾往前找：

- 先遇到用户消息：空串。
- 先遇到助手消息：它所有 `text` 块直接连接，不加分隔。
- 工具结果跳过。

所以本轮不是正常结束时，回复可能是空串，也可能是带工具调用的那条助手消息的正文。本轮以停止、出错或步数用完结束、又有排队的消息时，排队的消息合并写在段末，回复是空串。

服务的 `settle` 在提交之后的段上调用它（[kb-service.md](kb-service.md#观察者和最终回复)）。`decide` 的 `endTurn` 在合并排队的信之前调用它，算[回信](#回信)的正文。所以停止时如果有排队的信，等着的连接拿到空串（和 v1 一样），回信拿到的是合并之前的最终回复。

### 累计用量

`process.usage` 是这个进程所有模型调用的 token 之和：输入、输出、缓存读、缓存写。

- 阶段是 `awaitingModel`、编号是 `lastEffect`、状态是 `ok` 的 `modelResult`，`decide` 都把 `message.usage` 的四项加进去。用途 `turn` 和 `handoff` 一样。
- 写不写进段都加：交接回复（成功和失败）、`length`、工具调用太多、出错的回复。
- 不加：被丢弃的结果（空闲时迟到或重复的、编号不对的、种类对不上的、停止之后才到的）和被中断的调用。这是有意的少算。
- 不存钱数：pi-ai 按单次请求的输入量分档计价，钱数从累计的 token 数算不出来。
- 它跨段累计，从工作段算不出来，所以存在进程记录里。

### 流程：两个辅助步骤

`decide` 里所有“继续”都走 `continueTurn`，所有“结束”都走 `endTurn`。

**`continueTurn(turn)`**

1. `turn.steps >= STEPS_PER_TURN`：`endTurn(turn, "stepLimit")`。
2. 否则步数加一。到阈值，或者[最后一条助手消息里有成功的 `handoff` 调用](#主动换段handoff)，或者调用方传来的[换段信](#换段信)标记：进入 `awaitingModel(handoff)`。
3. 否则进入 `awaitingModel(turn)`。

每次调用模型都计一步，交接调用也算。

**`endTurn(turn, ended)`**

1. 给每个待执行的调用补一条结果，`isError` 为 `true`。阶段是 `awaitingTool` 时，第一个写 `INTERRUPTED`，其余写 `SKIPPED`。其它阶段全部写 `SKIPPED`。
2. 算最终回复（`finalReply`）。这一步在合并排队的信之前。
3. [寄回信](#回信)：收件人和正文由结束原因、`turn.replyTo`、`turn.queued` 算出，放进 `out`。
4. `turn.queued` 不空：按[信的头和合并](#信的头和合并)渲染成一条用户消息，时间戳 `env.now`，写入当前段。
5. `ended` 是 `done` 且 `turn.queued` 不空：`continueTurn` 一个新的 `Turn`：`steps` 为 0，`queued` 为空，`hops` 取这批信的最大值，`replyTo` 取这批信的 `replyTo` 去重。这批信带[换段信](#换段信)标记且段里有助手消息时，传标记。
6. 否则进入 `idle`，带上 `ended`。排队的信仍在段里，它们的头里还写着“它在等回信”；下一封信前面的[上一轮的说明](#常量)负责纠正。

### 回信

回信是一轮结束时寄给等回信的进程的信。只有 `endTurn` 产生它们。

`replyTo` 和 `hops` 并进 `turn` 的规则：

1. 一封信写进段时，它的 `replyTo` 和 `hops` 才并进 `turn`：`replyTo` 加进集合，去重；`hops` 取最大。写进段的时机有三个：空闲时收信、安全点、`endTurn`。
2. 空闲时收信，开新一轮：新一轮的 `replyTo` 和 `hops` 只取自这封信。
3. 到 6. 在 `endTurn` 里：3 是[步骤 2、3](#流程两个辅助步骤)的顺序（最终回复在合并之前算），4 是下面的寄出的规则，5 是步骤 5（`done` 时合并排队的信，新一轮只取这批信的 `replyTo` 和 `hops`），6 是步骤 6（不是 `done` 时合并写进段，停在 `idle`）。代码和测试注释里的“5.3 规则 3 到 6”指这些。

回信的意思：

- 回信只覆盖处理那封信的那一轮。进程为了等子进程或后台任务而结束本轮，等它回信的进程收到的就是这时的回复，例如“已派出”。之后几轮的结果不会自动寄上去。出路见 [kb-extras 的多 Agent 的等待](kb-extras.md#多-agent-的等待)。
- “等子进程”不是一个状态：父进程结束本轮，回信到了，它就被唤醒。
- 子进程要问父进程，就在回复里提问、结束本轮。问题作为回信到父进程。父进程用 `post`（`reply` 为真）回答。

寄出的规则：

- 收件人：`turn.replyTo` 里的每个进程，正文是最终回复，可能为空。结束原因不是 `done` 时，再加排队的信里的 `replyTo`、不在 `turn.replyTo` 里的进程，正文为空。每个进程最多一封，顺序是 `turn.replyTo` 的顺序，再是排队的信出现的顺序。
- 信件：`from` 是 `{ kind: "process", id: 自己, preset: 自己的预设 ID, reply: { ended } }`。出错时 `ended.error` 已经过 `endedReason`：整页的报错不进收件人的信箱。`hops` 是 `max(turn.hops, 排队的信的 hops) + 1`，不管结束原因是什么。没有 `replyTo`，所以回信永远不会引出新的回信。
- 内容：没有最终回复时是空数组，不是一个空文本块。
- 头只写结束原因，不说信处理了没有。收件人看正文为空、结束原因又不是正常结束，就知道没拿到回答。
- 存储层把它们投进收件人的信箱（[kb-store](kb-store.md#处理一条输入)）。`decide` 不查收件人是否存在：要回信的信是工具寄的，工具已查过收件人；进程只有在没有任何地方引用它时才能删（[kb-service](kb-service.md#删除)），所以回信的收件人一直在。

### 流程：每种输入

| 输入 | 条件 | 处理 |
|---|---|---|
| `letter` | `idle` | 按[信的头和合并](#信的头和合并)渲染这一封信。上一轮没有正常结束（`ended` 是 `stopped`、`stepLimit` 或 `error`）时，正文前面加上一轮的说明和一个空行。写入工作段，时间戳 `env.now`；`continueTurn` 一个新的 `Turn`，`hops` 和 `replyTo` 只取自这封信。这封信带[换段信](#换段信)标记且段里有助手消息时，传标记 |
| `letter` | 运行中 | 追加到 `turn.queued`。不写段，副作用不变。写进段在下一个安全点或本轮结束时 |
| `stop` | 运行中 | `endTurn(turn, "stopped")` |
| `stop` | `idle` | 什么都不做 |
| `reconfigure` | 任何阶段 | 见[流程：会话配置](#流程会话配置reconfigure)。不写消息，不发回信，不改阶段，不开轮 |
| `modelResult`、`toolResult` | `idle`，或 `n` 不是 `lastEffect`，或种类和阶段对不上 | 丢弃：进程记录和工作段都不变 |
| `modelResult` 被中断 | 用途 `turn` 或 `handoff` | `endTurn(turn, { error: "服务重启，模型调用被中断" })` |
| `modelResult` 正常 | 用途 `turn` | 见“模型回复” |
| `modelResult` 正常 | 用途 `handoff` | 见“换段” |
| `toolResult` 被中断 | — | `endTurn(turn, { error: "服务重启，工具被中断" })`。后面的工具不再跑 |
| `toolResult` 正常 | — | 见下 |

`toolResult` 正常：

1. 内容块按[张数和省略行](#张数和省略行)整理，作为第一个待执行调用的结果写入。`toolCallId`、`toolName` 取自调用，`isError` 原样保留。
2. 还有待执行的调用，并且没到阈值：进入下一个 `awaitingTool`。`lastEffect` 加一，步数不变。
3. 否则给剩下的调用补 `SKIPPED`（没有就不补），然后到[安全点](#安全点投递)，由它调用 `continueTurn`。

工具按顺序执行，一次一个。没有自动重试。

### 流程：模型回复（用途 `turn`）

| `stopReason` | 写入段 | 处理 |
|---|---|---|
| `toolUse` 或 `stop`，工具调用太多（先检查） | 否 | `endTurn(turn, { error: "一次回复的工具调用太多" })` |
| `toolUse`，有工具调用 | 是 | 进入 `awaitingTool`，等第一个调用。这里不检查阈值 |
| `toolUse`，没有工具调用 | 是 | `endTurn(turn, "done")` |
| `stop` | 是 | `endTurn(turn, "done")`。带着工具调用时，它们都补 `SKIPPED` |
| `length` | 否 | `endTurn(turn, { error: "输出被截断" })`。不看 `errorMessage` |
| `error`、`aborted`、`pending`、`deferred` | 否 | `endTurn(turn, { error: errorMessage ?? stopReason })` |
| pi-ai 之外的值 | 否 | 同上一行 |

失败的回复不写入。所以错误不会被藏起来，最后一条助手消息的用量也不会变成 0。

工具调用太多：每个调用按 2 × ID + 名称 + `未执行` 的字节算补的结果，换成 token 后加上交接指令的 234，超过 `MARGIN_TOKENS`。这样的回复写进去，换段请求可能超过窗口，所以和 `length` 一样不写入。

- ID 算两次：它由服务端分配，不在回复的用量里；之后的请求里调用和结果各带一次。
- 上限和窗口无关。以 `read` 为例：2 字节的 ID 约 454 个，Anthropic 的 ID（30 字节）约 105 个，openai-responses 的 ID（81 字节）约 44 个。

### 安全点投递

安全点只有一个：当前这条助手消息的工具结果全部写完或补完、调用 `continueTurn` 之前，也就是 `onToolResult` 的末尾。到了安全点，按顺序做：

1. 先查步数。`turn.steps >= STEPS_PER_TURN`：不合并，信留在 `queued`，由 `continueTurn` 里的 `endTurn(stepLimit)` 按[结束一轮](#流程两个辅助步骤)处理。发起这一轮的进程拿到的最终回复，和这时没有信一样。
2. `queued` 不空：经 `userMessage` 合并成一条用户消息写进段（头和形状见[信的头和合并](#信的头和合并)，不限张数），时间戳 `env.now`。这批信的 `replyTo` 并进 `turn.replyTo`（去重），`hops` 取 `turn.hops` 和这批信的最大值，`queued` 清空。
3. `continueTurn`。这批信带[换段信](#换段信)标记且段里有助手消息时，传标记。

- 写入不计步，下一次调用模型才计。
- 换段成功以后、等模型回复时到的信，都等下一个安全点或者本轮结束；`turn.queued` 到那时才写进段。
- 工具被中断、停止、`length` 等不经过安全点：信由 `endTurn` 写入。
- 阈值证明不变：写入的信在段末，交接请求不带段末的用户消息（[证明](#换段阈值)第 4 步）；写入之后 `continueTurn` 照样先查阈值；换段时这条信原样带到新段。
- 在用的模型都接受“工具结果后面紧跟一条用户消息”，已在第 3 步核实（[D34](kb-decisions.md#d34-第-3-步真模型核实)）。

### 主动换段（`handoff`）

- 库内工具，没有参数，总是有。结果 `将在这批工具结果之后换段。`，`isError` 为假（[kb-store.md](kb-store.md#handoff)）。
- `continueTurn` 发现最后一条助手消息里有 `handoff` 调用、并且它的结果不是错误，就进入 `awaitingModel(handoff)`，不看阈值。算法是 `derive.ts` 的 `handoffRequested`：调用和结果按位置配对。
- 补的结果（`INTERRUPTED`、`SKIPPED`）都是错误，所以没执行的 `handoff` 不触发换段。
- 同一批里的其他工具照常执行，批做完才到安全点。
- 不存状态：从最后一条助手消息和它的结果算出来。换段成功以后新段里没有助手消息，不会再换。
- 交接失败以后，下一封信一来又会立即换段。这和到阈值时一样，是有意的。

#### 换段信

D64 第 7 组：外面也能要求换段（模型调 `handoff` 工具之外的第三个触发）。`Letter.handoff?: true` 由协议的 `send` 的 `handoff` 布尔产生，只有 `true` 才写这个键（[kb-service](kb-service.md#线协议srcprotocolts)）。

- 三个时机：空闲时收信；安全点合并；一轮以 `done` 结束后，用排队的信开新一轮。每个时机都在写进段之后、`continueTurn` 之前，用 `wantsHandoff` 判一次，结果作为参数传给 `continueTurn`。
- 条件：这一批信里有带标记的，并且段里已有助手消息。成立时下一次调用的用途是 `handoff`。交接请求不带段末的用户消息，所以这封信原样带进新段，模型在新段里接着处理它。
- 标记只在信箱和 `turn.queued` 里，用掉以后就是 `phase.purpose`。不加阶段、输入种类、事务和状态。
- 其余情形标记作废，不留到下一轮：一轮不是以 `done` 结束时由 `endTurn` 合并的信；步数用完时没有合并的信；段里没有助手消息（新进程的第一封信、刚换段的新段开头）。没有触发换段的信也不再有标记：开新一轮时 `queued` 已清空。上层看 `final` 的结束原因，再用 `inspect` 或 `ps` 看段号，判断换没换成。
- 和阈值、`handoff` 工具同时成立：用途只有一个，只换一次。
- 交接调用进行中到的信：`onHandoff` 接受交接时，去掉 `turn.queued` 里各信的标记。否则换段后合并这批信时会再换一次。交接失败时信照常由 `endTurn` 合并，标记随之作废。
- `post`、`spawn`、`start` 不带这个参数。

### 流程：换段

1. `continueTurn` 发现到阈值或者有成功的 `handoff` 调用，进入 `awaitingModel(handoff)`。`buildContext` 在末尾加交接指令。
2. 交接说明 = 回复里所有 `text` 块用换行连接，再去掉首尾空白。思考块不算。
3. 接受的条件：`stopReason` 是 `stop` 或 `length`，并且交接说明不为空。接受时：
   - `segment` 变成 `{ seq: seq + 1, memoryView, contextView }`。没有待换配置时，`memoryView` 取 `env.memoryView`，`contextView` 取 `env.fresh.contextView`：上下文文件每次换段重读。有待换配置时见[换段时采用待换配置](#换段时采用待换配置)。
   - 新段的第一条消息是用户消息，时间戳 `env.now`。内容是 `HANDOFF_HEADER` + 交接说明。旧段末尾有用户消息时（从 `tailStart` 起），再接空行、`CARRY_HEADER`、空行和这些消息的正文，正文之间用空行连接。没有正文（只有图片）的消息不占位。
   - 段末的用户消息两种形状都带：文本照上面接在后面，图片块原样带过去，按顺序。新段第一条按[张数和省略行](#张数和省略行)整理：留最后 `IMAGES_PER_MESSAGE` 张，文本连省略行不超过 `MESSAGE_MAX_BYTES`。没有图片时第一条仍是字符串，经 `clip` 截到 `MESSAGE_MAX_BYTES`。
   - 新段第一条带 `tau: { letters, handoff: true }`：`letters` 是带过去的信，位置平移（见 [`tau`](#tau消息带的结构)）。
   - 用同一个 `turn` 执行 `continueTurn`：步数和排队的消息带到新段。
4. 其它情况（包括 `toolUse` 和空说明）：`endTurn(turn, { error: "交接失败：" + (errorMessage ?? stopReason) })`。不写交接回复，不开新段。排队的消息仍按 `endTurn` 合并写进旧段。
5. 失败后再发一条消息：新的一轮，`continueTurn` 立即再换段。新消息在段末，不进交接请求，所以请求和上一次相同。一直失败时，每条消息只调用一次模型。
6. 换段只发生在 `continueTurn` 里。这时所有工具调用都已有结果。

#### 换段时采用待换配置

`onHandoff` 接受交接回复时，`p.next` 存在：

- 交接请求本身（让旧模型写说明）仍用旧快照，`buildContext(p)` 不变。
- 新段按 `p.next` 开：交接以后的检查（`newSegmentUsed`）、阈值、记忆视图、上下文视图，都按 `p.next` 和 `env.fresh`。
- 检查通过：`p.preset` := `p.next`，去掉 `p.next`；新段 `segment` = `{ seq: seq + 1, memoryView: fresh.memoryView, contextView: fresh.contextView }`。
- 检查不通过（新段一开头就到阈值）：照交接失败结束本轮，原因的末尾加 `；待换的配置已丢弃`（全文见[启动检查和交接以后的检查](#启动检查和交接以后的检查)），同时丢掉 `p.next`。进程回到旧快照继续用，不会陷进“每封信都交接失败”的循环。别的原因的交接失败（模型出错、空说明、工具调用）不丢 `p.next`：下一次换段再试。
- 带过去的用户消息里有图片：只在有 `p.next`、并且 `p.next.input` 不含 `image` 时，每张图才换成 `IMAGE_UNSUPPORTED`，和 `fork` 带 `to` 用同一段代码（[带 `to`：换角色](#带-to换角色)）。没有 `p.next` 时，图原样带过去。
- 没有 `p.next` 时，换段的行为和上面第 3 步一字不变，只有 `contextView` 在这里重取。

### 流程：会话配置（`reconfigure`）

[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)。`reconfigure` 输入带的是服务算好的完整新快照 S，已经通过 `startError`。`decide` 不读文件，不查模型目录，只比较和采用。

快照的键分两类：

- 调用参数：`thinking`、`options`、`handoff`。
- 结构性字段：其余所有键，`id`、`workdir`、`model`、`tools`、`toolDefs`、`prompt`、`contextWindow`、`input`、`context`。

任何阶段都处理，按顺序：

1. `p.preset` 换成当前快照，三个调用参数换成 S 的（S 没有的键去掉）。立即生效，进程在跑也行。
2. S 的结构性字段和 `p.preset` 的相等（稳定序列化后比较，纯函数）：去掉 `p.next`，待换的取消了。
3. 否则，阶段是 `idle`，并且当前段里没有助手消息，并且（S 的 `input` 含 `image`，或者当前段里没有任何图片块），并且当前段放得下 S：直接采用。`p.preset` := S；`p.segment` 的段号不变，`memoryView`、`contextView` 换成 `env.fresh` 的；去掉 `p.next`。段里没有助手消息，换了视图不改任何已有的回复。“放得下”：不用用量锚点的估算 `estimatedUsed`（用 S 和新的两个视图算系统提示词、工具描述，加上整段）低于 S 的换段阈值，`>=` 算放不下。口径和 `fork` 带 `preset` 的检查是同一个函数、同一个比较（[带 `to`：换角色](#带-to换角色)）。
4. 否则：`p.next` := S，换段时生效。

不写消息，不发回信，不改阶段，不开轮。

- 直接采用要求空闲、段里没有助手消息：在途的模型调用或工具调用拿着旧的提示词和工具清单，这时换了，会出现“调用了已被删的工具”。其余情形等换段。
- 段里有图、新模型又不收图时不直接采用：已有的消息不改写，直接采用会让下一次调用带着图失败。走第 4 条，换段时带过去的图换成 `IMAGE_UNSUPPORTED`（[换段时采用待换配置](#换段时采用待换配置)）。
- 段放不进 S 时不直接采用：换到小窗口后，没有助手消息的旧段（比如几条很长的用户消息、每一轮都出错）可能已经到了 S 的阈值，直接采用会让下一次调用就是带着整段的交接调用，超窗口失败。这时存 `next`，当前快照照常用；段里没有助手消息，换段时带过去的只是段末的用户消息，新段一开头的检查通过就采用，不通过就丢弃 `next`。
- 调用参数立即生效：已经发出的请求和副作用编号不变，下一次调用起用新值（执行器每次开始都重读进程记录，[kb-executor](kb-executor.md#调用模型actionsts)）。
- 步骤 1 和步骤 4 用的是同一个 S，所以 `p.next` 的调用参数总是和 `p.preset` 的一样：调用参数的改动立即生效，不会留在 `p.next` 里等换段。服务以 `p.next ?? p.preset` 为底造 S（[kb-service](kb-service.md#会话配置reconfigure)）。
- `revert` 是服务造的 S：S 就是当前的 `p.preset`，走步骤 2，取消待换配置。
- 信箱里排着不止一条 `reconfigure` 时，按到达顺序一条一条处理，后处理的赢。
- `p.next` 只有这里（存、取消、采用）和换段（采用、丢弃）会改，别处不许写它。
- 投影的 `self.pending` 从 `p.next` 和 `p.preset` 算（[投影与命令](#投影与命令)）。

## 决策

跨模块的决定见 [kb-decisions.md](kb-decisions.md)：D4（纯 `decide`）、D5（换段）、D17（单一来源、`failed` 并入 `idle`）、D18（每次调用模型都计步、`endTurn` 的两种补法、`length` 算错误）、D19（每个工具结果后检查阈值、工具被中断就结束本轮、交接调用带工具、`purpose` 存在阶段里）、[D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)（换段阈值、用量估算、段末的用户消息不进交接请求、工具调用太多的回复不写入）、[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)（会话快照可改、待换配置）、[D72](kb-decisions.md#d72-上下文文件开段重读)（上下文文件、开段重读）。

模块内的决定：

- **调用参数立即生效，结构性字段换段时生效。** 提示词、工具和模型是在途请求手里拿着的东西：模型调用拿着旧的系统提示词和工具清单，工具调用拿着旧的工具定义。立即换了，会出现“调用了已被删的工具”。`thinking`、`options`、`handoff` 只在下一次调用时读，立即换没有这个问题。
- **直接采用只限空闲、段里没有助手消息，并且新模型收图或段里没有图，并且段放得下新快照。** 这时没有在途的调用，也没有模型回复过旧的系统提示词，也不会让下一次调用带着图去找一个不收图的模型，也不会让第一次调用就带着一个超过新阈值的整段去换段。
- **采用 `next` 的检查不通过就丢掉它。** 留着，每封信都会交接、每次都失败。丢掉以后进程用旧快照继续，用户再 `reconfigure` 一次。
- **工具结果按位置配对，不按 ID。** ID 来自模型，可能重复或为空：provider 不给 ID 时，pi-ai 填空串。结果总按调用的顺序写入，所以第 k 条结果属于第 k 个调用。
- **工具结果和用户消息都在 `decide` 里统一裁剪。** 库内工具、执行器送回的结果都经过 `onToolResult` 和 `toolResult`；空闲时的消息、合并的排队消息、新段第一条都经过 `userMessage`。信的头、两种形状、张数上限也只在这两个构造函数里做（[张数和省略行](#张数和省略行)）。`read` 和 `bash` 另外自己裁剪输出，巨大的结果不进信箱（[kb-tools.md](kb-tools.md)）。
- **种类不对的结果按过时丢弃。** 编号等于 `lastEffect`，但种类和阶段对不上，也丢弃。忠实的环境里不会出现。
- **运行时遇到 pi-ai 之外的 `stopReason`，按失败结束本轮，不抛错。**
- **上一轮没有正常结束，就在下一条用户消息前面加说明。** 段里不写失败的回复，也不写停止，模型否则看不出上一轮没做完。说明由 `idle` 带的 `ended` 算出，写进消息正文，不加新状态。措辞和理由见 [D25](kb-decisions.md#d25-上一轮没有正常结束时下一条消息加说明)。

## 认知模型

纯函数层是一个状态机：3 个阶段、5 种输入、2 种副作用。处理一条输入只看进程记录和当前段（加上环境里的时间和开段视图）。

判断一次修改是否越界：

- 进内核的功能不加阶段，阶段固定是 3 个。
- 不在状态之外加可变字段。
- 不推翻[不变量](kb-contract.md#不变量)。
- 能从段算出的值不存。
- `p.preset` 只经 `reconfigure`（调用参数立即换，结构性字段在满足[直接采用的条件](#流程会话配置reconfigure)时直接采用）和换段采用 `p.next` 改变；`p.next` 的写法见[流程：会话配置](#流程会话配置reconfigure)。别处改它：越界。
- 调用模型必须经过 `continueTurn`，这样才计步。
- 结束一轮必须经过 `endTurn`，这样每个工具调用都有结果。
- 写入用户消息必须经过 `userMessage`，写入工具结果必须经过 `toolResult`，这样才裁剪、限张数。
- `lastEffect` 只在 `enter` 里加一。

### 不变量

`test/invariants.ts` 的 `assertInvariants(p, seg, relaxed = false)`。纯函数层测试每处理一条输入就检查一次。存储层的不变量复用它，再检查待办副作用表和信箱，见 [kb-store.md](kb-store.md#存储层不变量)。

总是成立：

- `lastEffect` 是非负整数，段号是正整数。
- 工作段的第一条（如果有）是用户消息。
- 每条带工具调用的助手消息后面，紧跟它的结果：顺序相同，`toolCallId` 和 `toolName` 与调用相同，中间没有别的消息。
- 没有孤立的工具结果。只有最后一条助手消息可以缺结果，缺的是末尾连续的一段。

按阶段：

| 阶段 | 不变量 |
|---|---|
| `idle` | 结果齐全；`effectOf` 为 `null`。`ended` 缺省：这个进程自己还没跑过一轮，`lastEffect` 为 0、段号 1；段是空的（`start`），或者是复制来的前缀（`fork` 带 `before`）。有 `ended` 时：取值合法、段不空；`lastEffect >= 1`，只有 `fork` 不带 `before` 建出来的进程例外：`lastEffect` 为 0、段号 1 |
| `awaitingModel` | 运行中的通用约束；结果齐全；最后一条不是助手消息；`effectOf` 是 `callModel(lastEffect, purpose)`；用途的两条蕴含：用量到阈值或者最后一条助手消息里有成功的 `handoff` 调用，推出 `purpose` 是 `handoff`；`purpose` 是 `handoff`、两者又都不成立，推出段末是用户消息、段里有助手消息（[换段信](#换段信)） |
| `awaitingTool` | 运行中的通用约束；有缺结果的调用；`effectOf` 是 `runTool(lastEffect, 第一个缺结果的调用)`；已经写过至少一个结果时，用量没到阈值 |

消息形状（总是成立）：用户消息的 `content` 是字符串，或者一个可有可无的文本块加至少一张图片；工具结果最多一个文本块，在最前；工具结果和段号大于 1 的段的第一条，图片不超过 `IMAGES_PER_MESSAGE`。

运行中的通用约束：`1 <= steps <= STEPS_PER_TURN`；`lastEffect >= steps`；`queued` 是信件数组；`hops` 是非负整数；`replyTo` 没有重复；段不空。

`reconfigure` 改了 `handoff` 以后，上表里和阈值有关的三处可能不成立：`awaitingModel` 里“用量到阈值，用途是 `handoff`”和“用途是 `handoff` 而用量没到阈值，只能是换段信”，`awaitingTool` 的“已经写过至少一个结果时用量没到阈值”。`purpose` 是进入时的判断，不随新阈值重算（[坑点](#坑点)）。所以 `assertInvariants` 的第三个参数 `relaxed` 为真时，这三处不检查，两个方向的不一致都允许。与阈值无关的“最后一条助手消息里有成功的 `handoff` 调用，用途就是 `handoff`”照查，其余不变量也不放松。放宽的范围很窄：从进程在运行中（阶段不是 `idle`）收到一条把 `handoff` 改成不同值的 `reconfigure` 起，到发出下一个副作用（`lastEffect` 变了）或回到 `idle` 为止。测试辅助 `feed`（纯函数层）和 `assertStoreInvariants`（存储层，传一个进程 ID 的集合）各自记着这个范围。进程空闲时改 `handoff`，不放宽。

测试辅助另外检查：

- `test/kernel/helpers.ts` 的 `feed`：冻结旧状态、输入和环境，`decide` 改动它们就抛错；段号只能不变或加一，且新段之前没有消息；用 `World.relaxed` 记着上面的放宽范围，传给 `assertInvariants`。
- `test/kernel/random.test.ts`：同样的输入给同样的结果；`lastEffect` 每次变 0 或 1；不变时副作用不变，或者回到了 `idle`；被丢弃的输入什么都不改；累计用量只在不丢弃的 `ok` 模型结果上增加，增量等于那条回复的用量。信有四种发送者（用户的信、进程的信、带 `replyTo` 的、回信），信和工具结果随机带图片块（每封信最多 2 张）。随机序列里也有 `reconfigure`（新快照随机改调用参数和结构性字段，偶尔是 `revert`），`assertInvariants` 照跑（见上面的放宽）；每条 `reconfigure` 和每次接受或丢弃 `next` 的换段之后，按[流程：会话配置](#流程会话配置reconfigure)检查结果，并统计取消、直接采用、因段放不进新快照而存 `next`、其余存 `next`、换段采用、丢弃各发生过几次。每条输入之后检查回信：一轮结束时 `out` 的收件人、正文、头和跳数都按[寄出的规则](#回信)算出；其余时候 `out` 为空。

## 投影与命令

```ts
function observe(p, segment, siblings, now): Projection;

interface Projection {
  now: Instant;
  self: ProcessView & {
    segment: number;                       // 段号
    segmentAge: number | null;             // 本段开始多久；段空时为 null
    context: { used: number; window: number; threshold: number }; // threshold 是换段阈值
    messages: number;                      // 当前段的消息条数
    usage: Usage;                          // 累计用量，跨段
    pending?: { fields: string[] };        // 有待换配置时：它和当前快照结构性字段里不一样的键名；没有 next 就没有这个键
  };
  siblings: ProcessView[];                 // 同一个预设、不处于 idle 的其他进程
  sameDir?: ProcessView[];                 // 同一个工作目录（不分大小写）、不处于 idle 的其他进程，不看预设（D78）；observe 总是给
  children: ProcessView[];                 // parent 是自己、不处于 idle 的进程
  idleChildren: number;                    // parent 是自己、处于 idle 的进程个数
  running?: number;                        // 传入的全部进程里不处于 idle 的个数（D78）；observe 总是给
}

interface ProcessView { id: ProcessId; preset: string; model: string; phase: PhaseView; age: number; since?: Instant; parent?: ProcessId }

type PhaseView =
  | { tag: "idle"; ended?: Ended }
  | { tag: "awaitingModel"; purpose: Purpose; steps: number; queued: number }
  | { tag: "awaitingTool"; steps: number; queued: number };
```

- 只给时刻和时长，单位毫秒。`age = now - createdAt`。`queued` 只给条数。
- `parent` 没有时没有这个键。`children` 和 `siblings` 都从传入的全部进程记录里按条件挑，保持传入的顺序；子进程也可能同时是兄弟。只看直接的子进程，不含孙子。空闲子进程的 ID 不在投影里：要找，就按 `parent` 从协议 `ps` 的投影里挑。
- `sameDir`、`running`（D78）：和 `siblings`、`children` 各自独立，不去重；去重在 `self` 的文字里做（[kb-store](kb-store.md#self)）。`sameDir` 比较的是快照里 `workdir` 字符串的小写，不处理 junction、符号链接和 8.3 短名。`running` 是对传入记录的计数：`self`、`ps` 传全部进程，含自己；`watch` 传 `[p]`，用不到。写成可选键，因为契约只加可选键，`observe` 总是给。
- `context.threshold` 是 `handoffThreshold(快照)`，含预设的 `handoff`。
- `self.pending.fields`（D71）：`next` 和 `preset` 的结构性字段里不一样的键名，由 `snapshot.ts` 的 `pendingFields` 算。取值只有 `model`、`prompt`、`tools`、`workdir`、`context`，按这个顺序排。`toolDefs` 的内容变了算 `tools`；`contextWindow`、`input` 是按 `model` 查目录得来的，算 `model`。没有 `next` 时 `self` 里没有 `pending` 这个键。它放在 `self` 里，因为协议的 `watch` 的 `update` 只带 `self`，界面靠它知道有待换配置。`self` 工具的文字是同一份（[kb-store](kb-store.md#self)）。`next` 本身不在投影里：要看新快照的全部内容，用协议的 `inspect` 读进程记录。
- `messages` 是当前段的消息条数；`usage` 是进程记录里的累计用量，不是从段里算的。
- `idle` 阶段的出错原因经 `endedReason` 截短（先截到 1024 字节再把换行换成空格）。进程记录里存的仍是原文。运行中的进程没有结束原因，所以只有空闲的自己会出现截短的原因。
- 本地时间、时区和文本格式在纯函数层外：`self` 在事务里（[kb-store.md](kb-store.md#self)），`tau ps` 在 CLI 里（[kb-service.md](kb-service.md#tau-ps-的文字格式)）。
- 纯函数层不加命令。Agent 通过库内工具 `self` 看到投影。

## 入口

| 文件 | 内容 |
|---|---|
| `src/kernel/types.ts` | 全部类型、`unreachable` |
| `src/kernel/decide.ts` | `start`、`decide`（含 `reconfigure` 一支和换段时采用 `next`）、`effectOf`、`continueTurn`、`endTurn`、`sendReplies`（回信）、`endedNote`（上一轮的说明）、`header`、`render`、`fit`、`userMessage`、`toolResult`、`addUsage`、`INTERRUPTED`、`SKIPPED` |
| `src/kernel/snapshot.ts` | 会话快照的比较（D71），纯函数：`pendingFields`（`next` 和 `preset` 的结构性字段差在哪些键，换成对外的名字，投影的 `self.pending` 用它）、`sameStructure`（结构性字段是否相等，稳定序列化后比较，`decide` 的 `reconfigure` 用它；稳定序列化不递归，用显式的栈，见[坑点](#坑点)）、`withCallParams`（`base` 的结构性字段加 `from` 的三个调用参数，`from` 没有的键结果里也没有；`decide` 和服务造 S 都用它） |
| `src/kernel/derive.ts` | 派生值（含 `limits` 的 `contextMax`）、`clip`、`utf8Bytes`、`finalReply`、`endedText`、`endedReason`、常量 |
| `src/kernel/context.ts` | `buildContext`、`tailStart`、`systemPrompt`（含上下文一节）、记忆和上下文两个标题常量、`toolDescriptions`、交接文本、`IMAGE_UNSUPPORTED` |
| `src/presets/tooldefs.ts` | 读工具定义（不在 `kernel` 里，格式见 [kb-tools](kb-tools.md#工具定义)） |
| `src/kernel/observe.ts` | `observe` |
| `src/kernel/tools.ts` | 工具描述、记忆的三个上限 |
| `test/invariants.ts` | `assertInvariants(p, seg, relaxed)` |
| `test/kernel/helpers.ts` | 内存里的 `World`（含 `relaxed`）、`feed`、`reply`、`toolDone` |
| `test/kernel/flow.test.ts` | 第 5 节每一行流程和丢弃规则 |
| `test/kernel/derive.test.ts` | 字节估算、只取整一次、输出上限和阈值、`clip`、`finalReply`、`endedText` |
| `test/kernel/safepoint.test.ts` | 安全点投递和 `handoff` |
| `test/kernel/handoff-letter.test.ts` | 换段信：三个时机各生效一次；段里没有助手消息、非 `done` 结束、步数用完时作废；和阈值或 `handoff` 工具同时成立只换一次；交接中到的信去掉标记 |
| `test/kernel/reconfigure.test.ts` | 会话配置：调用参数在三个阶段都立即换；结构性字段在空闲、段里没有助手消息、新模型收图或段里没有图、段放得下新快照时直接采用并重取视图，否则存 `next`（段里有图而新模型不收图、窗口换小而段放不进，也存 `next`；`>=` 算放不下，和 `fork` 带 `preset` 一致）；嵌套 5000 层的快照比较不爆栈；`next` 被再次 `reconfigure` 替换，换回和当前一样就取消；换段采用 `next`（快照、阈值、记忆视图、上下文视图、系统提示词都是新的）；交接以后的检查在 `next` 上失败：丢弃 `next`、旧快照不变、不死循环；别的原因的交接失败不丢 `next`；新模型不收图片时带过去的图换成说明；`fork` 不带 `next`；投影的 `self.pending` |
| `test/kernel/context-view.test.ts` | 上下文视图（D72）的纯函数部分：`CONTEXT_VIEW_MAX_BYTES`；系统提示词的三段顺序，没有视图时一字不变，模型请求带上下文一节，没有锚点的用量估算也算上它；`limits` 的 `contextMax` 和 `startError`，没声明 `context` 时数字和文字不变，声明了才多一项，窗口刚好够或差 1 token 的边界；`newSegmentUsed` 带 `contextView`，各部分分开报；`start`、`fork`（不带 `to` 复制、带 `to` 用新的）的视图；视图算进 `fork` 带 `to` 的估算 |
| `test/kernel/letters.test.ts` | 信的头和合并、两种形状、工具结果和新段第一条的张数、换段带全部段末消息 |
| `test/kernel/since.test.ts` | `since` 在各转移上的值，`fork` 的 `since`，投影带 `since` |
| `test/kernel/usage.test.ts` | 累计用量：每种回复都加，丢弃的和被中断的不加 |
| `test/kernel/context.test.ts` | 系统提示词、工具描述、交接请求去掉段末用户消息 |
| `test/kernel/acceptance.test.ts` | 换段不会无限循环；5 种窗口下，主路径和三条角落路径的交接请求加交接说明放得进窗口；工具调用太多的回复不写入 |
| `test/kernel/fork-preset.test.ts` | `fork` 带 `to`：快照和记忆视图来自新预设；图片换成说明、形状对；估算和新阈值的边界；用量锚点放行而估算拒绝的反例 |
| `test/kernel/replies.test.ts` | 回信：每种结束原因、最终回复在合并之前算、排队的信里的 `replyTo`、每个进程一封、跳数 |
| `test/kernel/random.test.ts` | 带种子的随机序列（含 `reconfigure`）；每轮结束时 `out` 的收件人、正文、头和跳数都按[寄出的规则](#回信)检查 |
| `test/kernel/longrun.test.ts` | 长跑：进程记录和当前段有上界 |
| `test/kernel/regressions.test.ts` | 审查发现的缺陷的最小反例 |
| `test/kernel-imports.test.ts` | import 和纯度扫描 |

只跑纯函数层测试：`node --test "test/kernel/*.test.ts" test/kernel-imports.test.ts`。完成门槛见 AGENTS.md。

## 坑点

- **按 ID 配对。** 重复或为空的 ID 会让进程永远等一个“已有结果”的调用。`pendingCalls` 和 `endTurn` 都按位置算。验证：`regressions.test.ts` 的重复 ID 用例，`assertInvariants` 的配对检查。
- **过时的结果。** 编号不对、进程 `idle`、种类不对的结果一律丢弃。每个工具都有新编号，所以上一个工具迟到的结果不会被当成下一个的。验证：`flow.test.ts` 的“4.2 丢弃过时和重复的结果”。
- **安全点并入的信，这一轮可能随后异常结束。** 信已经在段里，模型还没写出回复，这一轮就被停止、出错、`length`、工具调用太多、交接失败，或者交接以后步数用完。最终回复是空串，寄信方收到正文为空的回信。下一封信前面的 D25 说明会告诉模型这一点。
- **回信的最终回复要在合并排队的信之前算。** 顺序是补工具结果、算最终回复、寄回信、再合并。先合并，段末就是用户消息，最终回复成了空串，等回信的进程拿不到这一轮的答案。验证：`replies.test.ts` 的“最终回复在合并排队的信之前算”。
- **并入的信会在新旧两段里各有一份。** 换段时它在旧段末尾，也原样带进新段的第一条。数“这条信出现几次”的测试要跳过新段的第一条。
- **步数用完时安全点不合并。** 先查步数，再合并。合并以后再 `continueTurn` 会让发起这一轮的进程拿到空串，而不合并时它拿到最后一条助手消息的正文。
- **换段循环靠步数收住。** 固定部分加记忆到阈值的预设，被启动检查挡在门外，不会进来。差得不远的（固定部分离阈值不到一份交接说明），新段的第一条还会把新段推到阈值，由交接以后的检查兜住：每封信交接一次就以交接失败结束，不会空转到 `stepLimit`。`stepLimit` 仍是最后一道保险：带过去的信让新段到阈值时检查不拦，照常再换一次段，每次换段都计步。不要让交接调用不计步。验证：`acceptance.test.ts`，`images.test.ts`。
- **小窗口由启动检查挡住。** 窗口小于 27,307 时阈值不大于 0，窗口再大一点，固定部分加记忆也可能到阈值。`start` 和 `spawn` 在读出快照时检查（`fork` 带 `preset` 和 `reconfigure` 造新快照时也检查），不通过就启动失败，用户马上知道（[启动检查和交接以后的检查](#启动检查和交接以后的检查)）。通过的预设里，最坏的新段（全部工具、16 KiB 的记忆视图、32 KiB 的第一条消息）仍可能要约 63K 以上；64K 窗口只给预设提示词留约 2.1 到 4.4 KB（见[换段阈值](#换段阈值)）。
- **64K 窗口收图片时阈值很低。** 阈值只有 17,520。带图的信赶上换段时，新段的第一条可能已经超过阈值，于是再换一次段。这一次，信的原文和图被概括进交接说明，图从此丢失。
- **`IMAGE_TOKENS` 只量过一批模型。** 它取全部测量值、文档上限和 5000 里的最大值。以后收图片的预设换成没量过的模型，先量（量法和量过哪些模型见 [D42](kb-decisions.md#d42-第-6-步量-image_tokens核实收图片)，对照的文档估算见 [D48](kb-decisions.md#d48-量-image_tokens-的文档估算和思考级别重试的需求来源)）。最大的测量值 4,763 离 5000 只差 5%。算少了，证明的前提就不成立，请求可能超过窗口。
- **请求里的旧图是成批省略的，库里不变。** 一次请求最多带最近的 K 张；超出时从最早的起整批省略 B 张的整数倍，换成一行说明。这改变旧消息在请求里的样子，是“换段是唯一缩短上下文的办法”的例外（[D40](kb-decisions.md#d40-第-6-步前一半的选择)）。省略只在 `buildContext` 里做，`contextUsed` 的估算仍按全部图片算：宁可高估。
- **2 字节一个 token 是证明的前提。** 阈值检查只看估算。真实分词低于它时，误差按字节累加。误差只在两次真实用量之间累加。一次回复读回多个结果时，每个都少算。最后一次 `turn` 调用之前少算的部分，会让那次回复的用量超过 T + OUT。所以第 2、5、6、8 步都可能不成立，`turn` 调用本身也可能超过窗口。补的结果（S）里随机的 ID 也会被少算：在用的 opencode-go 的 ID 是 `call_` 加 24 个十六进制字符。超过窗口时，同一个请求每次重试都同样失败。量过的数见 [D24](kb-decisions.md#d24-真模型验收)，风险和应对见设计稿的[风险](../docs/design/mvp.md#风险)。
- **在等模型时停止或失败，只靠下一条消息里的说明告诉模型。** 这时段里不写回复，也不写标记。排队的消息照常合并写入。段末是那条用户消息、合并的排队消息，或者最后的工具结果。不加说明时，模型可能把没做完的请求当成还要做的事（[D24](kb-decisions.md#d24-真模型验收)）。在工具运行中停止或被中断时，模型另外还能看到“被中断，结果未知”。
- **说明只加在空闲时收到的消息上。** 合并的排队消息不加，一轮只说一次。停止的说明把排队的消息也一并取消。说明是消息正文，存进段，换段时跟着带过去。不要改成假的助手消息，理由见 [D25](kb-decisions.md#d25-上一轮没有正常结束时下一条消息加说明)。验证：`flow.test.ts` 的“上一轮没有正常结束”。
- **不要在 CLI 或服务的边上截断消息。** 上限只在 `decide` 的 `userMessage` 里检查。边上再截一次是第二个来源，也管不到合并的排队消息和带过来的消息。`turn.queued` 保持原样，直到在安全点或本轮结束时写进段。服务不另设上限（图片除外：入口按[图片的入口检查](kb-service.md#图片)检查，不合格就拒绝，不截断）；经 CLI 发来的消息受 Windows 命令行（32,767 个 UTF-16 单元）限制。
- **交接请求不能带段末的用户消息。** 它们可能在阈值之后才到，大小不受阈值约束。带上它们，停止、步数用完或交接失败之后再发的大消息会让交接请求超过窗口。验证：`acceptance.test.ts` 的三条角落路径。
- **换段失败时旧段也会变。** “旧段不变”只指没有交接说明、没有新段。排队的消息照样合并写进旧段。
- **失败的回复不能写进段。** 写进去会让最后一条助手消息的用量变成 0，上下文用量退回字节估算。
- **`decide` 抛错会卡住整个信箱。** 事务回滚，输入留在信箱最前面，而处理输入总取全局最早的一条（见 [kb-store.md](kb-store.md)）。`decide` 只对不可能的状态抛错，外部来的怪值（未知 `stopReason`、巨大的结果）都要按普通失败处理。
- **`clip` 不能拷贝整串。** 它只数一次全长字节，再扫描保留的头尾。拷贝过整串时，一亿多字符的结果在事务里让 V8 中止。它也不拆开代理对。上限小于省略说明那一行时，输出只有说明行，会超过上限。验证：`regressions.test.ts`。
- **交接调用也带工具。** 这样请求前缀不变。代价是模型可能回 `toolUse`，这算交接失败。
- **`purpose` 是进入时的判断。** `reconfigure` 改了 `handoff` 以后，已经存下的 `purpose` 可能和现算的阈值不一致，两个方向都可能：改低以后，用途 `turn` 的调用等着时用量已经到了新阈值；改高以后，用途 `handoff` 的调用等着时用量其实没到新阈值。不重算，`purpose` 就是进入等待时的决定（[D19](kb-decisions.md#d19-第四轮审查fable-52-复审-d18-之后的文档)）。下一次 `continueTurn` 起按新阈值判断。`assertInvariants` 从运行中改了 `handoff` 起，到发出下一个副作用或回到 `idle` 为止，不检查这几处（[不变量](#不变量)）。
- **`Input` 的字段名不能叫 `process`。** `test/kernel-imports.test.ts` 的扫描把 `.process.` 当成被禁用的全局，所以 `reconfigure` 带新快照的字段叫 `preset`。
- **纯函数里遍历工具定义的 `parameters`，不能递归。** 工具定义只受 16 KB 的大小限制，嵌套的数组或对象能有几千层，递归会爆调用栈；`decide` 一抛错，这条输入就留在信箱队头，所有进程卡住，服务重启也起不来。`snapshot.ts` 的稳定序列化用显式的栈。`JSON.stringify` 自己有栈深限制（Node 24 上嵌套的数组约 4700 层），读工具定义时的大小检查就用它，所以更深的定义进不来，在读文件那一步报错，什么都没写。
- **待换配置要等换段才生效。** 满足[直接采用的条件](#流程会话配置reconfigure)时直接采用，否则存 `next`，等下一次换段（到阈值、`handoff` 工具或[换段信](#换段信)）。要马上换，只能发换段信，它要段里已有助手消息才生效。
- **换段时旧模型写交接说明。** 交接请求用旧快照，所以旧模型出故障时，`next` 里的新模型一直采用不了，换不了模型。这时用 `fork` 带 `preset`（[D52](kb-decisions.md#d52-fork-带-preset给进程换角色)）。
- **采用 `next` 的那次换段，请求前缀变了。** 系统提示词和工具描述换成新的，提示词缓存失效一次。当前段不原样保留：新段只有交接说明和带过去的信。

## 关联模块

- [kb-store.md](kb-store.md)：处理输入的事务、同步待办副作用表、库内副作用；`fresh` 何时算、上下文视图怎么拼。
- [kb-service.md](kb-service.md)：`reconfigure` 请求的校验和新快照的构造。
- [kb-executor.md](kb-executor.md)：执行 `effectOf` 算出的库外副作用。
- [kb-tools.md](kb-tools.md)：`read`、`write`、`edit`、`bash` 的行为。
- [kb-memory.md](kb-memory.md)：`Memory` 接口、记忆的规则和上限。
- [设计稿第 9 节](../docs/design/mvp.md#9-自省)、[kb-service.md](kb-service.md#tau-ps-的文字格式)：`self`、`tau ps` 怎样呈现投影。
- [kb-decisions.md](kb-decisions.md)、[kb-overview.md](kb-overview.md)。
