# tau MVP 设计稿

`status: 草稿` · `updated: 2026-11-15`

本稿描述 MVP 要做成什么样。用词见 [AGENTS.md](../../AGENTS.md#用词)，决定的理由见 [决策记录](../../.knowledge/kb-decisions.md)，构建顺序见 [执行清单](../plan/mvp-checklist.md)。

文中的类型和表结构都是草图。标了“第 N 步定”的数字和选择，在执行清单的对应步骤里定稿。

## 1. 目标

MVP 结束时，这些事要能做到：

1. 用一个预设启动全局助手，和它对话。
2. 为一个项目写两个预设，同时运行它们的多个进程。
3. 进程能派生临时 Agent，并收到它的报告。
4. 进程能读写自己 Agent 的记忆；两个并行进程写同一个键时，后写的那个失败并重试。
5. 一个进程连续工作很久，经过多次换段，打开它的速度不变。
6. Agent 能看到自己的上下文用量、时间、花费、兄弟进程，并能自己换段、设定时器。
7. 在任何一个副作用的边界杀掉进程，重启后状态正确。
8. 碰到任何一个上限都会暂停，不会失控。

## 2. 三种 Agent 与预设

预设是一个 Markdown 文件，放在 `~/.tau/presets/`。前置信息是配置，正文是角色提示词。

```markdown
---
name: piweb-reviewer        # Agent 的身份，也是记忆的命名空间；改名等于换一个 Agent
project: E:/piweb           # 省略表示全局
workdir: E:/piweb           # 项目 Agent 默认是项目目录
model: <provider>/<model-id>
memory: true                # false 表示这个预设只用来起临时进程
rights:
  read: true
  write: true
  bash: true
  spawn: true               # 能否派生临时 Agent
limits:
  costPerDayUsd: 5
  stepsPerTurn: 100
---
你是……（角色提示词）
```

- **全局助手**：`name: global`，没有 `project`，`memory: true`。
- **项目 Agent**：有 `project`，`memory: true`。
- **临时 Agent**：不需要预设文件。父进程派生时，宿主用父进程的预设快照生成一份：没有记忆，权利是父进程权利和请求权利的交集，派生层数加一。

进程启动时，预设被冻结成快照存进库。之后修改预设文件，只影响新启动的进程。

## 3. 总体结构

```text
src/
  kernel/      纯：类型、decide、observe、buildContext。不得导入任何做 I/O 的模块
  store/       SQLite：表、迁移、事务、备份
  executor/    副作用：模型、工具、定时器。只做开始、取消、上报
  memory/      记忆接口、键值实现、日志
  tools/       read / write / edit / grep / bash
  presets/     读取预设文件、生成快照
  protocol.ts  UI 和服务端之间唯一的线协议类型
  server/      loopback HTTP：命令用 POST，投影和流式文本用 SSE
  ui/          浏览器端，只做投影
  cli/         命令行
```

依赖方向：`kernel` 不依赖任何模块。`store`、`memory` 只依赖 `kernel` 的类型。`executor` 依赖 `kernel`、`tools` 和 `pi-ai`。`server` 把它们装配起来。`ui` 只依赖 `protocol.ts`。

## 4. 内核：状态、输入、输出

### 4.1 进程

```ts
interface Process {
  id: ProcessId;
  preset: PresetSnapshotId;
  parent?: ProcessId;
  depth: number;                 // 派生层数
  segment: { id: SegmentId; seq: number; openedAt: Instant; contextTokens: number; estimated: boolean };
  counters: { nextId: number; stepsThisTurn: number; costToday: Usd; lastUserMessageAt?: Instant };
  children: ProcessId[];
  interjections: Input[];        // 运行中收到、还没送进上下文的输入
  phase: Phase;
}

type Phase =
  | { tag: "idle" }                                         // 等输入
  | { tag: "awaitingModel"; effect: EffectId; purpose: "turn" | "handoff"; attempt: number }
  | { tag: "awaitingTools"; current: EffectId; queue: ToolCall[] }
  | { tag: "cancelling"; effects: EffectId[] }
  | { tag: "paused"; reason: "limit" | "stopAll"; detail: string }
  | { tag: "failed"; error: string }
  | { tag: "closed" };                                      // 临时进程结束后
```

- 阶段只由 `phase` 表示。`counters` 是普通数据，不表示阶段。
- 所有 ID 由 `counters.nextId` 生成，例如 `p12:e34`。`decide` 不需要随机数。

### 4.2 输入

```ts
type Input = { id: InputId; at: Instant } & (
  | { kind: "userMessage"; text: string; images?: Image[] }
  | { kind: "peerMessage"; from: ProcessId; text: string }
  | { kind: "childReport"; child: ProcessId; outcome: "done" | "failed" | "stopped"; text: string }
  | { kind: "timerFired"; timer: TimerId; note: string; lateBy: Duration }
  | { kind: "effectResult"; effect: EffectId; result: EffectResult }
  | { kind: "command"; from: "user" | ProcessId; command: Command }
);
```

`EffectResult` 有三种结果：`ok`、`error`（带 `retryable`）、`interrupted`（崩溃后结果未知）。

### 4.3 输出

```ts
function decide(p: Process, input: Input, env: { now: Instant; preset: PresetSnapshot }): {
  process: Process;
  emits: Emit[];
};

type Emit =
  | { kind: "appendSegment"; message: Message }            // 写进当前工作段
  | { kind: "openSegment"; handoff: string }               // 换段
  | { kind: "effect"; effect: Effect }                     // 交给执行器
  | { kind: "deliver"; to: ProcessId; input: Input }       // 进另一个进程的信箱
  | { kind: "spawn"; process: Process; firstInput: Input } // 新进程
  | { kind: "journal"; entry: JournalEntry };              // 追加日志

type Effect =
  | { kind: "callModel"; purpose: "turn" | "handoff" }     // 库外
  | { kind: "runTool"; call: ToolCall }                    // 库外（记忆工具和 self 例外，见下）
  | { kind: "setTimer"; timer: TimerId; at: Instant; note: string }
  | { kind: "cancelTimer"; timer: TimerId }
  | { kind: "cancel"; effect: EffectId };
```

处理一条输入，就是一个事务：读出进程和输入，调用 `decide`，写回进程，删除这条输入，写入全部 `emits`。

### 4.4 两类副作用

| 类 | 例子 | 执行方式 | 崩溃后 |
|---|---|---|---|
| 库内 | 记忆工具、`self` 工具、定时器的登记和取消 | 一个事务里执行，并写回结果 | 恰好一次 |
| 库外 | 模型调用、read/write/edit/grep/bash | 先标记“运行中”再开始，完成后写回结果 | 标记过“运行中”的，作为 `interrupted` 送回 |

## 5. 一步是怎么走的

### 5.1 普通的一轮

1. `userMessage` 到达，进程处于 `idle`。写入工作段，写入日志，发出 `callModel`，进入 `awaitingModel`。
2. 模型返回带工具调用的回复。写入工作段。按顺序取第一个工具调用，发出 `runTool`，进入 `awaitingTools`，其余的放进 `queue`。
3. 每个工具结果写入工作段。`queue` 不空，就发下一个；空了，就检查上限和换段阈值，然后发出下一次 `callModel`。
4. 模型返回不带工具调用的回复。写入工作段，把它作为“最终回复”写入日志。有父进程就向父进程投递 `childReport`。普通进程回到 `idle`，临时进程进入 `closed`。

工具按顺序执行，一次一个。

### 5.2 插话

- 进程不在 `idle` 时收到的输入，放进 `interjections`。
- 下一次发出 `callModel` 之前，把 `interjections` 写入工作段，然后清空。
- 模型给出了最终回复，但 `interjections` 不空：写入它们，再调用一次模型。
- 插话永远不会插在工具调用和它的结果之间。

### 5.3 中止

1. `stop` 命令到达。对进行中的副作用发出 `cancel`，进入 `cancelling`。
2. 每个被取消的工具调用，补一条“已中止”的工具结果写入工作段，保证每个工具调用都有结果。
3. `interjections` 写入工作段，但不调用模型。
4. 回到 `idle`。
5. 停止一个进程，也会停止它派生的所有子进程。

### 5.4 派生和等待子进程

1. 父进程调用 `spawn` 工具。`decide` 检查权利和派生层数，发出 `spawn`。
2. 子进程从自己的第一条输入开始运行。父进程继续工作。
3. 子进程给出最终回复后，父进程收到 `childReport`：父进程在 `idle` 就被唤醒；正在运行就作为插话。
4. 没有 wait 工具。父进程想等结果，就结束本轮回到 `idle`，报告到达时会唤醒它。

### 5.5 换段

1. 每次准备发出 `callModel(turn)` 之前，检查 `contextTokens / 模型窗口`。达到阈值（第 4 步定）就开始换段。
2. 发出 `callModel(handoff)`：不提供工具，要求模型写交接说明，说明当前目标、进展、下一步和未完成的事。
3. 收到交接说明后，发出 `openSegment`：关闭旧段，开新段。新段的系统提示词 = 预设提示词 + 换段这一刻的记忆视图；第一条消息 = 交接说明；然后写入 `interjections`。
4. 发出 `callModel(turn)`，继续工作。
5. Agent 也可以用 `rollover_now(handoff)` 主动换段，这时跳过第 2 步。
6. 写交接说明失败：重试一次，再失败就进入 `failed`，旧段保持不变。
7. 阈值要给交接说明本身留出空间。

### 5.6 重试

- 模型调用返回 `retryable` 的错误时，由 `decide` 决定是否重试：`attempt` 小于上限，就登记一个短定时器，到点后再发 `callModel`。
- 重试也是一次普通的决策。执行器从不自己重试。

### 5.7 定时器

- 定时器在库里登记，执行器按时间把 `timerFired` 投递给目标进程。
- 启动时已经过期的定时器，立即触发一次，`lateBy` 标明迟到了多久。
- Agent 用 `set_timer` 设定的定时器计入每日唤醒上限；第 5.6 节重试用的内部定时器不计入。

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
| `projects` | id, path | path 是规范化路径，唯一 |
| `preset_snapshots` | id, name, hash, body | 同一内容只存一份 |
| `processes` | id, preset_snapshot_id, parent_id, project_id, state_json | `state_json` 是 `Process` |
| `segments` | id, process_id, seq, opened_at, closed_at, handoff | |
| `segment_messages` | segment_id, seq, message_json | 消息直接用 pi-ai 的格式（第 3 步核实字段） |
| `mailbox` | id, process_id, seq, input_json | 处理完就删除 |
| `effects` | id, process_id, status, effect_json, started_at | |
| `timers` | id, target, at, note | |
| `memory` | ns, key, value, version, updated_at, updated_by | |
| `journal` | seq, at, ns, process_id, kind, text | 只追加 |
| `costs` | day, ns, usd | 每日花费上限用 |

- WAL 模式，`synchronous=FULL`。
- 迁移：`PRAGMA user_version` 加一串按顺序执行的迁移函数。
- 备份：`tau backup` 执行 `VACUUM INTO`。不要在运行中直接复制库文件。
- 图片：MVP 先存在消息里。以后有大块数据，再改成按哈希存的文件。

### 7.3 为什么打开不会随年龄变慢

- 打开一个进程，只读它的 `state_json` 和当前工作段的消息。
- 旧工作段靠索引定位，不加载，不校验。
- 库会变大，但启动和打开的时间只取决于当前工作段的大小，而这个大小被换段阈值限制住了。

## 8. 记忆与日志

### 8.1 接口

```ts
interface Memory {
  view(ns: string, budgetBytes: number): string;
  get(ns: string, key: string): { value: string; version: number } | null;
  set(ns: string, key: string, value: string, expected: number | null, by: ProcessId):
    { ok: true; version: number } | { ok: false; current: { value: string; version: number } | null };
  delete(ns: string, key: string, expected: number, by: ProcessId):
    { ok: true } | { ok: false; current: { value: string; version: number } | null };
  list(ns: string, prefix?: string): { key: string; version: number; bytes: number; updatedAt: Instant }[];
}
```

- 所有函数都是同步的，在库内副作用的事务里执行。
- `expected: null` 表示“这个键现在必须不存在”。
- 内核只通过这个接口访问记忆。以后换成分层设计，只换实现。

### 8.2 规则

- 上限（第 4 步校准）：键不超过 128 字节，值不超过 4 KiB，每个命名空间不超过 256 KiB。
- 视图：按键排序，每行 `key: value`。没超出预算时给出全部键和值；超出时只给出键。
- 视图在换段的那一刻生成，整段不变，以保护提示缓存。
- 工具：`memory_get`、`memory_set`、`memory_delete`、`memory_list`。只有 `memory: true` 的进程才有。
- 版本冲突时，工具结果里带上最新值，由模型决定怎么合并。
- MVP 不把记忆变化通知给兄弟进程。兄弟进程在下次换段，或者调用 `memory_get` 时看到变化。

### 8.3 日志

- 两种记录：`userMessage`（用户原话）和 `finalReply`（进程的最终回复）。
- 和对应的状态变化在同一个事务里追加。
- 格式：`{ v: 1, at, ns, processId, kind, text }`。只加字段，不改字段，不删字段。
- MVP 里只写不读。用途：以后用它重建记忆。

## 9. 自省

### 9.1 投影

`observe(process, world, now)` 是纯函数。`world` 由存储层在一个读事务里收集：兄弟进程、上限的用量、记忆的统计。UI 和 Agent 看的是同一份结果。

| 范围 | 内容 |
|---|---|
| 自己 | 进程 ID、预设名、模型、阶段、第几段、本段开始多久、上下文已用和窗口（标明“实测”或“估算”）、今日花费和上限、本轮步数和上限、子进程 |
| 时间 | 现在的时间和时区、距用户上次说话多久、进程运行多久、自己的定时器 |
| 兄弟 | 同一个 Agent 的其他进程：ID、阶段、开头的任务、运行多久 |
| 记忆 | 键的数量、已用字节和上限 |
| 系统 | 是否处于全局停止、运行中的进程数和上限 |

- 上下文用量：每次模型调用后取实测值；之后新增的消息按估算累加，并标明“估算”。

### 9.2 送达方式

- **拉取**：`self` 工具，返回投影的文本形式，不超过 2 KiB。它是库内副作用。
- **推送**：一行状态，例如 `上下文 62% · 14:05 · 本段 40 分钟 · 今日 $1.20/$5`。附在下一条写入工作段的消息末尾，和消息一起持久化，所以重放时完全一样。触发条件（第 5 步定）：上下文跨过 50%、70%、85%，或者距上次推送超过 30 分钟。

### 9.3 命令

| 命令 | 用户 | Agent | 说明 |
|---|---|---|---|
| 发消息给进程 | 任意进程 | 自己的父进程、子进程、兄弟进程 | |
| 停止进程 | 任意进程 | 只限自己的子进程 | 连带停止子进程 |
| 立即换段 | 任意进程 | 只限自己 | `rollover_now(handoff)` |
| 设定、取消定时器 | 任意进程 | 只限自己 | 计入每日唤醒上限 |
| 派生临时 Agent | — | 权利是自己权利的子集 | 受派生层数限制 |
| 用预设启动进程 | 能 | 不能 | 会借用别的预设的权利 |
| 全局停止、恢复 | 能 | 不能 | |
| 从上限暂停中恢复 | 能 | 不能 | |
| 修改预设、上限 | 改文件 | 不能 | |

MVP 里没有“需要用户确认”的 Agent 命令。会扩大权利的命令直接不给 Agent。

## 10. 工具

| 工具 | 权利 | 说明 |
|---|---|---|
| `read(path, offset?, limit?)` | read | 文本文件，带行号，有大小上限 |
| `grep(pattern, path?, glob?)` | read | 跳过 `.git`、`node_modules`；实现方式第 3 步定 |
| `write(path, content)` | write | 新建或整体覆盖 |
| `edit(path, old, new, replaceAll?)` | write | 原文精确匹配；不加 `replaceAll` 时原文必须唯一 |
| `bash(command, timeout?)` | bash | 走“运行命令”副作用；默认超时 120 秒，上限 600 秒；没有后台任务 |
| `memory_*` | memory | 见第 8 节 |
| `self`、`rollover_now`、`set_timer`、`cancel_timer`、`send` | 总是有 | 见第 9 节 |
| `spawn`、`stop_child` | spawn | 见第 5.4 节和第 9.3 节 |

- 工具列表由预设的权利决定，不另外配置。
- `write` 和 `edit` 拒绝写工作目录以外的路径，也拒绝写 `~/.tau/`。`bash` 不受这个限制，因为没有沙箱。
- 工具结果有字节上限，超出时保留头尾。

## 11. 权利与上限

| 上限 | 默认值（第 5 步校准） | 碰到后 |
|---|---|---|
| 每轮步数（每条输入引起的模型调用次数） | 100 | 进程暂停 |
| 每个 Agent 的每日花费 | 预设里设定 | 这个 Agent 的进程暂停 |
| 全局每日花费 | 配置里设定 | 全部暂停 |
| 同时运行的进程数 | 8 | 新进程排队 |
| 派生层数 | 2 | 拒绝派生 |
| 每天自我唤醒次数 | 24 | 拒绝设定定时器 |
| 每次模型调用的重试次数 | 3 | 进程进入 `failed` |

- 花费由 `pi-ai` 的 `calculateCost(model, usage)` 计算。
- 暂停的进程只能由用户恢复。
- 全局停止：所有进程中止并暂停，定时器不再触发，直到用户恢复。
- 单实例：启动时取得 `~/.tau/lock`（实现方式第 2 步定）。
- 服务只监听 `127.0.0.1`。

## 12. 服务与 UI

- `POST /commands`：发送一条命令。命令写进信箱的事务提交之后才返回，返回就是回执。
- `GET /events`：SSE。推送投影更新，以及带进程 ID 和副作用 ID 的流式文本。
- `GET /processes/:id/segments/:seq`：按段读取历史。
- 检查 Origin 和 Host，必须和本机地址精确一致。
- 断线重连后，重新拉取投影。流式文本丢了也没关系，最终消息来自库。
- UI 只有几个视图：进程列表（按预设分组，显示阶段）、对话（当前工作段，旧段折叠）、投影面板（和 Agent 的 `self` 是同一份）、输入框、停止按钮、全局停止。
- CLI：`tau start`、`tau send <预设或进程> "消息"`、`tau ps`、`tau stop <进程>`、`tau backup`。在第 6 步之前，CLI 在进程内直接驱动内核；之后改为调用 HTTP 接口。

## 13. 技术选型

| 层 | 选择 |
|---|---|
| 语言和运行时 | TypeScript，Node 24；运行方式（tsc 构建或 Node 原生去除类型）第 0 步定 |
| 模型 | `@earendil-works/pi-ai`，精确锁定 `1.0.0`；测试用它的 faux 假模型 |
| 库 | `better-sqlite3`（默认，第 2 步核实）；`node:sqlite` 在 Node 24.14 仍是实验特性 |
| 测试 | vitest |
| 检查 | ESLint，用 `no-restricted-imports` 禁止 `src/kernel/` 导入 I/O 模块 |
| UI | 第 6 步定；默认 React 加 Vite |

不使用 `@earendil-works/pi-coding-agent`。

## MVP 不做

- 记忆的整理、遗忘、分层；把记忆变化通知给兄弟进程。
- 通知渠道、审批收件箱、远程访问、多设备。
- 密钥检测、彻底删除。
- 需要用户确认的 Agent 命令；Agent 用预设启动别的进程。
- MCP、扩展、桌面截图、LSP、沙箱、多用户。
- 模型档位、后台 bash 任务、并行工具调用、任务清单。
- 导入 Pi Web 的数据；自动删除旧工作段。

要做其中任何一项，先改本稿和执行清单。

## 风险

| 风险 | 应对 |
|---|---|
| 重写时重新长出同样的复杂度 | 准入规则；代码量预算；每一步检查 |
| 自己写循环，要自己处理工具调用配对、提示缓存和各家模型的差异 | 消息直接用 pi-ai 的格式；配对规则有专门的测试 |
| 换段的质量取决于模型写交接说明的能力 | 模拟测试只能验证机制；质量要靠真实使用观察 |
| 没有沙箱 | 见 D7；不拦，但能发现、能撤销 |
| `better-sqlite3` 是原生模块，在 Windows 上可能装不上 | 第 2 步核实；装不上就用 `node:sqlite` |

## 待定

| 项 | 在哪一步定 |
|---|---|
| TS 运行方式 | 第 0 步 |
| SQLite 驱动、单实例锁的实现 | 第 2 步 |
| Windows 上 bash 用哪个 shell、grep 的实现、认证方式、预设前置信息怎么解析 | 第 3 步 |
| 换段阈值、记忆的各项上限 | 第 4 步 |
| 推送触发条件、各项运行上限 | 第 5 步 |
| UI 框架 | 第 6 步 |
| 未确认的默认值 | 见[决策记录](../../.knowledge/kb-decisions.md#未确认的默认值) |
