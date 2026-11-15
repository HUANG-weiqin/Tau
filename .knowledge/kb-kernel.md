# 内核

`updated: 2026-11-15`

## 这个模块是干什么的

内核是 `src/kernel/` 里的类型和纯函数。它不存任何东西。

它负责：

- 进程记录、阶段、输入、副作用、环境的类型。
- `start`、`decide`、`effectOf`：一条输入怎样改变进程记录和工作段，进程在等哪个副作用。
- 派生值：上下文用量、待执行的工具调用、本段开始时间。
- `buildContext`：模型请求。
- `observe`：投影。
- 工具描述：名称、参数、库内还是库外。

它不负责：

- 读写库、处理输入的事务、同步待办副作用表：[kb-store.md](kb-store.md)。
- 执行库外副作用：[kb-executor.md](kb-executor.md)。
- 工具的行为：[设计稿第 10 节](../docs/design/mvp.md#10-工具)。记忆的语义：[设计稿第 8 节](../docs/design/mvp.md#8-记忆)。
- 把投影格式化成文本：`self` 见 [kb-store.md](kb-store.md#self)，`tau ps` 见[设计稿第 11 节](../docs/design/mvp.md#11-服务与-cli)。

本页接管[设计稿](../docs/design/mvp.md)第 4.1 到 4.3 节和第 5 节的细节。纯度规则在 [AGENTS.md](../AGENTS.md)，由 `test/kernel-imports.test.ts` 检查（见 [D15](kb-decisions.md#d15-工具链没有构建步骤)）。

## 架构

### 状态

进程的状态 = 进程记录 + 当前工作段。两者都在库里。

```ts
interface Process {
  id: ProcessId;
  preset: PresetSnapshot;            // 启动时冻结
  createdAt: Instant;                // 毫秒时间戳
  segment: { seq: number; memoryView: string };
  lastEffect: number;                // 最后发出的副作用编号，从 0 开始
  phase: Phase;
}

interface Turn { steps: number; queued: string[] }
type Purpose = "turn" | "handoff";

type Phase =
  | { tag: "idle"; ended?: Ended }   // ended 缺省：还没跑过一轮
  | { tag: "awaitingModel"; turn: Turn; purpose: Purpose }
  | { tag: "awaitingTool"; turn: Turn };

type Ended = "done" | "stepLimit" | "stopped" | { error: string };
```

- `PresetSnapshot` 有 `id`、`workdir`、`model`（`<provider>/<model-id>`）、`tools`、`prompt`、`contextWindow`。`tools` 是 `read`、`write`、`edit`、`bash`、`memory` 的子集。预设文件的格式见[设计稿第 2 节](../docs/design/mvp.md#2-预设)。
- `segment.memoryView` 是开段那一刻的记忆视图。以后算不出来，所以存。
- `turn.steps` 必须存：一轮可以跨越换段。
- `purpose` 存在阶段里：它保存进入等待时的决定。
- 进程在等的副作用编号就是 `lastEffect`，阶段里不另存。
- 工作段的消息是 pi-ai 的 `UserMessage`、`AssistantMessage`、`ToolResultMessage`。
- `Memory` 接口的类型也在 `types.ts`。语义见[设计稿第 8.1 节](../docs/design/mvp.md#81-接口)。

### 输入、副作用、环境

```ts
type Input =
  | { kind: "userMessage"; text: string }
  | { kind: "modelResult"; n: number; outcome: { status: "ok"; message: AssistantMessage } | { status: "interrupted" } }
  | { kind: "toolResult"; n: number; outcome: { status: "ok"; content: ToolResultContent } | { status: "interrupted" } }
  | { kind: "stop" };

interface ToolResultContent { text: string; isError: boolean }

type Effect =
  | { kind: "callModel"; n: number; purpose: Purpose }
  | { kind: "runTool"; n: number; call: ToolCall };

interface Env { now: Instant; memoryView: string }
```

- 输入不带 ID 和时间。事务保证恰好处理一次，时间来自 `Env.now`。
- 模型失败写在助手消息的 `stopReason` 和 `errorMessage` 里，没有单独的输入。
- 工具失败是工具结果的 `isError`。
- `Env.memoryView` 是这个进程的记忆库现在的视图，没有记忆库时为空。`decide` 只在开段时用它。

### 函数

| 函数 | 文件 | 做什么 |
|---|---|---|
| `start(id, preset, env)` | `decide.ts` | 建一个 `idle` 进程：段号 1，`lastEffect` 为 0，`memoryView` 和 `createdAt` 取自 `env` |
| `decide(p, seg, input, env)` | `decide.ts` | 返回 `{ process, append }`，不发出副作用 |
| `effectOf(p, seg)` | `decide.ts` | `idle`：`null`。`awaitingModel`：`callModel(lastEffect, purpose)`。`awaitingTool`：`runTool(lastEffect, 第一个待执行的调用)` |
| `buildContext(p, seg)` | `context.ts` | 模型请求 |
| `observe(p, seg, siblings, now)` | `observe.ts` | 投影 |
| `toolsFor(preset)`、`findTool(preset, name)` | `tools.ts` | 工具描述 |
| `contextUsed`、`pendingCalls`、`segmentStartedAt`、`usageOf`、`clip`、`utf8Bytes` | `derive.ts` | 派生值和字节工具 |

`decide` 的输出约定：

- `append` 一律写进 `process.segment.seq` 那一段。
- 段号最多加一。段号变了，`append` 就是新段的全部消息。
- 交接回复不写进旧段。换段前已有要追加的消息时，`decide` 抛错。所以一次只写一段。
- 只有 `enter` 让 `lastEffect` 加一。一次 `decide` 最多进入一次等待阶段。

`buildContext`：

- 系统提示词由三部分用空行连接：预设提示词；`工作目录：<workdir>`；记忆视图不为空时，`## 记忆（开段时的快照）` 加视图。
- 工具：`toolDefinitions(preset)`，只放 `name`、`description`、`parameters`。交接调用带同样的工具，请求前缀不变。
- 消息就是工作段。`awaitingModel(handoff)` 时，末尾加一条不入库的用户消息 `HANDOFF_INSTRUCTION`。它的时间戳取段里最后一条消息的，段空时取 `createdAt`。

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
| `self` | 无 | 是 | 总在 |

- 参数都是 `additionalProperties: false` 的对象。
- 顺序固定，按上表。
- `findTool` 对不认识的工具和预设里没有的工具都返回 `undefined`。

### 派生值

能从工作段算出来的值不存。

| 值 | 函数 | 怎么算 |
|---|---|---|
| 一条助手消息的用量 | `usageOf(m)` | `usage.totalTokens`；为 0 时取 `input + output + cacheRead + cacheWrite` |
| 上下文用量 | `contextUsed(p, seg)` | 段里最后一条用量不为 0 的助手消息的用量，加上它之后各消息 `content` 的 JSON 按字节估算 |
| 上下文用量（没有这样的助手消息） | `contextUsed(p, seg)` | 系统提示词 + 工具定义的 JSON + 全段 `content` 的 JSON，全部按字节估算 |
| 按字节估算 | 内部 | `ceil(UTF-8 字节数 / BYTES_PER_TOKEN)`。孤立的代理项按 3 字节算 |
| 是否到阈值 | 内部 `overThreshold` | `contextUsed >= HANDOFF_RATIO × contextWindow` |
| 本段开始时间 | `segmentStartedAt(seg)` | 第一条消息的 `timestamp`；段空时没有 |
| 待执行的工具调用 | `pendingCalls(seg)` | 最后一条助手消息的工具调用，去掉前 k 个；k 是它后面的工具结果条数 |
| 正在等的副作用 | `effectOf(p, seg)` | 见上一节 |

### 常量

| 常量 | 值 | 状态 |
|---|---|---|
| `STEPS_PER_TURN` | 100 | 占位值，第 4 步定 |
| `HANDOFF_RATIO` | 0.75 | 占位值，第 4 步定 |
| `BYTES_PER_TOKEN` | 3 | 占位值，第 4 步定 |
| `TOOL_RESULT_MAX_BYTES` | 32 KiB | 占位值，第 4 步定 |

阈值要给一个工具结果的上限、交接指令和交接说明留出空间。

| 固定文本 | 内容 | 用途 |
|---|---|---|
| `INTERRUPTED` | 被中断，结果未知 | `endTurn` 给正在等的调用补的结果 |
| `SKIPPED` | 未执行 | 其余补的结果 |
| `HANDOFF_HEADER` | （这是你在上一个工作段结束时写的交接说明。）加一个空行 | 新段第一条消息的开头 |
| `HANDOFF_INSTRUCTION` | 不调用工具，写交接说明：目标、做了什么和结果、下一步、没完成的事；原样引用还没回复完的最后一条用户消息 | `buildContext` 加在末尾，不入库 |

### 流程：两个辅助步骤

`decide` 里所有“继续”都走 `continueTurn`，所有“结束”都走 `endTurn`。

**`continueTurn(turn)`**

1. `turn.steps >= STEPS_PER_TURN`：`endTurn(turn, "stepLimit")`。
2. 否则步数加一。到阈值：进入 `awaitingModel(handoff)`。
3. 否则进入 `awaitingModel(turn)`。

每次调用模型都计一步，交接调用也算。

**`endTurn(turn, ended)`**

1. 给每个待执行的调用补一条结果，`isError` 为 `true`。阶段是 `awaitingTool` 时，第一个写 `INTERRUPTED`，其余写 `SKIPPED`。其它阶段全部写 `SKIPPED`。
2. `turn.queued` 不空：用空行连接成一条用户消息，时间戳 `env.now`，写入当前段。
3. `ended` 是 `done` 且 `turn.queued` 不空：`continueTurn({ steps: 0, queued: [] })`。
4. 否则进入 `idle`，带上 `ended`。

### 流程：每种输入

| 输入 | 条件 | 处理 |
|---|---|---|
| `userMessage` | `idle` | 写入工作段，时间戳 `env.now`；`continueTurn({ steps: 0, queued: [] })` |
| `userMessage` | 运行中 | 追加到 `turn.queued`。不写段，副作用不变 |
| `stop` | 运行中 | `endTurn(turn, "stopped")` |
| `stop` | `idle` | 什么都不做 |
| `modelResult`、`toolResult` | `idle`，或 `n` 不是 `lastEffect`，或种类和阶段对不上 | 丢弃：进程记录和工作段都不变 |
| `modelResult` 被中断 | 用途 `turn` 或 `handoff` | `endTurn(turn, { error: "服务重启，模型调用被中断" })` |
| `modelResult` 正常 | 用途 `turn` | 见“模型回复” |
| `modelResult` 正常 | 用途 `handoff` | 见“换段” |
| `toolResult` 被中断 | — | `endTurn(turn, { error: "服务重启，工具被中断" })`。后面的工具不再跑 |
| `toolResult` 正常 | — | 见下 |

`toolResult` 正常：

1. 文本经 `clip` 截到 `TOOL_RESULT_MAX_BYTES`，作为第一个待执行调用的结果写入。`toolCallId`、`toolName` 取自调用，`isError` 原样保留。
2. 还有待执行的调用，并且没到阈值：进入下一个 `awaitingTool`。`lastEffect` 加一，步数不变。
3. 否则给剩下的调用补 `SKIPPED`（没有就不补），然后 `continueTurn`。

工具按顺序执行，一次一个。没有自动重试。

### 流程：模型回复（用途 `turn`）

| `stopReason` | 写入段 | 处理 |
|---|---|---|
| `toolUse`，有工具调用 | 是 | 进入 `awaitingTool`，等第一个调用。这里不检查阈值 |
| `toolUse`，没有工具调用 | 是 | `endTurn(turn, "done")` |
| `stop` | 是 | `endTurn(turn, "done")`。带着工具调用时，它们都补 `SKIPPED` |
| `length` | 否 | `endTurn(turn, { error: "输出被截断" })`。不看 `errorMessage` |
| `error`、`aborted`、`pending`、`deferred` | 否 | `endTurn(turn, { error: errorMessage ?? stopReason })` |
| pi-ai 之外的值 | 否 | 同上一行 |

失败的回复不写入。所以错误不会被藏起来，最后一条助手消息的用量也不会变成 0。

### 流程：换段

1. `continueTurn` 发现到阈值，进入 `awaitingModel(handoff)`。`buildContext` 在末尾加交接指令。
2. 交接说明 = 回复里所有 `text` 块用换行连接，再去掉首尾空白。思考块不算。
3. 接受的条件：`stopReason` 是 `stop` 或 `length`，并且交接说明不为空。接受时：
   - `segment` 变成 `{ seq: seq + 1, memoryView: env.memoryView }`。
   - 新段的第一条消息是用户消息：`HANDOFF_HEADER` + 交接说明，时间戳 `env.now`。
   - 用同一个 `turn` 执行 `continueTurn`：步数和排队的消息带到新段。
4. 其它情况（包括 `toolUse` 和空说明）：`endTurn(turn, { error: "交接失败：" + (errorMessage ?? stopReason) })`。不写交接回复，不开新段。排队的消息仍按 `endTurn` 合并写进旧段。
5. 失败后再发一条消息：新的一轮，`continueTurn` 立即再换段。一直失败时，每条消息只调用一次模型。
6. 换段只发生在 `continueTurn` 里。这时所有工具调用都已有结果。

## 决策

跨模块的决定见 [kb-decisions.md](kb-decisions.md)：D4（纯 `decide`）、D5（换段）、D17（单一来源、`failed` 并入 `idle`）、D18（每次调用模型都计步、`endTurn` 的两种补法、`length` 算错误）、D19（每个工具结果后检查阈值、工具被中断就结束本轮、交接调用带工具、`purpose` 存在阶段里）。

模块内的决定：

- **工具结果按位置配对，不按 ID。** ID 来自模型，可能重复或为空：provider 不给 ID 时，pi-ai 填空串。结果总按调用的顺序写入，所以第 k 条结果属于第 k 个调用。
- **所有工具结果在 `decide` 里统一裁剪。** 库内工具、执行器送回的结果都经过这一处。`read` 和 `bash` 另外自己裁剪输出，巨大的结果不进信箱（`src/tools/files.ts`、`src/tools/bash.ts`）。
- **种类不对的结果按过时丢弃。** 编号等于 `lastEffect`，但种类和阶段对不上，也丢弃。忠实的环境里不会出现。
- **运行时遇到 pi-ai 之外的 `stopReason`，按失败结束本轮，不抛错。**

## 认知模型

内核是一个状态机：3 个阶段、4 种输入、2 种副作用。处理一条输入只看进程记录和当前段。

判断一次修改是否越界：

- 新功能只能是新的输入种类或新的阶段。
- 能从段算出的值不存。
- 调用模型必须经过 `continueTurn`，这样才计步。
- 结束一轮必须经过 `endTurn`，这样每个工具调用都有结果。
- `lastEffect` 只在 `enter` 里加一。

### 不变量

`test/invariants.ts` 的 `assertInvariants(p, seg)`。内核测试每处理一条输入就检查一次。存储层的不变量复用它，再检查待办副作用表和信箱，见 [kb-store.md](kb-store.md#存储层不变量)。

总是成立：

- `lastEffect` 是非负整数，段号是正整数。
- 工作段的第一条（如果有）是用户消息。
- 每条带工具调用的助手消息后面，紧跟它的结果：顺序相同，`toolCallId` 和 `toolName` 与调用相同，中间没有别的消息。
- 没有孤立的工具结果。只有最后一条助手消息可以缺结果，缺的是末尾连续的一段。

按阶段：

| 阶段 | 不变量 |
|---|---|
| `idle` | 结果齐全；`effectOf` 为 `null`。`ended` 缺省，当且仅当刚建好：`lastEffect` 为 0、段号 1、段空。有 `ended` 时：取值合法、`lastEffect >= 1`、段不空 |
| `awaitingModel` | 运行中的通用约束；结果齐全；最后一条不是助手消息；`effectOf` 是 `callModel(lastEffect, purpose)`；`purpose` 是 `handoff` 当且仅当用量到阈值 |
| `awaitingTool` | 运行中的通用约束；有缺结果的调用；`effectOf` 是 `runTool(lastEffect, 第一个缺结果的调用)`；已经写过至少一个结果时，用量没到阈值 |

运行中的通用约束：`1 <= steps <= STEPS_PER_TURN`；`lastEffect >= steps`；`queued` 是字符串数组；段不空。

测试辅助另外检查：

- `test/kernel/helpers.ts` 的 `feed`：冻结旧状态、输入和环境，`decide` 改动它们就抛错；段号只能不变或加一，且新段之前没有消息。
- `test/kernel/random.test.ts`：同样的输入给同样的结果；`lastEffect` 每次变 0 或 1；不变时副作用不变，或者回到了 `idle`；被丢弃的输入什么都不改。

## 投影与命令

```ts
function observe(p, segment, siblings, now): Projection;

interface Projection {
  now: Instant;
  self: ProcessView & {
    segment: number;                       // 段号
    segmentAge: number | null;             // 本段开始多久；段空时为 null
    context: { used: number; window: number };
  };
  siblings: ProcessView[];                 // 同一个预设、不处于 idle 的其他进程
}

interface ProcessView { id: ProcessId; preset: string; model: string; phase: PhaseView; age: number }

type PhaseView =
  | { tag: "idle"; ended?: Ended }
  | { tag: "awaitingModel"; purpose: Purpose; steps: number; queued: number }
  | { tag: "awaitingTool"; steps: number; queued: number };
```

- 只给时刻和时长，单位毫秒。`age = now - createdAt`。`queued` 只给条数。
- 本地时间、时区和文本格式在内核外：`self` 在事务里（[kb-store.md](kb-store.md#self)），`tau ps` 在 CLI 里（`src/cli/main.ts`）。
- 内核不加命令。Agent 通过库内工具 `self` 看到投影。

## 入口

| 文件 | 内容 |
|---|---|
| `src/kernel/types.ts` | 全部类型、`unreachable` |
| `src/kernel/decide.ts` | `start`、`decide`、`effectOf`、`continueTurn`、`endTurn`、`INTERRUPTED`、`SKIPPED` |
| `src/kernel/derive.ts` | 派生值、`clip`、`utf8Bytes`、常量 |
| `src/kernel/context.ts` | `buildContext`、`systemPrompt`、`toolDefinitions`、交接文本 |
| `src/kernel/observe.ts` | `observe` |
| `src/kernel/tools.ts` | 工具描述 |
| `test/invariants.ts` | `assertInvariants` |
| `test/kernel/helpers.ts` | 内存里的 `World`、`feed`、`reply`、`toolDone` |
| `test/kernel/flow.test.ts` | 第 5 节每一行流程和丢弃规则 |
| `test/kernel/acceptance.test.ts` | 换段不会无限循环；很多大结果时工作段不超过窗口 |
| `test/kernel/random.test.ts` | 带种子的随机序列 |
| `test/kernel/longrun.test.ts` | 长跑：进程记录和当前段有上界 |
| `test/kernel/regressions.test.ts` | 审查发现的缺陷的最小反例 |
| `test/kernel-imports.test.ts` | import 和纯度扫描 |

只跑内核测试：`node --test "test/kernel/*.test.ts" test/kernel-imports.test.ts`。完成门槛见 AGENTS.md。

## 坑点

- **按 ID 配对。** 重复或为空的 ID 会让进程永远等一个“已有结果”的调用。`pendingCalls` 和 `endTurn` 都按位置算。验证：`regressions.test.ts` 的重复 ID 用例，`assertInvariants` 的配对检查。
- **过时的结果。** 编号不对、进程 `idle`、种类不对的结果一律丢弃。每个工具都有新编号，所以上一个工具迟到的结果不会被当成下一个的。验证：`flow.test.ts` 的“4.2 丢弃过时和重复的结果”。
- **换段循环靠步数收住。** 新段一开始就超过阈值时（例如系统提示词和工具定义已经超过），每次换段都成功，又立即再换段，直到 `stepLimit`。不要让交接调用不计步。验证：`acceptance.test.ts`。
- **换段失败时旧段也会变。** “旧段不变”只指没有交接说明、没有新段。排队的消息照样合并写进旧段。
- **失败的回复不能写进段。** 写进去会让最后一条助手消息的用量变成 0，上下文用量退回字节估算。
- **`decide` 抛错会卡住整个信箱。** 事务回滚，输入留在信箱最前面，而处理输入总取全局最早的一条（见 [kb-store.md](kb-store.md)）。`decide` 只对不可能的状态抛错，外部来的怪值（未知 `stopReason`、巨大的结果）都要按普通失败处理。
- **`clip` 不能拷贝整串。** 它只数一次全长字节，再扫描保留的头尾。拷贝过整串时，一亿多字符的结果在事务里让 V8 中止。它也不拆开代理对。上限小于省略说明那一行时，输出只有说明行，会超过上限。验证：`regressions.test.ts`。
- **阈值的空档（第 4 步处理）。** `toolUse` 回复之后的第一个工具不检查阈值；一条很大的用户消息可能在阈值附近到来；字节估算按 JSON 转义后的字节计。
- **交接调用也带工具。** 这样请求前缀不变。代价是模型可能回 `toolUse`，这算交接失败。

## 关联模块

- [kb-store.md](kb-store.md)：处理输入的事务、同步待办副作用表、库内副作用。
- [kb-executor.md](kb-executor.md)：执行 `effectOf` 算出的库外副作用。
- [设计稿第 10 节](../docs/design/mvp.md#10-工具)：`read`、`write`、`edit`、`bash` 的行为。
- [设计稿第 8 节](../docs/design/mvp.md#8-记忆)：`Memory` 接口和记忆的规则。
- [设计稿第 9 节](../docs/design/mvp.md#9-自省)、[第 11 节](../docs/design/mvp.md#11-服务与-cli)：`self`、`tau ps` 怎样呈现投影。
- [kb-decisions.md](kb-decisions.md)、[kb-overview.md](kb-overview.md)。
