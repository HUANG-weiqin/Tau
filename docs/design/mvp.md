# tau MVP 设计稿

`status: 草稿` · `updated: 2026-11-15`

本稿描述 MVP 要做成什么样。用词见 [AGENTS.md](../../AGENTS.md#用词)，决定的理由见 [决策记录](../../.knowledge/kb-decisions.md)，构建顺序见 [执行清单](../plan/mvp-checklist.md)。

文中的类型和表结构都是草图。标了“第 N 步定”的数字和选择，在执行清单的对应步骤里定稿。

本稿已经按 YAGNI 删减过一次，删掉的内容见 [MVP 不做](#mvp-不做)。

## 1. 目标

MVP 结束时，这些事要能做到：

1. 用全局助手的预设启动一个进程，在命令行里和它对话。
2. 同时运行多个进程，包括同一个预设的多个进程。
3. 用 `memory: false` 的预设启动临时进程。
4. 进程能读写自己的记忆库；两个并行进程写同一个键时，后写的那个失败，拿到最新值后重试成功。
5. 一个进程经过多次换段后，打开它时读取的数据量不变。
6. Agent 能用 `self` 工具看到自己的上下文用量、时间、花费和兄弟进程。
7. 在任何一个副作用的边界杀掉服务，重启后状态正确。
8. 每轮步数用完就结束本轮，不会失控。

## 2. 预设

预设是 `~/.tau/presets/<id>.md`。文件名（不含扩展名）就是预设 ID，也就是 Agent 的身份。

```markdown
---
workdir: E:/piweb
model: <provider>/<model-id>
memory: true
tools: read, write, edit, bash
stepsPerTurn: 100
---
你是……（角色提示词）
```

- 前置信息只有这 5 个字段，每行一个 `key: value`，自己解析。出现未知字段就报错。
- **全局助手**：`global.md`，`memory: true`。
- **项目 Agent**：`workdir` 是项目目录，`memory: true`。
- **临时 Agent**：`memory: false`。和其它预设一样由你启动。
- 进程启动时，预设的字段和正文被冻结进进程记录。之后修改预设文件，只影响新启动的进程。

## 3. 总体结构

```text
src/
  kernel/      纯：类型、decide、observe、buildContext。不得导入任何做 I/O 的模块
  store/       SQLite：表、事务、备份
  executor/    副作用：模型和工具。只做开始、取消、上报
  memory/      记忆接口和键值实现
  tools/       read / write / edit / bash
  presets/     读取预设文件
  protocol.ts  CLI 和服务之间唯一的线协议类型
  server/      命名管道上的 HTTP：命令用 POST，事件用 SSE
  cli/         命令行
```

依赖方向：`kernel` 不依赖任何模块。`store`、`memory` 只依赖 `kernel` 的类型。`executor` 依赖 `kernel`、`tools` 和 `pi-ai`。`server` 把它们装配起来。`cli` 只依赖 `protocol.ts`。

## 4. 内核

### 4.1 进程

```ts
interface Process {
  id: ProcessId;
  preset: PresetSnapshot;            // 启动时冻结
  createdAt: Instant;
  segment: { id: SegmentId; seq: number; openedAt: Instant; contextTokens: number };
  counters: { nextId: number; stepsThisTurn: number; costUsd: number; lastUserMessageAt?: Instant };
  queued: string[];                  // 运行中收到的用户消息，本轮结束后处理
  lastTurn?: { endedAt: Instant; reason: "done" | "stepLimit" | "stopped" };
  phase: Phase;
}

type Phase =
  | { tag: "idle" }
  | { tag: "awaitingModel"; effect: EffectId; purpose: "turn" | "handoff" }
  | { tag: "awaitingTool"; effect: EffectId; rest: ToolCall[] }
  | { tag: "failed"; error: string };
```

- 阶段只由 `phase` 表示。其它字段是普通数据，不表示阶段。
- 所有 ID 由 `counters.nextId` 生成，例如 `p12:e34`。`decide` 不需要随机数。

### 4.2 输入

```ts
type Input = { id: InputId; at: Instant } & (
  | { kind: "userMessage"; text: string }
  | { kind: "effectResult"; effect: EffectId; result: EffectResult }
  | { kind: "stop" }
);

type EffectResult =
  | { status: "ok"; value: unknown }
  | { status: "error"; message: string }
  | { status: "interrupted" };          // 崩溃后结果未知
```

### 4.3 输出

```ts
function decide(p: Process, input: Input, now: Instant): { process: Process; emits: Emit[] };

type Emit =
  | { kind: "appendSegment"; message: Message }   // 写进当前工作段
  | { kind: "openSegment"; handoff: string }      // 换段
  | { kind: "effect"; effect: Effect };           // 交给执行器

type Effect =
  | { kind: "callModel"; id: EffectId; purpose: "turn" | "handoff" }
  | { kind: "runTool"; id: EffectId; call: ToolCall }
  | { kind: "cancel"; target: EffectId };
```

处理一条输入，就是一个事务：读出进程和输入，调用 `decide`，写回进程，删除这条输入，写入全部 `emits`。

### 4.4 两类副作用

| 类 | 包括 | 执行方式 | 崩溃后 |
|---|---|---|---|
| 库内 | `memory_*` 工具、`self` 工具 | 一个事务里执行，并写回结果 | 恰好一次 |
| 库外 | 模型调用、read、write、edit、bash | 先标记“运行中”再开始，完成后写回结果 | 标记过“运行中”的，作为 `interrupted` 送回 |

## 5. 流程

### 5.1 普通的一轮

1. `userMessage` 到达：
   - 进程处于 `idle` 或 `failed`：写入工作段，`stepsThisTurn` 归零，发出 `callModel(turn)`，进入 `awaitingModel`。
   - 进程正在运行：放进 `queued`，什么都不发。
2. 模型返回带工具调用的回复：写入工作段。发出第一个工具调用的 `runTool`，进入 `awaitingTool`，其余的放进 `rest`。
3. 每个工具结果写入工作段。`rest` 不空，就发下一个；空了，就检查步数上限和换段阈值，然后发出下一次 `callModel(turn)`。
4. 模型返回不带工具调用的回复：写入工作段。
   - `queued` 不空：把它们全部写入工作段，开始新的一轮。
   - `queued` 为空：回到 `idle`，`lastTurn.reason` 记为 `done`。

工具按顺序执行，一次一个。

### 5.2 步数上限

- 每次发出 `callModel(turn)` 之前，`stepsThisTurn` 加一。
- 达到预设的 `stepsPerTurn` 时，不再调用模型：回到 `idle`，`lastTurn.reason` 记为 `stepLimit`。
- 你再发一条消息，就开始新的一轮。

### 5.3 停止

1. `stop` 到达，进程正在运行：
   - 对当前副作用发出 `cancel`。
   - 在 `awaitingTool` 时：为当前工具调用和 `rest` 里的每个工具调用，各补一条“已中止”的工具结果，保证每个工具调用都有结果。
   - 在 `awaitingModel(handoff)` 时：放弃这次换段，旧段保持不变。
2. `queued` 写入工作段，但不调用模型。
3. 回到 `idle`，`lastTurn.reason` 记为 `stopped`。
4. 之后到达的 `effectResult`，如果它的 ID 不是当前阶段在等的那个，就直接丢弃。
5. 进程处于 `idle` 或 `failed` 时，`stop` 什么都不做。

### 5.4 换段

1. 每次准备发出 `callModel(turn)` 之前，检查 `contextTokens / 模型窗口`。达到阈值（第 4 步定）就开始换段。
2. 发出 `callModel(handoff)`：不提供工具，要求模型写交接说明，说明当前目标、进展、下一步和未完成的事。
3. 收到交接说明后，发出 `openSegment`：关闭旧段，开新段。新段的系统提示词 = 预设提示词 + 这一刻的记忆视图；第一条消息 = 交接说明。然后发出 `callModel(turn)`。
4. 写交接说明失败：进入 `failed`，旧段保持不变。你再发一条消息，进程就在旧段里继续，到下一个检查点再尝试换段。
5. 阈值要给交接说明本身留出空间。
6. 换段只发生在 `callModel(turn)` 之前，这时所有工具调用都已经有结果，不会拆开一对调用和结果。

`contextTokens` = 上一次模型调用返回的实测用量 + 之后写入的消息的估算（按字节数估算）。

### 5.5 错误

| 情况 | 处理 |
|---|---|
| 模型调用返回错误 | 进入 `failed`，显示错误。你再发一条消息就继续 |
| 模型调用被中断（崩溃） | 进入 `failed`，错误为“服务重启，调用被中断” |
| 工具返回错误 | 作为普通的工具结果写入，由模型决定下一步 |
| 工具被中断（崩溃） | 写入工具结果“被中断，结果未知”，由模型决定下一步 |

MVP 里没有自动重试。

## 6. 执行器与崩溃

- 待办副作用表的每一行有状态：`pending` 或 `running`。
- 执行库外副作用时：
  1. 在一个事务里把这一行标记为 `running`。
  2. 开始真正的动作。
  3. 完成后，在一个事务里删除这一行，并把 `effectResult` 投递进信箱。
- 执行器内存里只保存一张表：副作用 ID 对应的取消开关。这是唯一的活状态。
- 模型的流式文本直接转发给观察者，不进库。
- 启动时：
  - `running` 的库外副作用，一律作为 `interrupted` 投递回去，并删除这一行。
  - `pending` 的副作用从没开始过，正常开始。
- 崩溃注入测试要覆盖每一个事务边界，以及第 1 步和第 2 步之间、第 2 步和第 3 步之间的窗口。

## 7. 存储

### 7.1 位置

```text
~/.tau/
  tau.db          唯一的库
  tau.db-wal      SQLite 自己的文件
  presets/        预设，纯文本
  backups/        tau backup 生成的副本
  lock            单实例锁
```

### 7.2 表（草图，第 2 步定稿）

| 表 | 主要列 | 说明 |
|---|---|---|
| `processes` | id, state_json | `state_json` 是 `Process`，包含冻结的预设 |
| `segments` | id, process_id, seq, opened_at, closed_at, handoff | |
| `segment_messages` | segment_id, seq, message_json | 消息直接用 pi-ai 的格式（第 3 步核实字段） |
| `mailbox` | id, process_id, seq, input_json | 处理完就删除 |
| `effects` | id, process_id, status, effect_json | |
| `memory` | ns, key, value, version, updated_at, updated_by | |

- WAL 模式，`synchronous=FULL`。
- `PRAGMA user_version` 记录表结构的版本。版本不一致就拒绝启动，提示重建库。MVP 不做迁移。
- 备份：`tau backup` 执行 `VACUUM INTO`。不要在运行中直接复制库文件。

### 7.3 为什么打开不会随时间变慢

- 打开一个进程，只读它的 `state_json` 和当前工作段的消息。
- 旧工作段靠索引定位，不加载，不校验。
- 库会变大，但打开的成本只取决于当前工作段的大小，而这个大小被换段阈值限制住了。

## 8. 记忆

### 8.1 接口

```ts
interface Memory {
  view(ns: string, budgetBytes: number): string;
  get(ns: string, key: string): { value: string; version: number } | null;
  set(ns: string, key: string, value: string, expected: number | null, by: ProcessId):
    { ok: true; version: number } | { ok: false; current: { value: string; version: number } | null };
  delete(ns: string, key: string, expected: number, by: ProcessId):
    { ok: true } | { ok: false; current: { value: string; version: number } | null };
}
```

- 所有函数都是同步的，在库内副作用的事务里执行。
- `expected: null` 表示“这个键现在必须不存在”。
- 内核只通过这个接口访问记忆。以后换成分层设计，只换实现。接口保留 `ns` 参数，以后一个进程挂载多个库时不用改接口。

### 8.2 规则

- 每个进程最多有一个记忆库，库 ID 等于预设 ID。`memory: false` 的进程没有记忆库，也没有记忆工具。
- 上限（第 4 步校准）：键不超过 128 字节，值不超过 4 KiB，每个库不超过 256 KiB。
- 视图：按键排序，每行 `key: value`。没超出预算时给出全部键和值；超出时只给出键。
- 视图在开新段的那一刻生成，整段不变，以保护提示缓存。
- 工具：`memory_get`、`memory_set`、`memory_delete`。
- 版本冲突时，工具结果里带上最新值，由模型决定怎么合并。
- 记忆变化不通知兄弟进程。兄弟进程在下次换段，或者调用 `memory_get` 时看到变化。

长期方向（挂载、日志、整理）见[决策记录](../../.knowledge/kb-decisions.md#d6-mvp-的记忆是带版本号的键值存储)。

## 9. 自省

MVP 里 Agent 只能“看”，不能“控”。

`observe(process, siblings, now)` 是纯函数。`self` 工具和 CLI 的 `tau ps` 用的是同一个函数。

| 范围 | 内容 |
|---|---|
| 自己 | 进程 ID、预设 ID、模型、阶段、第几段、本段开始多久、上下文已用和窗口、累计花费、本轮步数和上限 |
| 时间 | 现在的时间和时区、距用户上次说话多久、进程运行多久 |
| 兄弟 | 同一个预设的其他进程：ID、阶段、运行多久 |
| 记忆 | 键的数量、已用字节和上限 |

- `self` 是库内副作用：在一个读事务里收集兄弟进程和记忆统计，再调用 `observe`。结果不超过 2 KiB。
- 花费由 `pi-ai` 的 `calculateCost(model, usage)` 计算。

## 10. 工具

| 工具 | 说明 |
|---|---|
| `read(path, offset?, limit?)` | 文本文件，带行号，有大小上限 |
| `write(path, content)` | 新建或整体覆盖 |
| `edit(path, old, new, replaceAll?)` | 原文精确匹配；不加 `replaceAll` 时原文必须唯一 |
| `bash(command, timeout?)` | 默认超时 120 秒，上限 600 秒；没有后台任务；Windows 上用哪个 shell 第 3 步定 |
| `memory_get`、`memory_set`、`memory_delete` | 只在 `memory: true` 时有 |
| `self` | 总是有 |

- 前四个工具由预设的 `tools` 字段决定。
- 相对路径按 `workdir` 解析。不限制路径：有 bash 就能绕过任何路径限制，所以不做假边界。
- 工具结果有字节上限，超出时保留头尾。

## 11. 上限

| 上限 | 碰到后 |
|---|---|
| 每轮步数（预设的 `stepsPerTurn`） | 结束本轮，回到 `idle` |
| 工具结果的字节数 | 保留头尾 |
| bash 超时 | 结束命令，结果里说明超时 |
| 记忆的键、值、库大小 | 写入失败，结果里说明原因 |

- 单实例：启动时取得 `~/.tau/lock`（实现方式第 2 步定）。

## 12. 服务与 CLI

- `tau serve` 启动守护进程。它只在本机命名管道上监听（Windows 上是 `\\.\pipe\tau`），不开 TCP 端口。浏览器连不上命名管道，所以不需要 Origin 检查。
- `POST /commands`：启动进程、发消息、停止进程。命令写进库的事务提交之后才返回，返回就是回执。
- `GET /events`：SSE。推送投影的变化，以及带进程 ID 和副作用 ID 的流式文本。
- 断线后重新拉取投影即可。流式文本丢了也没关系，最终消息来自库。
- CLI 命令：

| 命令 | 作用 |
|---|---|
| `tau serve` | 启动守护进程 |
| `tau start <预设> "消息"` | 启动一个新进程 |
| `tau send <进程> "消息"` | 给进程发消息 |
| `tau chat <进程>` | 连上一个进程：显示流式输出，读取你的输入 |
| `tau ps` | 列出进程和它们的投影 |
| `tau stop <进程>` | 停止进程 |
| `tau backup` | 备份库 |

- 第 3、4 步里，CLI 在同一个进程内直接驱动内核；第 5 步改为调用守护进程。

## 13. 技术选型

| 层 | 选择 |
|---|---|
| 运行时 | Node 24 直接运行 `.ts`，没有构建步骤。已核实：Node 24.14 运行 `.ts` 不打印警告 |
| 语法限制 | 只用可擦除的 TS 语法（不用 enum、namespace、参数属性）；import 写 `.ts` 扩展名 |
| 类型检查 | `typescript`，只跑 `tsc --noEmit` |
| 测试 | `node:test`。已核实：`node --test` 自动找到 `*.test.ts` |
| kernel 无 I/O 的检查 | 一个扫描 `src/kernel/` 里 import 语句的测试 |
| 模型 | `@earendil-works/pi-ai`，精确锁定 `1.0.0`；测试用它的 faux 假模型 |
| 库 | `better-sqlite3`（默认，第 2 步核实）；`node:sqlite` 在 Node 24.14 仍是实验特性 |

依赖一共 3 个：`pi-ai`、`better-sqlite3`、`typescript`（只在开发时用）。

## MVP 不做

这些在 YAGNI 审查中被移出了 MVP。要做其中任何一项，先改本稿和执行清单。

**自主和控制**

- 定时器、自我唤醒。
- Agent 派生临时 Agent，以及进程之间互发消息。
- Agent 的控制命令（例如立即换段）、推送状态行。

**记忆**

- 一个进程挂载多个库、运行中挂载、库的标题和简介。
- 日志。MVP 不删旧工作段，原始对话本来就在库里。
- 记忆的整理、遗忘、分层。

**交互**

- Web UI、图片输入。
- 运行中插话：运行中收到的消息排队到本轮结束。
- 自动重试。

**上限和存储**

- 花费上限、并发上限、全局停止。
- 表结构迁移、项目表、预设快照去重、删除旧工作段。

**其它**

- grep 工具、路径限制。
- MCP、扩展、桌面截图、LSP、沙箱、多用户、远程访问、多设备。
- 通知、审批、密钥检测、彻底删除、导入 Pi Web 的数据。

## 风险

| 风险 | 应对 |
|---|---|
| 重写时重新长出同样的复杂度 | 准入规则；YAGNI；代码量预算；每一步检查 |
| 自己写循环，要自己处理工具调用配对、提示缓存和各家模型的差异 | 消息直接用 pi-ai 的格式；配对规则有专门的测试 |
| 停止或步数用完后，工作段以工具结果结尾，下一条是用户消息。不同模型对这种形状的要求不同 | 第 3 步用 pi-ai 核实；不行就在结束本轮时补一条固定的助手回复 |
| 换段的质量取决于模型写交接说明的能力 | 测试只能验证机制；质量要靠真实使用观察 |
| 没有沙箱 | 见 D7；不拦，但能发现、能撤销 |
| `better-sqlite3` 是原生模块，在 Windows 上可能装不上 | 第 2 步核实；装不上就用 `node:sqlite` |

## 待定

| 项 | 在哪一步定 |
|---|---|
| SQLite 驱动、单实例锁的实现 | 第 2 步 |
| Windows 上 bash 用哪个 shell、认证方式、pi-ai 的消息格式 | 第 3 步 |
| 换段阈值、记忆的各项上限和视图预算 | 第 4 步 |
| 未确认的默认值 | 见[决策记录](../../.knowledge/kb-decisions.md#未确认的默认值) |
