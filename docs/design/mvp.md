# tau MVP 设计稿

`status: 草稿` · `updated: 2026-11-15`

本稿负责 MVP 的模块细节，直到对应的模块页建立。规则的摘要在 [AGENTS.md](../../AGENTS.md)，理由和核实证据在[决策记录](../../.knowledge/kb-decisions.md)，构建顺序在[执行清单](../plan/mvp-checklist.md)。

本稿经过四轮审查（D14、D17、D18、D19）。被移出 MVP 的功能见 [MVP 不做](#mvp-不做)。

## 1. 目标

MVP 只支持 Windows。结束时，这些事要能做到：

1. 用带记忆的预设启动进程，在命令行里和它对话。
2. 同时运行多个进程，包括同一个预设的多个进程。
3. 用不带记忆的预设启动进程。
4. 进程能读写自己的记忆库；两个并行进程写同一个键时，后写的那个失败，拿到最新值后重试成功。
5. 一个进程经过多次换段后，处理一条输入时读取的数据量不变。
6. Agent 能用 `self` 工具看到自己的上下文用量、时间和正在运行的兄弟进程。
7. 在任何一个副作用的边界杀掉服务，重启后状态正确。
8. 每轮步数用完就结束本轮，不会失控。

## 2. 预设

预设是 `~/.tau/presets/<id>.md`。文件名（不含扩展名）就是预设 ID，也就是 Agent 的身份。

```markdown
---
workdir: E:/piweb
model: <provider>/<model-id>
tools: read, write, edit, bash, memory
---
你是……（角色提示词）
```

- 前置信息只有这 3 个字段，每行一个 `key: value`。出现未知字段就报错。
- `tools` 里的 `memory` 表示进程有记忆库。
- 进程启动时，预设被冻结成快照存进进程记录。之后修改预设文件，只影响新启动的进程。
- 快照里还有一项：从 pi-ai 模型目录查到的这个模型的 `contextWindow`。查不到就启动失败。冻结它，是为了让 `decide` 不做 I/O。调用模型时，执行器仍从模型目录取模型（第 6 节）。

用户要的三种 Agent 是写预设的三种方式，代码里没有这些类型：

| 用法 | 预设怎么写 |
|---|---|
| 全局助手 | `tools` 含 `memory`，`workdir` 不是某个项目 |
| 项目 Agent | `tools` 含 `memory`，`workdir` 是项目目录；一个项目可以写多个 |
| 临时 Agent | `tools` 不含 `memory` |

## 3. 总体结构

```text
src/
  kernel/      纯：类型、工具描述、start、decide、effectOf、observe、buildContext、派生函数
  store/       SQLite：表、处理输入的事务
  executor/    库外副作用：模型和工具。只做开始、中止、上报
  memory/      记忆接口和键值实现
  tools/       read / write / edit / bash 的实现
  presets/     读取预设文件，查模型窗口，生成快照
  protocol.ts  CLI 和服务之间唯一的线协议类型
  server/      命名管道上的 JSON 行协议
  cli/         命令行
```

- `kernel` 只导入 kernel 内部的文件，外部类型只能 `import type`（例如 pi-ai 的消息类型）。
- 工具描述是 `kernel` 里的纯数据：名称、说明、参数，以及它是库内还是库外的副作用。库外工具的实现在 `tools/`。
- `memory` 只依赖 `kernel`。`store` 依赖 `kernel`，通过 `kernel` 里的 `Memory` 接口类型使用记忆，实现由 `server` 传入。`executor` 依赖 `kernel`、`tools` 和 `pi-ai`。`server` 把它们装配起来。`cli` 只依赖 `protocol.ts`。
- 依赖和工具链见 AGENTS.md 的“小而硬规矩”。

## 4. 内核

### 4.1 进程

进程的状态 = 进程记录 + 当前工作段的消息。两者都在库里。

```ts
interface Process {
  id: ProcessId;
  preset: PresetSnapshot;            // 启动时冻结，含 contextWindow
  createdAt: Instant;
  segment: { seq: number; memoryView: string };
  lastEffect: number;                // 最后发出的副作用编号，从 0 开始
  phase: Phase;
}

interface Turn { steps: number; queued: string[] }

type Phase =
  | { tag: "idle"; ended?: Ended }   // ended 缺省：还没跑过一轮
  | { tag: "awaitingModel"; turn: Turn; purpose: "turn" | "handoff" }
  | { tag: "awaitingTool"; turn: Turn };

type Ended = "done" | "stepLimit" | "stopped" | { error: string };
```

规则：

- **同一个事实只有一个来源。** 能从工作段算出来的值不存，由 kernel 里的纯函数算出：

| 值 | 怎么算 |
|---|---|
| 上下文用量 | 段里最后一条用量不为 0 的助手消息：取 `usage.totalTokens`，为 0 时取 `input + output + cacheRead + cacheWrite`；再加上它之后的消息按字节估算。没有这样的助手消息时，全部按字节估算，含系统提示词和记忆视图（系数第 4 步定） |
| 本段开始时间 | 本段第一条消息的 `timestamp` |
| 待执行的工具调用 | 最后一条助手消息里，还没有结果的工具调用 |
| 正在等的副作用 | `effectOf`，见第 4.3 节 |

- **只在某个阶段有意义的数据，放在那个阶段里。** “一轮”的步数和排队的消息只在运行中有意义，所以是运行中两个阶段的字段；上一轮的结束原因只在 `idle` 时有意义。
- 每次进入等待阶段，`lastEffect` 加一。进程在等的副作用编号就是 `lastEffect`，阶段里不另存。
- `segment.memoryView` 是开段那一刻的记忆快照，以后算不出来，所以是正当的状态。
- `turn.steps` 必须存：一轮可能跨越换段，只看当前段算不出一轮走了几步。

### 4.2 输入

```ts
type Input =
  | { kind: "userMessage"; text: string }
  | { kind: "modelResult"; n: number; outcome: { status: "ok"; message: AssistantMessage } | { status: "interrupted" } }
  | { kind: "toolResult"; n: number; outcome: { status: "ok"; content: ToolResultContent } | { status: "interrupted" } }
  | { kind: "stop" };
```

- 输入不带 ID 和时间：事务保证每条输入恰好处理一次，时间由环境传入。
- 模型失败不走单独的分支：pi-ai 把失败写在助手消息的 `stopReason` 和 `errorMessage` 里，`decide` 按 `stopReason` 处理（第 5.3 节）。
- 工具失败是工具结果内容的一部分。
- 进程 `idle`，或者 `modelResult`、`toolResult` 的编号不是 `lastEffect` 时，直接丢弃。

### 4.3 函数

```ts
interface Env { now: Instant; memoryView: string }

function start(id: ProcessId, preset: PresetSnapshot, env: Env): Process;
function decide(p: Process, segment: readonly Message[], input: Input, env: Env): { process: Process; append: Message[] };
function effectOf(p: Process, segment: readonly Message[]): Effect | null;
function observe(p: Process, segment: readonly Message[], siblings: readonly Process[], now: Instant): Projection;
function buildContext(p: Process, segment: readonly Message[]): ModelRequest;

type Effect =
  | { kind: "callModel"; n: number; purpose: "turn" | "handoff" }
  | { kind: "runTool"; n: number; call: ToolCall };
```

- `start` 只建一个 `idle` 进程：段号 1，`lastEffect` 为 0，`memoryView` 取自 `env`。
- `decide` 只返回新的进程记录和要追加的消息。追加的消息一律写进新进程记录的 `segment.seq` 那一段。一次 `decide` 最多换一次段，交接说明的那条助手回复不写进旧段，所以一次只写一段。
- `effectOf` 从阶段和工作段算出进程正在等的副作用，编号是 `lastEffect`：`awaitingModel` 对应 `callModel`，`awaitingTool` 对应第一个待执行的工具调用，`idle` 没有。`decide` 不发出任何副作用。
- `Env.memoryView` 是这个进程的记忆库现在的视图，没有记忆库时为空。`decide` 只在开段时使用它。
- `observe` 只给时刻和时长。本地时间和时区在内核外格式化：`self` 在事务里，`tau ps` 在 CLI 里。
- `buildContext`：
  - 系统提示词 = 预设提示词 + `segment.memoryView`。
  - 工具定义来自 kernel 的工具描述，按预设的 `tools` 选出，`self` 总在。交接调用也带同样的工具，请求前缀不变，提示缓存继续有效。
  - 消息就是工作段。`purpose` 是 `handoff` 时，末尾再加一条不入库的用户消息，内容是交接指令（第 5.4 节）。

### 4.4 处理一条输入

一条输入一个事务：

1. 读出进程记录、当前段和信箱里这个进程最早的一条输入，算出 `Env`。
2. 调用 `decide`。
3. 写回进程记录，追加消息，删除这条输入。
4. 同步副作用。设 `before = effectOf(旧)`，`after = effectOf(新)`：
   - 两者编号相同（包括都没有）：什么都不做。
   - 否则，删掉 `before` 在待办副作用表里的行（如果有）。然后看 `after`：
     - 库外副作用：在待办副作用表里插入一行 `pending`。
     - 库内副作用（`memory_*`、`self`）：在这个事务里执行它，把结果作为 `toolResult` 放进信箱。
     - 不认识的工具，或预设里没有的工具：在这个事务里把一条错误结果作为 `toolResult` 放进信箱。

库内副作用不进待办副作用表，恰好执行一次。事务只通过 `Memory` 接口访问记忆；`self` 的兄弟进程从 `processes` 表读出。

启动进程也是一个事务：写入 `start` 返回的进程记录，把第一条消息作为 `userMessage` 放进信箱。

## 5. 流程

### 5.1 两个辅助步骤

`decide` 里所有“继续”和“结束”都只走这两个步骤。

**`continueTurn(turn)`**：

1. `turn.steps` 达到内核常量 `STEPS_PER_TURN`（暂定 100）：执行 `endTurn(turn, "stepLimit")`。
2. 否则 `turn.steps` 加一。上下文用量达到 `阈值 × contextWindow`（阈值第 4 步定）：进入 `awaitingModel(handoff)`。
3. 否则进入 `awaitingModel(turn)`。

每次调用模型都计一步，不管用途是什么。

**`endTurn(turn, ended)`**：

1. 为每个还没有结果的工具调用补一条结果：进程正在等的那个写“被中断，结果未知”（它可能已经开始），其余写“未执行”。这样每个工具调用都有结果。
2. `turn.queued` 不空：合并成一条用户消息，写入工作段。
3. `ended` 是 `done` 且 `turn.queued` 不空：用新的 `Turn { steps: 0, queued: [] }` 执行 `continueTurn`。
4. 否则进入 `idle`，带上 `ended`。

### 5.2 每种输入

| 输入 | 处理 |
|---|---|
| `userMessage`，进程 `idle` | 写入工作段，用新的 `Turn` 执行 `continueTurn` |
| `userMessage`，进程正在运行 | 放进 `turn.queued` |
| `modelResult` 正常，用途 `turn` | 见第 5.3 节 |
| `modelResult` 正常，用途 `handoff` | 见第 5.4 节 |
| `modelResult` 被中断 | `endTurn(turn, { error: "服务重启，模型调用被中断" })` |
| `toolResult` 正常 | 写入工作段。还有待执行的工具调用，并且上下文用量没到阈值：进入下一个 `awaitingTool`。否则给剩下的工具调用补“未执行”（没有就不补），然后 `continueTurn` |
| `toolResult` 被中断 | `endTurn(turn, { error: "服务重启，工具被中断" })`。后面的工具是模型以为前面成功了才安排的，所以不接着跑 |
| `stop`，进程正在运行 | `endTurn(turn, "stopped")` |
| `stop`，进程 `idle` | 什么都不做 |

工具按顺序执行，一次一个。MVP 里没有自动重试。

### 5.3 模型回复

用途是 `turn` 时，按助手消息的 `stopReason` 处理：

| `stopReason` | 处理 |
|---|---|
| `toolUse` | 写入工作段，进入第一个待执行工具调用的 `awaitingTool`。消息里没有工具调用时，按 `stop` 处理 |
| `stop` | 写入工作段，`endTurn(turn, "done")` |
| `length` | 不写入，`endTurn(turn, { error: "输出被截断" })`：截断的工具调用参数可能不完整 |
| 其它（`error`、`aborted` 等） | 不写入，`endTurn(turn, { error: errorMessage ?? stopReason })` |

失败的回复不写入工作段，所以不会把错误藏起来，也不会让“最后一条助手消息的用量”变成 0。

### 5.4 换段

1. `continueTurn` 发现上下文用量达到阈值时，进入 `awaitingModel(handoff)`。交接指令要求模型不调用工具，写出交接说明：当前目标、进展、下一步、未完成的事，并原样引用最后一条还没回复的用户消息。
2. 交接回复的 `stopReason` 是 `stop` 或 `length`，并且正文不为空：
   - `segment.seq` 加一，`segment.memoryView` 换成 `Env.memoryView`。
   - `decide` 构造一条用户消息作为新段的第一条消息，正文是交接说明，时间戳是 `env.now`。
   - 然后执行 `continueTurn`。
   - `length` 也接受：截断的交接说明好过没有。
3. 其它情况（包括 `toolUse`）：不写入，`endTurn(turn, { error: "交接失败：" + (errorMessage ?? stopReason) })`，旧段保持不变。你再发一条消息，`continueTurn` 会立即重试换段。一直失败，就只能新开一个进程。
4. 阈值要给一个工具结果的上限、交接指令和交接说明留出空间。
5. 换段只发生在 `continueTurn` 里，这时所有工具调用都已经有结果。

## 6. 执行器与崩溃

- 待办副作用表只存进程正在等的库外副作用：`(process_id, n, status)`，`status` 为 `pending` 或 `running`。副作用的内容由 `effectOf` 算出，不存。处理输入的事务怎样同步这张表，见第 4.4 节。
- 执行器：
  1. 在一个事务里：取一个 `pending` 行，读出进程记录和当前段，用 `effectOf` 算出内容，标记为 `running`。
  2. 提交后，立即登记中止开关，再开始真正的动作。这两件事之间不让出。
  3. 完成后，在一个事务里删除这一行，并把结果放进信箱。行已经不在，就不放，丢弃结果。
  4. 处理输入的事务删掉了一个 `running` 行时，执行器中止这个动作。
- 停止和删除这一行在同一个事务里，所以执行器不可能在停止之后再开始一个已被删掉的副作用。
- 执行器内存里只保存一张表：副作用对应的中止开关。这是执行器唯一的活状态。
- 调用模型时，执行器按快照里的模型 ID 从模型目录取模型。查不到时，上报一条 `stopReason` 为 `error` 的助手消息。
- bash 超时或被中止时，结束整棵进程树（Windows 上用 `taskkill /T /F`）。
- 模型的流式文本直接转发给观察者，不进库。
- 启动时，在一个事务里：`running` 的行一律删除，并作为 `interrupted` 结果放进信箱。`pending` 的行从没开始过，正常开始。
- 崩溃注入测试要覆盖每一个事务边界，以及“标记 `running` 的事务提交之后、结果写回之前”这个窗口。

## 7. 存储

### 7.1 位置

```text
~/.tau/
  tau.db          库：预设以外的全部数据
  tau.db-wal      SQLite 自己的文件
  presets/        预设，纯文本
```

备份：停掉服务后复制整个 `~/.tau/`。

### 7.2 表（草图，第 2 步定稿）

| 表 | 列 | 说明 |
|---|---|---|
| `processes` | id, state_json | `state_json` 是 `Process` |
| `segment_messages` | process_id, segment_seq, seq, message_json | 消息直接用 pi-ai 的格式（第 3 步核实字段） |
| `mailbox` | seq, process_id, input_json | `seq` 自增；处理完就删除 |
| `effects` | process_id, n, status | 只存库外副作用 |
| `memory` | version, ns, key, value | `version` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`：不加 `AUTOINCREMENT` 时，SQLite 会复用被删掉的最大编号；`(ns, key)` 唯一 |

- WAL 模式，`synchronous=FULL`。回执承诺“写进库才返回”，所以要求每次提交都落盘。
- `PRAGMA user_version` 记录表结构的版本。版本不一致就拒绝启动，提示重建库。MVP 不做迁移。

### 7.3 为什么处理输入不会随时间变慢

- 处理一条输入，只读这个进程的进程记录和当前段的消息。
- 旧段靠 `(process_id, segment_seq)` 索引定位，不加载，不校验。
- 成本只取决于当前段的大小，而这个大小被换段阈值限制住了。

## 8. 记忆

### 8.1 接口

```ts
interface Memory {
  view(ns: string): string;
  get(ns: string, key: string): { value: string; version: number } | null;
  set(ns: string, key: string, value: string, expected: number | null):
    { ok: true; version: number } | { ok: false; current: { value: string; version: number } | null };
  delete(ns: string, key: string, expected: number):
    { ok: true } | { ok: false; current: { value: string; version: number } | null };
}
```

- 所有函数都是同步的，在事务里执行。
- `ns` 参数的理由：一张表里存着多个库。
- 版本号是全库自增的 ID，永远不复用。每次写入 = 删掉旧行，插入新行。所以“删掉再重建同一个键”之后，旧版本号一定对不上。
- `expected: null` 表示“这个键现在必须不存在”。
- 处理输入的事务只通过这个接口访问记忆。以后换成分层设计，只换实现。

### 8.2 规则

- `tools` 含 `memory` 的进程有记忆库，`ns` 等于预设 ID。不含时没有记忆库和记忆工具，`Env.memoryView` 为空。
- 上限（第 4 步定）：键不超过 128 字节，值不超过 4 KiB，整个库不超过视图预算。超出上限时写入失败，结果里说明原因。
- 视图：按键排序，每行 `key: value`。因为库不超过视图预算，视图永远是全部内容。
- 工具：`memory_get`、`memory_set`、`memory_delete`。视图是开段时的快照；要拿到现在的值和版本号，用 `memory_get`。
- 版本冲突时，工具结果里带上最新值，由模型决定怎么合并。
- 记忆变化不通知兄弟进程。

长期方向（挂载、日志、整理）见[决策记录](../../.knowledge/kb-decisions.md#d6-mvp-的记忆是带版本号的键值存储)。

## 9. 自省

`observe` 是纯函数。`self` 工具和 CLI 的 `tau ps` 用的是同一个函数。

| 范围 | 内容 |
|---|---|
| 自己 | 进程 ID、预设 ID、模型、阶段（运行中含本轮步数和排队消息数；`idle` 含上一轮的结束原因）、第几段、本段开始多久、上下文已用和窗口 |
| 时间 | 现在的时间和时区、进程运行多久 |
| 兄弟 | 同一个预设下不处于 `idle` 的其他进程：ID、阶段、运行多久 |

- `self` 是库内副作用，结果和其它工具一样受工具结果的字节上限约束。
- `self` 只读，这是接口的范围，不是权限边界：有 bash 的进程可以直接运行 `tau` 命令。

## 10. 工具

| 工具 | 说明 |
|---|---|
| `read(path, offset?, limit?)` | 文本文件，带行号；用 `offset` 和 `limit` 控制读多少 |
| `write(path, content)` | 新建或整体覆盖 |
| `edit(path, old, new, replaceAll?)` | 原文精确匹配；不加 `replaceAll` 时原文必须唯一 |
| `bash(command, timeout?)` | 默认超时 120 秒，上限 600 秒；超时或中止时结束整棵进程树；没有后台任务；用哪个 shell 第 3 步定 |
| `memory_get`、`memory_set`、`memory_delete` | `tools` 含 `memory` 时才有 |
| `self` | 总是有 |

- 前四个工具由预设的 `tools` 字段决定。
- 相对路径按 `workdir` 解析。不限制路径：有 bash 就能绕过任何路径限制。
- 所有工具结果共用一个字节上限，超出时保留头尾。

## 11. 服务与 CLI

- `tau serve` 启动服务。它只在命名管道 `\\.\pipe\tau` 上监听，不开 TCP 端口。
- 单实例：在管道上监听成功才算持有锁。同一个管道不能被监听两次，所以不需要锁文件。
- 协议：每个连接发一行 JSON 作为请求，服务回若干行 JSON，然后关闭连接。

| 请求 | 回复 |
|---|---|
| `start`（预设 ID、消息） | 一行回执（进程 ID）；然后是这个进程的流式文本，直到它回到 `idle`；最后一行是从库里取出的最终回复和结束原因 |
| `send`（进程 ID、消息） | 同上 |
| `stop`（进程 ID） | 一行回执 |
| `ps` | 一行快照：每个进程的投影 |

- 回执在命令写进库的事务提交之后才发出。没收到回执就断开时，CLI 提示“结果未知”，不自动重试。
- 流式文本只是预览，最终回复来自库。
- CLI 命令：`tau serve`、`tau start <预设> "消息"`、`tau send <进程> "消息"`、`tau ps`、`tau stop <进程>`。连续使用 `tau send` 就是对话。

## MVP 不做

这些已被移出 MVP。要做其中任何一项，先改本稿和执行清单。理由见 D14、D18 和 D19。

**自主和控制**

- 定时器、自我唤醒。
- Agent 派生临时 Agent，以及进程之间互发消息。
- Agent 的控制命令（例如立即换段）、推送状态行。

**记忆**

- 一个进程挂载多个库、运行中挂载、库的标题和简介。
- 日志。MVP 不删旧工作段，原始对话本来就在库里。
- 记忆的整理、遗忘、分层；把记忆变化通知兄弟进程。

**交互**

- Web UI、图片输入、HTTP 和 SSE。
- `tau chat`、`tau backup`。
- 运行中插话：运行中收到的消息排队到本轮结束。
- 自动重试。

**统计、上限和存储**

- 花费统计和花费上限、并发上限、全局停止、每个预设单独的步数上限。
- `self` 里的记忆统计、“距你上次说话多久”。
- 表结构迁移、项目表、删除旧工作段。

**其它**

- Windows 以外的平台。
- grep 工具、路径限制。
- MCP、扩展、桌面截图、LSP、沙箱、多用户、远程访问、多设备。
- 通知、审批、密钥检测、彻底删除、导入 Pi Web 的数据。

## 风险

| 风险 | 应对 |
|---|---|
| 重写时重新长出同样的复杂度 | 准入规则；YAGNI；同一个事实只有一个来源；代码量预算 |
| 连续多条用户消息：模型出错后你再发消息，或者交接指令接在用户消息后面。有些模型要求用户和助手交替出现（工具结果后面接用户消息的情况，pi-ai 已经处理） | 第 3 步用 pi-ai 和真模型核实；不行再定办法 |
| 自己写循环，要处理工具调用配对、提示缓存和各家模型的差异 | 消息直接用 pi-ai 的格式；配对规则有专门的测试 |
| 换段的质量取决于模型写交接说明的能力，包括能否原样引用最后一条用户消息 | 测试只能验证机制；质量要靠真实使用观察 |
| 普通回复 `length` 截断时，整条回复被丢弃 | 观察实际频率；需要时再定更细的处理 |
| 进程永不删除，`tau ps` 要为每个进程读当前段，会随年头变慢 | 先接受；需要时再定 |
| 服务崩溃后，bash 启动的子孙进程可能继续运行，而工具结果写的是“结果未知” | 第 3 步核实；先接受这个风险 |
| `node:sqlite` 仍是实验 API，几年内可能变化 | 只用最基本的同步 API；变化时只改 `store/` |
| 没有沙箱 | 见 D7；不拦，但能发现、能撤销 |
