# 服务与 CLI

`updated: 2026-11-18`

## 这个模块是干什么的

服务是 `tau serve` 这个常驻进程。它持有单实例锁，打开库，做启动恢复，再用一个同步的 `pump` 推进全部进程。CLI 是它自己的客户端；协议还有 `history`、`watch`、`fork`、`inspect`、`check`、`memory`、`memory_write`、三个删除（`prune`、`remove`、`sweep`）、`reconfigure` 和 `backup`，给上层用。

它负责：

- 启动顺序：先拿管道（锁），再开库、恢复、处理积压的信箱。
- `pump`：什么时候处理信箱、中止动作、开始副作用。
- 线协议：请求和回复的类型、请求的校验、回执什么时候发。
- 观察者：哪些连接在等哪个进程，最终回复什么时候发、内容怎么算。
- `history` 和 `watch`：读历史，订阅变化，订阅的写缓冲上限。
- `inspect` 和 `check`：原样读进程记录；干跑预设的读取和启动检查。
- `memory` 和 `memory_write`：读写记忆库。
- 图片：`start`、`send` 的入口检查，`blob` 请求。
- `fork`：请求的参数、什么时候拒绝、回执和订阅的推送。复制什么在[纯函数层](kb-kernel.md#fork)。
- 删除：`prune`、`remove`、`sweep` 的请求、拒绝、回执和 `removed` 推送。
- `reconfigure`：请求的参数、校验、怎样造出新快照、回执的 `pending`。输入怎样处理在[纯函数层](kb-kernel.md#流程会话配置reconfigure)。
- `backup`：请求、校验、回执，和同步执行的代价。
- CLI 的命令、输出、退出码，以及“结果未知”。
- `tau ps` 的文字格式。
- 启动脚本 `tau.cmd`、入口 `src/main.ts`、正常退出。

它不负责：

- 存储事务，以及回执承诺的落盘：[kb-store.md](kb-store.md#存储事务)。
- 执行器的开始、中止、催、上报和启动恢复：[kb-executor.md](kb-executor.md)。
- 投影的字段：[kb-kernel.md](kb-kernel.md#投影与命令)。`self` 的文字：[kb-store.md](kb-store.md#self)。
- 预设文件的格式：[设计稿第 2 节](../docs/design/mvp.md#2-预设)。工具，包括 bash 怎样结束进程：[kb-tools.md](kb-tools.md)。

本页接管[设计稿第 11 节](../docs/design/mvp.md#11-服务与-cli)的细节。

## 架构

### 启动顺序

`tau serve` 走 `src/main.ts`，再进 `serve()`（`src/server/serve.ts`）：

1. `main.ts` 建出 `~/.tau/presets/`。幂等，不算状态。
2. `listen(PIPE)`：在 `\\.\pipe\tau` 上监听。成功才算持锁。已有服务时得到 `EADDRINUSE`，报“已经有一个 tau 服务在 … 上运行。”
3. `openDb(~/.tau/tau.db)`。表结构版本不对就抛出（[kb-store.md](kb-store.md#打开库与事务)）。
4. 用库建 `Memory`（`sqliteMemory`）。
5. `createExecutor`：启动恢复，`running` 行变成 `interrupted` 输入（[kb-executor.md](kb-executor.md#崩溃窗口)）。
6. `pump()`：处理完积压的信箱，包括恢复放进去的输入；开始全部 `pending` 行。
7. `serve()` 返回。`main.ts` 在标准错误打印“tau 服务在 … 上运行。按 Ctrl+C 停止。”

- 第 3 到 6 步在监听成功后同步执行。处理请求要等连接上的数据，所以任何请求被处理之前，恢复和第一次 `pump` 已经做完。
- 第 3 到 6 步抛出时，`serve()` 被拒绝。`serve()` 自己不关管道；`main.ts` 的顶层 `await` 被拒绝，进程以退出码 1 结束，管道随之释放。

### `pump`

```text
pump()
  循环 handleNext 直到信箱空：
    返回 abort 时 exec.abort(进程, n)
    进程 hurried 时 exec.hurry(进程, n)    （D104）
    有订阅时 push(进程, update)            （见“历史和订阅”）
    settle(进程)                          （见“观察者和最终回复”）
  循环 exec.startNext 直到 null：
    动作结束 → pump；动作的 promise 被拒绝 → fatal
```

- 只有 `pump` 推进状态。它是同步函数，中间没有 `await`；处理请求也是同步的。所以服务里没有并发：两次 `pump` 不会交错，一个请求的提交和随后的 `pump` 之间不会插进别的请求。
- 催（[D104](kb-decisions.md#d104-bash-前台等待时有信排队最多再等-1-秒就转后台)）：每次 `handleNext` 之后，这个进程若是 `hurried`（`awaitingTool` 且 `turn.queued` 不空，纯函数 `hurried(p)`），就对它正在等的副作用 n 调 `exec.hurry`。这个副作用不在运行、不是内置 bash，什么都不做。同一批里后面才开始的 bash，由执行器开始时自己查（[kb-executor](kb-executor.md#控制流)）。
- 每条输入的 `now` 是那次 `handleNext` 调用时的 `Date.now()`。
- 每个往信箱放输入的地方，后面都跟着一次 `pump`：

| 输入从哪来 | 之后的 `pump` |
|---|---|
| 启动恢复 | `serve()` 末尾 |
| `start`、`send` | `awaitFinal` 发完回执、登记观察者之后 |
| `stop` | 发完回执之后 |
| `reconfigure` | 提交之后、发回执之前：回执的 `pending` 要在 `pump` 处理完以后才读 |
| 动作结束（`complete`） | `run.then(pump)` |
| 库内工具的结果 | 同一个 `handleNext` 循环接着处理 |

- `ps`、`inspect`、`check`、`memory`、`memory_write` 不调用 `pump`。`prune`、`remove`、`sweep` 也不调用：不放输入。`backup` 也不调用：它不是输入，不改任何状态。
- `fatal`：动作的 promise 被拒绝（例如 `complete` 写库失败）时，打印“tau 服务遇到无法继续的错误，退出。重启时会恢复。”，退出码 1。服务正在关闭时忽略。

### 观察者和最终回复

观察者表是 `Map<进程 ID, Set<Socket>>`，只在内存里。`start`、`send` 的连接登记进去，连接关闭就移出。服务崩溃时，它和连接一起消失。

`settle(p)` 在每次 `handleNext` 之后调用。三个条件同时成立，才发最终回复：

1. 有连接在等 `p`。
2. `p` 的阶段是 `idle`。
3. 信箱里没有 `p` 的输入（`SELECT 1 FROM mailbox WHERE process_id = ? LIMIT 1`）。

第 3 条的原因：进程 `idle` 时，刚发的用户消息可能还排在别的输入后面。没有这一条，新消息的连接会收到上一轮的回复。

成立时：

- 读当前段，算出最终回复。`ended` 取 `p.phase.ended`，缺省时为 `null`。
- 移出这个进程的全部观察者。每个连接发一行 `final`，然后关闭。
- 等同一个进程的连接收到同一条最终回复。运行中发来的消息排队到下一个安全点（[kb-kernel.md](kb-kernel.md#安全点投递)）：模型在下一次调用时就看到它。连接仍要等本轮结束，才收到最终回复。

最终回复由纯函数层的 `finalReply` 算，算法见 [kb-kernel.md](kb-kernel.md#最终回复)。`settle` 在提交之后的当前段上调用它。

### 历史和订阅

`history` 是读请求，`watch` 是订阅。两个都不开写事务，不调用 `pump`。

`history`（`process`、可选的 `segment` 和 `from`）：

- 段默认是当前段，`from` 默认是 0。段号从 1 起。
- 每条消息一行 `message`（段号、段内序号、消息），最后一行 `end`（段号、这一段的消息条数），然后服务关闭连接。没收到 `end` 就断开，是没读完。
- 进程不存在、段号小于 1 或大于当前段，回 `error`。段号小于当前段而这一段 0 条消息（已被 `prune` 删掉），也回 `error`；当前段 0 条照常回 `end`。`from` 超过段尾只发 `end`。
- 消息是库里存的 JSON，不做转换。读整段进内存再写出，不分批。
- 客户端看到投影里的消息条数变了，就用 `from` 读新增的部分。

`watch`（可选的 `process`，可选的 `messages`）：

- 订阅表 `Set<{ socket, process, messages, limit }>`，只在内存里，和观察者表分开。`settle` 不看它。
- 订阅时先推快照：带 `process` 时推它的一条 `update`，不带时按进程 ID 推每个进程的 `update`。快照和登记在同一个同步调用里，所以先 `ps` 再 `watch` 不会漏。
- `update` 只有 `self` 部分，不带兄弟和子进程。它由 `observe(新记录, 新段, [新记录], now)` 算出，用的是 `handleNext` 返回的 `process` 和 `segment`，不再读库。有待换配置时，`self.pending` 带着，所以界面不用反复 `inspect` 就知道有（D71，[kb-kernel 的投影](kb-kernel.md#投影与命令)）。
- 每次 `handleNext` 处理了某个进程的输入，`pump` 给订阅它的连接（或订阅全部的连接）推这个进程的 `update`。没有订阅时不算。
- 带 `messages: true`（D64 第 5 组）的订阅，每推一条 `update`，接着推这次追加进段的消息，每条一行 `message`，带 `process`、`segment`、`seq`（和 `history` 的行同形，多一个 `process`）。顺序固定：先 `update`，后它之前追加的消息，所以 `update.messages` 已经把这些消息数在内。
  - 数据来自 `handleNext` 返回的 `appended`，不读库。换段时 `segment` 是新段号、`seq` 从 0 推起；旧段在换段前已推完。
  - `fork` 只推新进程的 `update`，不推复制来的消息：它们和源进程的段一样，要就用 `history` 读。
  - 不带或为 `false` 时不推消息。`messages` 只能是布尔，别的类型回 `error`。
  - 断线以后消息不补推，客户端用 `history` 的 `from` 补。
  - 消息和 `update` 一样受写缓冲上限约束。
- 流式文本照样推：`text`，带进程 ID 和副作用编号。不推最终回复：客户端看到进程回到 `idle`，自己用 `history` 读。
- 删进程时推 `removed`：订阅这个进程的连接和订阅全部的连接都先收到它；订阅这个进程的随后关闭，订阅全部的照常订阅（见[删除](#删除)）。
- 订阅不存在的进程回 `error`，然后关闭。订阅由客户端断开结束。服务登记订阅后恢复读取，请求行之后的字节丢掉，所以多发的字节不会挡住断开。
- 写缓冲上限：推完快照时记下连接的 `writableLength`，记作 S。之后每次推送完，`writableLength` 超过 S + `WATCH_BUFFER_MAX`（1 MiB）就断开这个订阅。
  - `writableLength` 对字符串按字符计，上限也按字符。
  - 不能等快照排空再查：订阅方一直不读、快照又大于管道的缓冲时，快照永远排不空，上限就永远不生效。
  - 一次推送突发超过 1 MiB 字符的快速订阅方也会被断开。真实的模型流式输出远没有这么快。
- 退出：见[退出](#退出)。

### 读记录和干跑（`inspect`、`check`）

两个都是读请求：不开事务，不调用 `pump`，不写库。

`inspect`（可选的 `process`）：

- 每个进程一行 `process`：`process` 是库里存的进程记录，原样、不经 `observe`，出错的原因不截短；`messages` 是当前段的条数；`limits` 是按这个进程现在的会话快照（`preset`，不是待换的 `next`）算的 `Limits`，含 `contextMax`。有待换配置时，`process` 里带着 `next`，界面靠它显示待换的内容；`watch` 的 `update` 里只有 `self.pending`（差在哪些字段），没有 `next` 本身。最后一行 `inspected`（进程个数、`now`），然后关闭。没收到 `inspected` 就断开，是没读完。
- 不带 `process` 时回全部进程，按 ID 升序。带 `process` 时一行加结束行；没有这个进程回 `error`，没有结束行。没有任何进程时只有结束行。
- 记录和条数在同一个同步调用里读，中间不会处理别的输入，所以它们是同一刻的。条数只数当前段（`COUNT`），不读消息。记录加上 `history` 读这一段的前 `messages` 条，就是那一刻的状态。
- 逐行写，不拼成一个大串。`watch` 不推原样记录：体积大、频率高。要详情就按需 `inspect`。

`check`（`preset`，可选 `workdir`）：

- 用 `start`、`fork`、`spawn` 同一个读预设的函数（`loadPreset`，含工具定义）。读不出，回 `error`，文字和 `start` 一字不差。带 `workdir` 时和 `start` 带它一样：替换预设里的工作目录，检查不变（[D77](kb-decisions.md#d77-spawnstartcheck-带-workdir)）。
- 读得出，回一行 `check`：`snapshot` 是此刻文件读成的快照（含声明的 `context`，不查文件在不在），`limits` 是它的限度，`error` 是 `startError` 的原文，`null` 表示此刻能启动。然后关闭。
- 不读库，不开事务。它只描述此刻的文件；已有进程的限度看 `inspect` 的 `limits`。
- 契约：读预设时的任何拒绝，只许加在 `loadPreset`（含它拆出的 `parsePresetFile`、`buildPreset`）、`loadToolDefs`、`startError` 里。这样 `check`、`start` 和 `reconfigure` 永远一致。

### 调用方定的 ID 和以谁的名义寄信

- `start`、`fork` 的 `id`：字符集 `[0-9a-z][0-9a-z_-]{0,31}`。已存在回 `error`，什么都不写，所以回执丢了以后用同一个 `id` 重试是幂等的。删掉的 ID 可能被重新用上，上层按（`id`，`createdAt`）认进程。
- `start` 不带 `from`、`reply`、`handoff`：新进程的段是空的，没有可交接的内容，第一封信也没有在等的一轮。要回信的派生用 `spawn` 或声明的 `spawn`。
- 一次工具调用里要寄的信，用 `post`，或者在工具结果里声明，这样信和工具结果在同一个事务里。不在工具调用里的调用方（上层程序、界面、计划任务）才用 `send` 带 `from`。

### 读写记忆（`memory`、`memory_write`）

D64 第 6 组。服务不直接写 SQL，也不直接调 `memory.set`：读经 `Memory` 的 `entries`、`namespaces`，写经存储事务 `writeMemory`（[kb-store](kb-store.md#存储事务)）。两个都不调用 `pump`：不放输入，也不动进程。

`memory`（可选的 `ns`）：

- 带 `ns`：回一行 `memory`（`ns`、`entries: { key, value, brief, updated, version }[]`，按键的 UTF-8 字节序；`updated` 是毫秒），然后关闭。没有键时 `entries` 是空数组。
- 不带 `ns`：回一行 `namespaces`（`ns: string[]`，有键的全部 ns，按字节序），然后关闭。

`memory_write`（`ops`）：

- `ops` 是非空数组。每项是 `{ kind: "set", ns, key, value, brief?, expected }`（`brief` 可以没有，有就要是字符串，没有时用 `briefOf(value)`；`expected` 是 `null` 或正整数）或 `{ kind: "delete", ns, key, expected }`（`expected` 是正整数，不能是 `null`）。没有不带版本号的强写。
- 整批在 `writeMemory` 一个事务里，按顺序执行，所以顺序有关（库满时先删后写才行）。更新时间是服务处理这个请求时的 `now`，一批里都一样。成功回 `memory_written`（`versions`：每项的版本，`delete` 是 `null`）。
- 失败回 `memory_rejected`（`index` 是第一个失败的项，`result` 是 `Memory` 的失败形状：版本冲突带 `current`，超出上限带 `over`（`key`、`value`、`view`）和 `bytes`）。整批已回滚。版本冲突和超出上限是正常回复，不是 `error`。
- 请求不合格（形状不对、`ns` 不合法、`ops` 为空）回 `error`，什么都不写：整批先校验，再执行。
- `ns` 要过 `checkPresetId`（和 `loadPreset` 同一个函数），不要求预设存在。

### 线协议（`src/protocol.ts`）

每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭连接。

```ts
type Request =
  | { op: "start"; preset: string; text: string; images?: string[]; id?: string; workdir?: string }   // images 是 base64；id 是调用方定的进程 ID；workdir 替换预设里的工作目录（D77）
  | { op: "send"; process: string; text: string; images?: string[]; handoff?: boolean; from?: string; reply?: boolean }
  | { op: "stop"; process: string }
  | { op: "ps" }
  | { op: "fork"; process: string; before?: number; preset?: string; id?: string } // before 是当前段里一条用户消息的段内序号；preset 是换角色
  | { op: "history"; process: string; segment?: number; from?: number }
  | { op: "blob"; hash: string }                            // hash 不带 blob: 前缀
  | { op: "watch"; process?: string }
  | { op: "inspect"; process?: string }                // 原样读进程记录
  | { op: "check"; preset: string; workdir?: string } // 干跑预设的读取和启动检查；workdir 同 start
  | { op: "memory"; ns?: string }                      // 读记忆；不带 ns 列 ns
  | { op: "memory_write"; ops: MemoryOp[] }            // 整批一个事务
  | { op: "prune"; process: string; before: number }   // 删段号小于 before 的旧段
  | { op: "remove"; process: string }                  // 删一个空闲、没人引用的进程
  | { op: "sweep" }                                    // 清掉没人引用的图片
  | { op: "reconfigure"; process: string; fields?: ReconfigureFields; revert?: true } // 改这个会话的快照；fields 和 revert 恰好给一个
  | { op: "backup"; path: string };                    // 把整个库复制成一个文件

interface ReconfigureFields {   // 至少一个键；值 null 表示删掉这个键
  model?: string;               // <供应商>/<模型 ID>
  tools?: string[];             // 名字和预设文件 tools: 一行里的一样
  thinking?: ThinkingLevel | null;
  handoff?: number | null;      // 正整数
  options?: object | null;
  prompt?: string;
  workdir?: string;             // Windows 绝对路径
  context?: string[] | null;
}

type Reply =
  | { type: "receipt"; process: string }                    // 命令的事务提交之后；fork 的回执带新进程的 ID
  | { type: "text"; process: string; n: number; delta: string; kind?: "thinking" | "toolCall" } // 流式文本，只是预览；n 是副作用编号；kind 没有就是正文
  | { type: "final"; reply: string; ended: Ended | null }   // 从库里取
  | { type: "ps"; processes: Projection[] }
  | { type: "message"; process?: string; segment: number; seq: number; message: Message } // history 的行没有 process；watch 推的有
  | { type: "end"; segment: number; messages: number }      // history 读完
  | { type: "process"; process: Process; messages: number; limits: Limits } // inspect 的一行
  | { type: "inspected"; count: number; now: Instant }      // inspect 的结束行
  | { type: "check"; snapshot: PresetSnapshot; limits: Limits; error: string | null }
  | { type: "memory"; ns: string; entries: { key: string; value: string; version: number }[] }
  | { type: "namespaces"; ns: string[] }
  | { type: "memory_written"; versions: (number | null)[] }
  | { type: "memory_rejected"; index: number; result: MemoryFailure } // 正常回复，不是 error
  | { type: "blob"; mimeType: string; data: string }        // data 是 base64
  | { type: "update"; self: Projection["self"] }            // watch 的快照和增量
  | { type: "removed"; process: string }                    // watch 推送：这个进程已删
  | { type: "swept"; blobs: number }                        // sweep 删掉的图片行数
  | { type: "reconfigured"; process: string; pending: boolean } // reconfigure 的回执：处理完以后这个进程有没有待换配置
  | { type: "backed_up"; path: string; bytes: number }      // backup 的回执：文件路径和字节数
  | { type: "error"; message: string };
```

| 请求 | 服务做什么 | 回复 |
|---|---|---|
| `start` | `checkImages` 检查图片；`loadPreset` 读预设；进程 ID 取请求的 `id`，没有就生成；`startProcess`（启动检查不通过就抛错，回 `error`，什么都不建） | `receipt`，若干 `text`，`final` |
| `send` | `checkImages` 检查图片；`send` 放进一封用户的信；进程不存在就抛出。`handoff` 为真时信带 `handoff: true`（换段信，生效的时机和条件见 [kb-kernel](kb-kernel.md#换段信)）；为假或没有时不写这个键。带图片的路径保留这个键。带 `from`（进程 ID）：以它的名义寄出，发送者、跳数、`replyTo` 由 `send` 事务从它的记录构造（[kb-store](kb-store.md#存储事务)）；`reply` 为真时要回信。`from` 不存在、等于目标、跳数超限回 `error`，什么都不写。请求里别的字段（`hops`、`replyTo`、发送者）一概不读 | 同上 |
| `stop` | `send` 放进一条 `stop` | `receipt` |
| `fork` | 进程 ID 同 `start`（请求的 `id` 或生成）；带 `preset` 时，用 `loadPreset` 读预设（含工具定义），读不出就回 `error`；`forkProcess`（拒绝的情形见下，什么都不建）。提交之后，给订阅的连接推新进程的 `update`，再回执。不调用 `pump`：没有输入要处理 | `receipt`，然后关闭；拒绝回 `error` |
| `ps` | 读全部进程记录；每个进程 `observe(p, 当前段, 全部进程, now)` | 一行 `ps` |
| `history` | 读一段的消息 | 若干 `message`，一行 `end`，然后关闭 |
| `inspect` | 读进程记录和当前段条数；`limits(快照)` | 若干 `process`，一行 `inspected`，然后关闭。没有这个进程回 `error` |
| `check` | `loadPreset`，`limits`，`startError` | 一行 `check`，然后关闭。读不出回 `error` |
| `memory` | `memory.entries(ns)` 或 `memory.namespaces()`；不开事务 | 一行 `memory` 或 `namespaces`，然后关闭 |
| `memory_write` | `writeMemory`（见[读写记忆](#读写记忆memorymemory_write)） | 一行 `memory_written` 或 `memory_rejected`，然后关闭；请求不合格回 `error` |
| `blob` | 读一张图片：`hash` 不带 `blob:` 前缀。不开写事务 | 一行 `blob`，然后关闭。`hash` 不存在回 `error` |
| `watch` | 推快照，登记订阅 | 一直推 `update`、`text`，带 `messages: true` 时还有 `message`，直到客户端断开 |
| `prune` | `pruneSegments`（见[删除](#删除)） | `receipt`，然后关闭；拒绝回 `error` |
| `remove` | 查执行器 `busy`，再 `removeProcess`；提交之后推 `removed`，再回执 | `receipt`，然后关闭；拒绝回 `error` |
| `sweep` | `sweepBlobs` | 一行 `swept`，然后关闭；拒绝回 `error` |
| `reconfigure` | 读进程记录，造新快照，`startError`，放进信箱，`pump`（见[会话配置](#会话配置reconfigure)） | 一行 `reconfigured`，然后关闭；出错回 `error`，什么都不改 |
| `backup` | `VACUUM INTO` 到 `path`（见[备份](#备份backup)）。同步，不开写事务，不调用 `pump` | 一行 `backed_up`，然后关闭；出错回 `error` |
| 处理时抛出 | — | 一行 `error`，然后关闭 |

- `start` 和 `send` 走同一条路径：提交，然后 `awaitFinal`（发回执、登记观察者、`pump`）。
- 回执在事务提交之后才发。库是 `synchronous = FULL`，所以回执表示已经落盘。
- `fork` 的拒绝（都回 `error`，库里什么都没写）：没有这个进程；带 `before` 时，`before` 超出当前段，或那条消息不是用户消息；不带 `before` 时源进程不是 `idle`；带 `preset` 时，预设读不出，或复制来的段放不进新预设的换段阈值；新进程通不过启动检查。复制什么、为什么这样拒绝，见 [kb-kernel 的 fork](kb-kernel.md#fork)。源进程在运行时，带 `before` 的 `fork` 照常可以。
- `fork` 的回执在事务提交之后才发，之前先推 `update`：订阅的客户端收到回执时，已经见过新进程。`update` 由 `observe` 用 `forkProcess` 返回的记录和段算出，不读库。
- `stop` 的回执只表示停止进了信箱。随后的 `pump` 同步处理它，并中止正在运行的动作。进程已经 `idle` 时停止什么都不做，回执照发。
- 停止救不了的卡住：信箱队头的一条输入抛错，`handleNext` 每次都在它这里抛出，全部进程都卡住，后来的停止也排在它后面。这是代码的缺陷：修代码再重启，这条输入重新处理（[kb-store 的坑点](kb-store.md#坑点)）。
- `ps` 的进程按 ID 排序，包括 `idle` 的。每个投影带自己的 `now` 和 `siblings`。
- `error` 可能跟在回执后面：`awaitFinal` 里的 `pump` 抛出时（见[坑点](#坑点)）。
- 客户端可以在回执之后直接断开（`destroy`）：服务照常处理，不再给它写。`tau send` 被 Ctrl+C 就是这样。
- 没有单独的“寄信不等回复”的请求。它就是 `send` 收到回执后断开（[D29](kb-decisions.md#d29-放到上层的和不做的)）。

### 请求的校验（`parseRequest`）

- 每个连接只读第一行。`\r\n` 算一个换行。
- 不是合法 JSON：`error`，内容是 `JSON.parse` 的错误信息。
- 必须是带 `op` 的对象，字段类型要对：`start` 要字符串 `preset`、`text`；`send` 要字符串 `process`、`text`，可选的 `handoff` 要是布尔，可选的 `from` 要是字符串，可选的 `reply` 要是布尔、而且为真时必须有 `from`；`start`、`fork` 可选的 `id` 要是字符串，匹配 `[0-9a-z][0-9a-z_-]{0,31}`（ID 原样进信头和 `self` 的文字，上层还拿它拼路径）；`stop` 要字符串 `process`；`fork` 要字符串 `process`，可选的 `before` 要是非负整数，可选的 `preset` 要是字符串；`history` 要字符串 `process`，可选的 `segment`、`from` 要是非负整数；`blob` 要字符串 `hash`；`start`、`send` 的 `images` 可以没有，有就要是字符串数组；`watch`、`inspect` 的 `process` 可以没有，有就要是字符串；`check` 要字符串 `preset`；`memory` 的 `ns` 可以没有，有就要是字符串、过预设 ID 的检查（不合法回“预设 ID 不合法：<ns>”）；`memory_write` 要非空数组 `ops`，每项是上面的两种形状之一（`set` 的 `brief` 可以没有，有就要是字符串），每项的 `ns` 也过预设 ID 的检查；`prune` 要字符串 `process`、非负整数 `before`；`remove` 要字符串 `process`；`sweep` 不要字段；`reconfigure` 和 `backup` 的校验见下面各自一节。否则 `error`：“无法识别的请求：<原文>”。
- 只查类型。空串能通过，多余的字段被忽略。空预设 ID 由 `loadPreset` 拒绝；空消息会成为一条用户消息。CLI 不发空消息。
- 预设读不出、进程不存在、进程 ID 冲突，都回 `error`。这些情况下库里什么都没写。

### 删除

三个请求（D59，[决策](kb-decisions.md#d59-删除原语旧段和空闲进程)）。事务做什么、读什么、为什么，见 [kb-store](kb-store.md#删除)。什么时候删由上层定。三个请求都不放输入，不调用 `pump`。

- `prune`（`process`、`before`）：提交之后回 `receipt`（`process` 是请求里的进程 ID），然后关闭。没有这个进程、`before` 大于当前段号，回 `error`，库里什么都不改。
- `remove`（`process`）：
  - 调用 `removeProcess` 之前多查一条，这条不在库里：执行器里还有这个进程的动作没收尾（停止以后，被中止的动作还没结束），就回 `error`。理由：动作收尾（`complete`）按 `(进程 ID, n)` 找行；进程删了、ID 又被新进程碰上，旧动作的结果会落进新进程。执行器为此给只读的 `busy(id)`（[kb-executor](kb-executor.md#活状态)）。崩溃以后没有这样的动作，所以只有服务活着时才有这一条。
  - 事务的拒绝（不是 `idle`、信箱里有它的输入、有子进程、被引用，见 [kb-store](kb-store.md#存储事务)）都回 `error`，库里什么都不改。
  - 提交之后，先给两种订阅都推一行 `removed`：订阅这个进程的连接和订阅全部的连接都收到；订阅这个进程的随后关闭，订阅全部的照常订阅。然后回 `receipt`，然后关闭。先推后回执，和 `fork` 一样。
  - 删的时候没有观察者在等它：它是 `idle`，信箱里没有它的输入，`settle` 已经发过最终回复。
- `sweep`：提交之后回一行 `swept`（`blobs` 是删掉的行数），然后关闭。它扫全库，期间服务停着不处理别的事。上层批量清理完再调一次。
- ID 复用：`remove` 以后，这个 ID 可能被新进程碰上。无害：删之前已经确认没有任何地方引用它，执行器也没有它的动作（D59）。

### 会话配置（`reconfigure`）

[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)。改一个进程的会话快照：只改这个会话，不碰预设文件，不碰别的会话。输入怎样被处理、哪些字段立即生效、哪些等换段，见[纯函数层](kb-kernel.md#流程会话配置reconfigure)。服务做的是校验、造出完整的新快照 S、放进信箱。

请求 `{ op: "reconfigure", process, fields?, revert? }`：

- `fields` 的键：`model`（`<供应商>/<模型 ID>`）、`tools`（字符串数组）、`thinking`（思考级别，或 `null` 删掉）、`handoff`（正整数，或 `null`）、`options`（对象，或 `null`）、`prompt`（字符串）、`workdir`（Windows 绝对路径）、`context`（字符串数组，或 `null`）。`null` 表示删掉这个键。
- `fields` 和 `revert` 恰好给一个。`fields` 至少一个键。`revert: true` 表示放弃待换的配置，S 就是当前的快照；`revert` 给别的值也报错。
- 请求本身的拒绝（`parseRequest` 里，在碰库之前），原文如下，都什么都不改：

| 情形 | `error` 的原文 |
|---|---|
| `fields` 和 `revert` 都没给、都给了，或者 `revert` 不是 `true` | `reconfigure 要带 fields 或者 revert: true，恰好一个` |
| `fields` 不是对象、是数组或 `null`、或者没有键 | `reconfigure 的 fields 必须是至少一个键的对象` |
| 有 `id` | `id 不能改：它是记忆库的 ID，换角色用 fork 带 preset` |
| 不认识的键 | `reconfigure 的 fields 里没有这个键：<键>` |
| 值的形状不对：`model`、`prompt`、`workdir` 要字符串；`tools` 要字符串数组；`thinking` 要字符串或 `null`；`handoff` 要数字或 `null`；`options` 要对象（不是数组）或 `null`；`context` 要字符串数组或 `null` | `reconfigure 的 fields.<键> 类型不对` |
| `tools` 超过 128 项（`TOOLS_FIELD_MAX`，按请求里的个数算，重复的也计） | `reconfigure 的 fields.tools 最多 128 项：现在有 <n> 项` |
| `process` 不是字符串 | `无法识别的请求：<原文>` |

- `tools` 的个数设了上限：每个名字都要读一个工具定义文件，请求里的个数不能不设限。上限在读文件之前查，所以几万个名字的请求立刻回 `error`。预设文件里 `tools:` 一行不受这个上限限制（那是用户自己写的文件），读它的函数去重用集合，名字多也不慢。
- 形状对、值不合格的，由读预设的同一套函数拒绝（`presets/load.ts` 的 `buildPreset`、`callParams`、`parseContext`），文字和 `start`、`check` 读文件时一字不差。因为快照 S 是按预设字段造的，文字里写的是“预设 <预设 ID> 的……”，指的就是这个会话的快照。例如：`预设 <id> 的 thinking 只能是 minimal, low, medium, high, xhigh, max：<值>`、`预设 <id> 的 handoff 必须是正整数（token）：<值>`、`模型目录里没有 <模型>`、`预设 <id> 的工作目录不存在：<路径>`，`context` 的写法错误见[设计稿第 2 节](../docs/design/mvp.md#2-预设)。`options` 过白名单和大小上限（[kb-kernel](kb-kernel.md#预设选项)）。

回执 `{ type: "reconfigured", process, pending }`：`pending` 是提交并 `pump` 之后，这个进程的记录里有没有 `next`。出错回 `{ type: "error", message }`，什么都不改，所以界面不需要回滚。

流程，仿 `stop` 和 `fork`，同步做完，中间没有 `await`：

1. 读进程记录。没有这个进程回 `error`。
2. `target = record.next ?? record.preset`：以待换的为底，没有就以当前的为底。
3. 造新快照 S：
   - `revert`：S 是 `record.preset`（当前的）。
   - `fields` 的键都在 `thinking`、`options`、`handoff` 里：S 是 `target` 的拷贝，只改这几个键（`null` 用解构去键，不置 `undefined`）。不重读文件，不查模型目录，也不查工作目录还在不在。
   - 有结构性字段：先把 `target` 还原成预设字段（`presetFields(snapshot)`：`tools` 是内置工具名加 `toolDefs` 的名字，再加 `prompt`、`model`、`thinking`、`handoff`、`options`、`workdir`、`context`），套上 `fields`，调用 `buildPreset`（`loadPreset` 的后半：重新读工具定义文件、查模型目录、全部校验），得到 S。没改的字段也一起重新校验：工作目录要还存在，模型要还在目录里，工具定义要还读得出。这一步就是“工具定义的手动刷新”：想让进程用上重新保存过的工具定义，就把现在的 `tools` 原样发一次。
   - `null` 删掉这个键。`options: {}` 和 `context: []` 等同 `null`：这两个键空的时候都不进快照。`thinking`、`handoff`、`options` 删了，就没有这个键，不是 `undefined`。
4. 两份快照都要过 `startError`，任何一份不过就回 `error`：S，和立即生效的那份（当前快照带上 S 的三个调用参数，`withCallParams(record.preset, S)`）。S 先查，原文不变。立即生效的那份不过时，原文前面加 `当前配置带上新的调用参数就过不了启动检查：`。两份不同，是因为有待换配置（或者 S 的结构性字段要等换段才生效）时，调用参数立即套在当前快照上，而 S 是另一份结构；只查 S，当前快照可能被套上一个让它自己过不了启动检查的 `handoff`。没有结构性差别时两份相同，只是重复查一次。
5. 一个事务把 `{ kind: "reconfigure", preset: S }` 放进这个进程的信箱（`send`，[kb-store](kb-store.md#会话配置的输入)），提交。然后 `pump()`，再同步读一次记录，回执。不用 `awaitFinal`：`reconfigure` 不开轮，没有最终回复可等。

- 空闲的进程不会被唤醒：回执之后阶段还是 `idle`，段里没有新消息。
- `pump` 处理它时，照常给订阅的连接推这个进程的 `update`。
- `pending` 只说现在有没有待换配置，不说什么时候采用。`false` 有几种：只改了调用参数；满足直接采用的条件（空闲、段里没有助手消息，新模型收图或段里没有图，并且段放得下新快照），已经直接采用；`revert` 取消了；S 和当前的一样。要分清，读 `inspect`。段里有图而新模型不收图、或者段放不进新快照（比如窗口换小，几条很长的用户消息已经到了新阈值）时不直接采用，回 `true`，换段时才采用。
- 信箱里还排着没处理的旧 `reconfigure` 时，新的以现在的记录为底造 S，不看排着的。两条都处理以后，后处理的赢，可以接受。
- S 在服务里算，不在 `decide` 里：重读文件和查目录是 I/O，纯函数层不做。放弃的别的做法见 [D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)。
- CLI 不加这个命令：CLI 冻结在 v1，上层（界面）直接发协议请求。

### 备份（`backup`）

[D73](kb-decisions.md#d73-backup-请求)。把整个库复制成一个文件，请求 `{ op: "backup", path }`，回执 `{ type: "backed_up", path, bytes }`。

- `path` 的校验（`parseRequest` 里，在碰库之前）：字符串，1 到 1024 个字符，不含控制字符，是 Windows 绝对路径（盘符或 UNC，和 `workdir` 一样）。空串、`:memory:`、`file:` 开头的不许：它们在 SQLite 里不是普通的文件路径，也不是 Windows 绝对路径，所以一并被拒。以空格或点结尾的也不许（Windows 会悄悄去掉它们，文件名对不上）；第 2 个字符之后不许再有冒号（`C:\x.db:s` 是 NTFS 的备用数据流，`\\?\C:\x` 这样的设备路径也在这条里被拒）。拒绝的原文，按这个顺序查：`备份路径要 1 到 1024 个字符：现在是 <n> 个`、`备份路径不能含控制字符`、`备份路径必须是 Windows 绝对路径（盘符或 UNC）：<路径>`、`备份路径不能以空格或点结尾：<路径>`、`备份路径里盘符之后不能再有冒号（备用数据流）：<路径>`。`path` 不是字符串、没给，回 `无法识别的请求：<原文>`。
- 做法：`VACUUM INTO ?` 到这个路径，同步；然后取目标文件的大小，作为 `bytes`。它不是输入，不改任何状态，不开写事务，不调用 `pump`，和 `sweep` 是同一类的请求分支。服务不先查目标存不存在，目标的情形全由 SQLite 判断。
- 出错回 `error`，文字是 SQLite 的原文：目录不存在、写不了（例如 `unable to open database file`）；目标情形见下。
- 目标已经存在时，行为取决于它是什么，这是 SQLite 的行为，不是服务定的：
  - 目标是一个已有的库：SQLite 拒绝，原文 `output file already exists`，文件不动。
  - 目标是别的、非空的文件：SQLite 先认出它不是库，原文 `file is not a database`，文件不动。
  - 目标是一个已存在的 0 字节文件：SQLite 接受并覆盖它，回 `backed_up`。**这是已知的细节**：服务不拦。上层脚本用带时间的新文件名，不会撞上它。
- `PRAGMA user_version` 保留在备份里（Node 24.22 上实测），所以备份文件能直接当库打开，版本检查照常。
- 代价：同步执行，期间整个服务不处理别的输入，时间和库的大小成正比。要定在没人用的时候，例如每天夜里一次的计划任务（[kb-extras 的备份](kb-extras.md#备份)）。
- 库外的东西不在备份里：预设、工具定义、`extras/` 的数据，要另外复制（[kb-store](kb-store.md#位置)）。
- CLI 不加这个命令：CLI 冻结在 v1，上层脚本直接连管道发请求（[kb-extras 的备份](kb-extras.md#备份)）。

### 图片

入口检查在 `src/images.ts` 的 `checkImages`，`start` 和 `send` 在碰库之前调用。纯函数，不读库。不合格就抛出，原因是 `error` 的内容，什么都不写。

按顺序，每一步对全部图片做完再做下一步（张数、大小、类型、尺寸）：

1. 张数：一个请求最多 `IMAGES_PER_MESSAGE`（2）张。
2. 大小：每张不超过 `IMAGE_MAX_BYTES`（1.5 MiB，指原始字节）。解出字节要先是合法的 base64，不是就在这一步拒绝。
3. 类型：按文件头的魔数（`imageType`），只收 png、jpeg、gif、webp。不信声明的类型和扩展名。
4. 尺寸：宽和高都在 1 到 `IMAGE_MAX_EDGE`（2000）之间，从文件头读（`imageSize`）：
   - PNG：IHDR。GIF：逻辑屏幕描述。
   - WebP：VP8、VP8L、VP8X 三种块。别的块读不出尺寸，拒绝。
   - JPEG：从头逐段跳过标记段（APPn、EXIF 等），到 SOFn 为止，包括渐进式的 SOF2。到 SOS 还没有 SOFn、头被截断，读不出尺寸，拒绝。

通过的图片带上 sha256 哈希和魔数算出的类型，交给存储事务（[kb-store](kb-store.md#图片)）。目标进程的模型不收图片时，照样先检查：不合格回 `error`，都合格才换成说明行，不存图片。

- `blob` 的回复：类型用同一个 `imageType` 现算，不另存。库里的字节认不出类型（不会发生）也回 `error`。
- `history` 里图片块的 `data` 是 `blob:<hash>`，不带字节。要看图，用 `blob`。
- 为什么入口要查（[D41](kb-decisions.md#d41-第-6-步后一半的选择)）：不合格的图片进了段，每次调用模型都会失败，连交接调用也失败，进程就永远卡住。例如 Anthropic 拒绝边长超过 8000 像素的图。`IMAGE_MAX_EDGE` 的 2000 像素，和 pi-ai 模型目录给每个收图片的模型定的缩放尺寸一样。截图类的工具定义要自己先缩小（[kb-extras](kb-extras.md#pi-web-的功能在-v2-上的做法)）。
- 图片只从三个入口进来：协议的 `start`、`send`，工具定义的 `content` 输出，和 `read` 读到的图片文件（[D76](kb-decisions.md#d76-read-读图片)）。后两个入口的不合格是错误结果，检查和协议的完全一样，函数是同一个（`checkImages`，[kb-tools](kb-tools.md#运行工具定义)）。
- 文件头完好、数据损坏的图片仍可能进段，模型接口会拒绝它（[风险表](kb-contract.md#风险表)）。
- CLI 不带图片：CLI 的命令、输出和退出码冻结在 v1。上层的命令行直接用协议。

### 进程 ID

`randomBytes(4).toString("hex")`：8 个小写十六进制字符。不含预设 ID，不按时间排序。撞上已有 ID 时 `startProcess` 主键冲突，回 `error`，不重试。

### 流式文本

- 执行器把模型的 `text_delta` 交给服务（[kb-executor.md](kb-executor.md#调用模型actionsts)）。服务转发给这个进程此刻的全部观察者和订阅（订阅它或订阅全部的 `watch`），一段一行 `text`，带进程 ID 和副作用编号 `n`。客户端用编号丢掉过时的文本。
- 不进库，不进投影。`ps`、`stop`、`history` 的连接收不到。
- `kind`（D64 第 5 组）：思考（`thinking_delta`）和工具调用参数的 JSON 片段（`toolcall_delta`）也转发，`text` 带 `kind: "thinking"` 或 `"toolCall"`；正文不带 `kind`。带 `kind` 的只推给带 `messages: true` 的订阅，不推给观察者和普通订阅：`start`、`send` 的连接和旧客户端的 `watch` 只收正文，CLI 的输出和 GUI 不变。 第三种 `kind` 是 `output`（D88）：命令边跑边写的输出，`bash` 和工具定义都有，`n` 是这次副作用编号。
- 观察者从登记那一刻起收，直到最终回复；订阅从订阅那一刻起收，直到断开。中途加入的连接从半句开始收。
- 转发不看用途：交接调用写的交接说明，以及之后被丢弃的回复（`length`、`error`）的文字，都会发出去。

### `tau ps` 的文字格式

`formatPs`（`src/cli/main.ts`）在 CLI 里格式化：

```text
现在 <本地时间>（<IANA 时区>）
<id>  <预设>  <阶段>  <已用>/<窗口>  段<n>  <运行多久>
```

- 本地时间是 CLI 进程的 `new Date().toLocaleString()`，用系统默认区域，不用投影里的 `now`。服务和 CLI 在同一台机器上。
- 阶段：`idle`；跑过一轮时 `idle(done)`、`idle(stepLimit)`、`idle(stopped)` 或 `idle(error)`；`等模型 第<s>步`、`换段中 第<s>步`、`等工具 第<s>步`。
- 用量不小于 1000 时写成 `<x.x>k`。
- 运行多久只用一个单位：`<n>秒`、`<n>分`、`<x.x>时`、`<x.x>天`。和 `self` 一样向下取整，所以 `ps` 不会比 `self` 显示得更久。时钟被往回拨、算出负数时，显示 0 秒。
- 没有进程时，第二行是 `没有进程。`。
- 投影里有、`ps` 没显示的：模型、排队消息数、本段开始多久、兄弟进程、出错的原因、父进程、子进程、累计用量、消息条数。`tau ps` 冻结在 v1 的字段，人用上层的命令行看新字段。

### CLI（`src/cli/main.ts`）

```text
tau serve
tau start <预设> <消息>
tau send <进程> <消息>
tau ps
tau stop <进程>
```

- `<消息>` 是其余参数用一个空格连接，不必加引号。连续使用 `tau send` 就是对话。
- CLI 只依赖 `protocol.ts`。`main.ts` 走 CLI 时不加载服务的模块、pi-ai 和 `node:sqlite`。
- 输出：
  - `start` 的回执：标准错误打印 `进程 <id>`。
  - `text`：原样写到标准输出。
  - `final`：没收到过流式文本时，才把 `reply` 写到标准输出；然后写一个换行。结束原因不是 `done` 时，标准错误打印 `[本轮结束：<原因>]`，出错时是错误信息。
  - `ps`：标准输出打印上一节的格式。
  - `error`：标准错误打印信息。
- 没有自动重试，也没有超时。

退出码：

| 码 | 什么时候 |
|---|---|
| 0 | `final` 的 `ended` 是 `done` 或 `null`；`stop` 收到回执；`ps` 收到快照 |
| 1 | 收到 `error`；`final` 的 `ended` 是 `stepLimit`、`stopped` 或出错 |
| 2 | 用法错误，包括消息为空；连不上服务（提示先运行 `tau serve`）。两种都没发出请求 |
| 3 | 连接关闭了，但没收到能定结果的回复 |

退出码 3 有两种：

- 没收到回执（`ps` 除外）：结果未知。命令可能已经提交，也可能没有。CLI 提示用 `tau ps` 查看，不要盲目重发。
- 收到了回执，没收到最终回复：命令已提交，进程可能还在运行。`ps` 没收到快照时也走这一支，提示语相同。

### 启动脚本和入口

- `tau.cmd` 只有一行：`@node "%~dp0src\main.ts" %*`。它按自己所在的目录找 `src\main.ts`，在任何当前目录都能用。需要 PATH 上的 `node`（`package.json` 要求不低于 24.21），直接运行 `.ts`。
- 启动脚本和测试都不加 `--disable-warning`，原因见 [D11](kb-decisions.md#d11-sqlite-驱动)。
- `src/main.ts`：第一个参数是 `serve` 就动态导入服务的模块并启动，其余参数忽略。否则交给 CLI 的 `main`，返回值写进 `process.exitCode`。
- 管道名、库和预设的位置写死在 `protocol.ts`、`main.ts` 和 `presets/load.ts`。`serve()` 和 CLI 的 `main` 接受别的管道和路径，只给测试用。
- `TAU_PIPE`：CLI 的 `main` 的管道参数默认取 `process.env.TAU_PIPE`，空或没设就用 `PIPE`。bash 工具给命令设的 `TAU_PIPE` 是服务实际监听的管道（[kb-tools](kb-tools.md#包装脚本)），所以测试服务里的 Agent 运行 `tau`，连的是测试服务。
- `tau`（不带扩展名，`#!/bin/sh`，git 里是可执行）：给 bash 用的启动脚本，和 `tau.cmd` 放在仓库根目录。`MSYS_NO_PATHCONV=1 exec node "$(cygpath -w "$(dirname "$0")")/src/main.ts" "$@"`。`MSYS_NO_PATHCONV=1` 不让 msys 改写参数，否则以 `/` 开头的消息正文会被改成 Windows 路径；`cygpath -w` 因为 node 要 Windows 路径才找得到 `main.ts`。bash 找不到不带扩展名的 `tau`，所以光有 `tau.cmd` 不够：写全名才行，还经 cmd.exe 解析参数。
- 服务的模型目录是 `builtinModels({ credentials })`（[kb-executor.md](kb-executor.md#调用模型actionsts)）。`credentials` 是 tau 自己的凭据文件 `~/.tau/auth.json`，可读可写：`fileCredentials`（`src/server/credentials.ts`，理由、取舍和风险见 [D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。路径写死在 `main.ts`。
- 每家供应商一条，形状同 pi-ai 的 `Credential`：`{type: "api_key", key}` 或 `{type: "oauth", access, refresh, expires, …}`。别的类型当作没有。pi-ai 在 OAuth 令牌剩不到 5 分钟时，经 `modify` 刷新并写回（刷新最多等 15 秒）。
- 读：每次调用都重读，不加锁。写（`modify`、`delete`）整个过程持锁：`auth.json.lock` 目录，`mkdir` 抢；持锁的人每 5 秒刷新锁目录的修改时间，15 秒没动过算持锁的进程崩了，清掉；等锁最多 30 秒（必须比 15 秒长）。写入是先写 `auth.json.tmp`、落盘、再改名。改名遇到 `EPERM`、`EBUSY`、`EACCES`（Windows 上目标正被别人读着）重试，最多 100 次，每次隔 25 毫秒；读不受影响，不重试。
- 写的人有三个，都是不同的进程：服务（刷新）、登录脚本、HTTP 桥（填和清 key）。登录和登出见 [kb-extras 的认证](kb-extras.md#认证)。
- 文件里这个 provider 的 `key` 非空时，API Key 用它。没有这个条目，或者 `key` 缺失时，pi-ai 从服务进程的环境变量读 API Key（例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。有 OAuth 条目的供应商不再看环境变量。
- `key` 是空串时各家不同。多数 provider 照样读环境变量。cloudflare-workers-ai、cloudflare-ai-gateway、google-vertex 把空串当成已有的值，不读环境变量，结果是没有配置。条目的 `env` 字段也是这样逐字段合并。
- tau 不检查 `env` 的形状。写坏的 `env` 可能被忽略，退回进程的环境变量。
- `read` 检查形状：只支持字面量 `key`（`!` 开头或含 `$` 的报错，不原样发出去：从 pi 抄来的命令写法不会被当成 key 发给供应商）；`key` 不是字符串、OAuth 条目缺 `access`、`refresh`、`expires` 也报错。`modify` 不检查，所以写坏的条目可以被换掉。
- 文件不存在算没有凭据。不是合法的 JSON、顶层不是对象时，这次模型调用以错误结束，`modify` 和 `delete` 拒绝、不动文件。报错不带文件内容：V8 的 JSON 报错会引用出错处附近的原文，可能是 key 的开头，而报错会存进库、显示在 CLI 上。
- 服务不读 pi 的文件。从 pi 迁移：`api_key` 条目可以复制过来；OAuth 条目要在 tau 里重新登录（[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。
- 模型调用由服务进程发出。CLI 的环境不影响模型调用。

### 退出

- `main.ts` 用 `process.once` 接第一次 `SIGINT` 和 `SIGTERM`，调用 `service.close()`，完成后退出码 0。
- `close()`：
  1. 标记 `closing`。之后动作的 promise 被拒绝，不再让进程退出。
  2. 断开全部 `watch` 订阅。之后才读到的 `watch` 请求回 `error`（“服务正在退出，不接受订阅。”）并关闭。
  3. `server.close()`：不再接受新连接，并等现有连接全部结束。这期间 `pump` 照常工作。
  4. 关库。随后 `process.exit(0)`。
- 不中止正在运行的动作，它们不会上报。效果和崩溃一样（[kb-executor.md](kb-executor.md#崩溃窗口)）。bash 和它的子孙进程继续运行（[kb-tools.md](kb-tools.md#坑点)）。
- Windows 不会送 `SIGTERM`，能触发正常退出的只有 Ctrl+C。监听器只接一次，第二次 Ctrl+C 按 Node 的默认处理直接结束进程。

## 决策

| 决定 | 原因 |
|---|---|
| 只在命名管道上监听，监听成功就是锁 | 浏览器连不上，不占端口；进程死了管道就释放，没有残留的锁文件（[D16](kb-decisions.md#d16-服务只在命名管道上监听mvp-用-cli)、[D17](kb-decisions.md#d17-纯度审查同一个事实只有一个来源)） |
| 先拿管道，再碰库 | 第二个服务在开库和恢复之前就失败。否则它的恢复会把第一个服务正在跑的副作用当成被中断 |
| 只有一个同步的 `pump` 推进状态 | 没有并发，不需要锁；中止在删行的事务提交后立刻发出 |
| 回执在提交之后发 | 回执表示已落盘。断开时 CLI 能区分“结果未知”和“已经提交”（[D18](kb-decisions.md#d18-第三轮审查两个审查者24-项修改) 第 7 条） |
| 最终回复从库里取 | 流式文本可能来自被丢弃的回复，连接也可能中途加入 |
| 发最终回复前查信箱 | 新消息还在排队时，不把上一轮的回复发给它 |
| 观察者不持久 | 它是连接，不是状态（[kb-overview.md](kb-overview.md#状态分三层)） |
| CLI 不重试 | 重发可能让同一条消息进库两次 |
| 协议是 JSON 行 | 客户端只有 CLI 和上层的薄封装，不需要 HTTP 的路由和 SSE 分帧（D16、D18 第 17 条） |
| 订阅表和观察者表分开；`update` 由 `handleNext` 的返回值算出 | `settle` 不变；推送不读库，不增加每条输入的成本 |
| `watch` 的写缓冲有上限，推完快照就开始查 | 订阅方卡住时服务的内存有上界；断开比无限排队好，订阅方重连再拿快照（D39） |
| 进程 ID 是 8 个十六进制字符；撞上就回 `error`，不重试 | 短，好敲 |
| CLI 打印流式文本；没收到流式文本时，才打印最终回复 | 同一段文字不打印两次。代价：屏幕上的字不一定是库里的最终回复（见[坑点](#坑点)） |
| `main.ts` 走 CLI 时不加载服务的模块 | CLI 只依赖协议（[设计稿第 3 节](../docs/design/mvp.md#3-总体结构)） |
| `reconfigure` 的新快照在服务里算好，`decide` 只比较和采用 | 重读工具定义文件、查模型目录是 I/O，纯函数层不做；和 `start`、`check` 共用 `buildPreset`，所以拒绝的理由一致（[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)） |
| `backup` 不是输入，同步执行 | 它不改任何状态，不需要事务和 `pump`；`VACUUM INTO` 一个调用就得到一致的副本（[D73](kb-decisions.md#d73-backup-请求)） |

## 认知模型

- 服务 = 一把锁（管道）+ 一个库 + 一个执行器 + 一个同步的 `pump` + 一张观察者表和一张订阅表。
- 状态全在库里。服务内存里只有执行器的中止开关和催的开关、观察者表和订阅表，崩溃后都可以丢。
- 一个命令 = 一个事务 + 一次 `pump`。回执是服务对客户端唯一的承诺：它说的是“已提交”，不是“已处理”。读请求和 `prune`、`remove`、`sweep`、`backup` 没有 `pump`。`reconfigure` 的回执在 `pump` 之后才发，所以它说的是处理以后的事：有没有待换配置。
- 从零重建：`listen`、`openDb`、`createExecutor`、`pump`、`settle`、`parseRequest`，加一个只懂协议的 CLI。
- 一次修改越界的信号：
  - 在 `pump` 之外调用 `handleNext` 或 `startNext`，或者让 `pump` 变成异步。
  - 回执在提交之前发。
  - 往信箱放输入之后不跟一次 `pump`。
  - 最终回复来自流式文本。
  - 观察者表或订阅表写进库，或者服务在内存里记住别的状态。
  - `update` 为了算出来去读库，或者 `watch` 的写缓冲没有上限。
  - CLI 导入 `protocol.ts` 以外的 tau 模块，或者自动重发。
  - 在拿到管道之前开库。

## 投影与命令

- 服务不加投影字段。`ps` 回的是 `observe` 的结果：字段归 [kb-kernel.md](kb-kernel.md#投影与命令)，`self` 的文字归 [kb-store.md](kb-store.md#self)，`tau ps` 的文字在本页。
- 命令：`tau serve`、`tau start`、`tau send`、`tau ps`、`tau stop`。
- Agent 的控制命令是库内工具：`handoff`（换段），`post`（寄信）、`spawn`（派生）、`stop_process`（停止）。后三个在预设 `tools` 含 `agents` 时才有，服务把读预设的函数传给 `handleNext`（[kb-store](kb-store.md#进程之间的工具)）。有 `bash` 的进程可以直接运行 `tau`：`self` 只读是接口的范围，不是权限边界（[设计稿第 9 节](../docs/design/mvp.md#9-自省)）。

## 入口

| 路径 | 内容 |
|---|---|
| `src/server/serve.ts` | `serve`：启动顺序、`pump`、`settle`、`push`、`awaitFinal`、`handle`（含 `fork`、`reconfigure`、`backup`）、`parseRequest`、`close`；`WATCH_BUFFER_MAX` |
| `src/server/listen.ts` | `listen`：在命名管道上监听；`EADDRINUSE` 变成“已经有一个 tau 服务” |
| `src/server/credentials.ts` | `fileCredentials`：`~/.tau/auth.json` 的凭据库，可读可写，写持锁、原子；`extras/auth/store.ts` 是它的拷贝 |
| `src/protocol.ts` | `PIPE`、`Request`、`Reply` |
| `src/images.ts` | `checkImages`、`imageType`、`imageSize`、`IMAGE_MAX_BYTES`、`IMAGE_MAX_EDGE` |
| `test/server/protocol.test.ts` | `history`、`watch`、`text` 的进程和编号、图片和 `blob`、`fork`、`prune`、`remove`、`sweep`、`inspect`、`check`、`memory`、`memory_write`、`reconfigure`、`start` 和 `check` 带 `workdir`（D77） |
| `test/server/backup.test.ts` | `backup`：回执、备份能当库打开、目标已存在、请求校验、不是输入、运行中也能备份 |
| `test/presets/reconfigured.test.ts` | 新快照怎么造（`src/presets/load.ts`）：`context` 的写法的每条规则、`presetFields` 和 `buildPreset` 互逆、`buildPreset` 的拒绝和 `loadPreset` 一字不差、`reconfigured` 只改调用参数时不重读文件、有结构性字段时整个重建、以待换的为底 |
| `test/images.test.ts` | 入口检查：常量、魔数、每种格式的尺寸、张数、大小、类型、尺寸、顺序、base64 |
| `src/cli/main.ts` | `main`（命令和退出码）、`request`（连接、发一行、逐行交出回复）、`formatPs`、`ago` |
| `src/main.ts` | 入口：`serve` 或 CLI；`~/.tau` 的位置；信号处理 |
| `tau.cmd` | 启动脚本（cmd.exe） |
| `tau` | 启动脚本（bash，git 里可执行） |
| `test/server/e2e.test.ts` | faux 模型端到端；回执之前断开；连不上；模型 `spawn` 带 `workdir`，子进程的快照用覆盖的目录（D77） |
| `test/server/pairing.test.ts` | 服务层的工具调用配对：按顺序、运行中停止、运行中崩溃 |
| `test/server/kill.test.ts`、`test/server/child.ts` | 子进程里的真服务被随机硬杀 |
| `test/server/listen.test.ts` | 单实例 |
| `test/server/credentials.test.ts`、`test/credential-suite.ts` | 凭据库的 18 条测试，对 src 和 extras 的两份各跑一遍：交出 `api_key` 和 `oauth`；文件不存在、格式坏、顶层不是对象，报错不带文件内容，坏文件不被改；只支持字面量 key；`modify` 保留别的条目、fn 抛错不动文件；陈旧锁、持锁的进程崩了（超时前清掉）、持锁的人慢不被偷锁、被占着、超时；同一文件并发和三个进程各改 15 次一次不丢；别人在写时读；接进 pi-ai 的登录、刷新、刷新失败、登出、环境变量的优先顺序 |
| `test/server/cli.test.ts` | 第 5 步验收：经 CLI 同时跑两个进程；`self` 和 `tau ps` 一致；流式文本；模型不在目录里 |

命令：`npm test`。只跑服务测试：`node --test "test/server/*.test.ts"`。

### 服务测试（`test/server/`）

都走真的管道、库和 `createActions`，模型是 pi-ai 的 faux。测试要先清掉从外面继承来的 `TAU_` 变量，否则 `TAU_PIPE` 会让测试连到正式服务。

| 测试 | 证明 |
|---|---|
| e2e：读文件、改一行、跑命令 | 第一行是回执，最后一行是 `{ final, "改好了。", done }`；文件被改；3 个工具结果进了段；`ps` 显示 `idle` |
| e2e：回执之前断开 | 一个收下连接就断开的假服务：`tau send` 退出码 3，提示“结果未知” |
| e2e：连不上 | `tau ps` 退出码 2，提示先运行 `tau serve` |
| e2e：bash 工具运行 `tau ps` | faux 模型调 bash，运行仓库的 `tau` 脚本的 `ps`；`TAU_PIPE` 指着测试管道，输出里有这个测试进程，`$TAU_PROCESS` 是它的 ID |
| pairing：3 个调用按顺序 | `read`、`bash`、`read` 各一个结果，按调用顺序紧跟助手消息；第 3 个读到第 2 个写的内容；模型的第二次请求里也是这个顺序 |
| pairing：第 2 个调用运行中停止 | `stop` 只回回执；等着的连接收到 `{ final, "", stopped }`；命令要跑 60 秒，bash 远早于此退出（限 30 秒，留出 `ps` 和 `taskkill` 偶尔卡的约 5 秒）；结果依次是真结果、`INTERRUPTED`、`SKIPPED`；之后 `send` 照常；被中止的命令没有跑完 |
| pairing：第 2 个调用运行中崩溃 | 进程内模拟崩溃（先关库句柄，再断开连接、停止监听）：客户端只拿到回执；崩溃点是 `running` 行；下一次 `serve()` 返回时已恢复并处理完，本轮以“服务重启”的错误结束；之后 `send` 照常；崩溃前的 bash 跑完了，结果没进库，也没被重做 |
| kill：随机硬杀 5 次 | 3 个进程不停收消息，有时运行中再发，有时停止；在带种子的时刻 `taskkill /T /F` 杀掉服务。每次杀后测试自己开库：不变量成立；只做恢复后没有 `running` 行，`pending` 行不动。至少一次杀在副作用运行中。最后全部 `idle`，信箱和副作用表为空；工作段里每条用户消息都发过，只在发给的进程里出现一次；有回执的消息都在 |
| listen：跨进程、同进程 | 第二次监听同一个管道失败，提示“已经有一个 tau 服务”；第一个关掉后能再监听 |
| cli：两个进程同时运行 | 经 `main` 启动带记忆和不带记忆的两个预设；`ps` 显示两个都在运行；带记忆的 `memory_set` 后 `memory_get` 读回；不带记忆的看不到记忆工具；`stop` 一个，另一个照常，迟到的回复被丢弃 |
| cli：`self` 和 `ps` 一致 | 同一个预设的两个进程，一个被拦住；另一个的 `self` 显示用量、窗口、时间、时区和运行中的兄弟；`ps` 的投影在 ID、预设、模型、段号、窗口和兄弟上一致 |
| cli：流式文本 | 流式片段拼起来等于最终回复；CLI 只打印一次 |
| protocol：`history` | 默认读当前段，`from` 起读，段尾之后只有 `end`；旧段；越界和不存在回 `error`；数字字段的校验；读请求不写库 |
| protocol：`send` 带 `from`、`reply` | 发送者和跳数来自 `from` 的记录，请求里多余的 `hops`、`replyTo`、发送者字段不进信；`reply` 的回信进 `from` 的信箱并唤醒它；`reply` 没有 `from`、类型不对回 `error`；`from` 不存在或等于目标回 `error` 且库不变；和 `handoff` 同时带 |
| protocol：`start`、`fork` 带 `id` | 用调用方的 ID；字符集和长度（32 个字符可以，33 个不行）；ID 已存在回“进程 ID 已存在：<id>”，库不变；同一个 `id` 重试是幂等的 |
| protocol：`text` | `start`、`send` 的观察者收到的 `text` 带进程和编号 |
| protocol：`watch` 快照和增量 | 带不带 `process` 的快照；每次处理输入一条 `update`，消息条数和用量与库一致；不推 `final`；只推订阅的进程；订阅不存在的进程回 `error` |
| protocol：`watch` 断开和退出 | 客户端断开后连接被释放，其余订阅照常；服务退出时断开订阅；退出开始以后才到的 `watch` 回 `error`，等最终回复的连接照常收到 |
| protocol：`watch` 写缓冲上限 | 快照大于管道缓冲、订阅方一直不读：到上限才断开，读的订阅不受影响；快照很小、订阅方不读：少量推送不断开，超过上限才断开 |
| protocol：`inspect` | 全部按 ID 升序、一进程一行加结束行；带 `process` 一行加结束行；没有进程回 `error` 且无结束行；记录原样，加 `history` 前 `messages` 条等于当前状态；出错原因不截短；读请求不写库、不动信箱；请求校验 |
| protocol：`check` | 读得出回快照、限度和 `null`；装不下回 `check`，`error` 是启动检查的原文；读不出回 `error`，和 `start` 一字不差；不写库；请求校验。表驱动：读不出、工具定义坏、装不下、能启动，`check` 和 `start` 结论一致 |
| protocol：`memory`、`memory_write` | 不带 `ns` 列 ns、带 `ns` 给键；成功给每项版本；冲突、超限、删除不存在的键都回 `memory_rejected` 且整批回滚；一长串不合格请求（ns 不合法、`brief` 不是字符串、`expected` 缺失或不是正整数、`delete` 的 `expected` 为 `null`、`ops` 为空、好项后跟坏项）都回 `error`，库不变；写入后同预设新开的进程视图看得到，已有进程的 `memoryView` 不变；`set` 不带 `brief` 时摘要是值的前 200 字节，带了就用它；`entries` 带 `brief` 和 `updated` |
| protocol：图片 | `start`、`send` 带图：段里是引用，`blob` 取回原字节和类型，`history` 不带字节；`images` 的校验；不合格回 `error`、什么都不建；不收图片的模型先检查、再换说明；执行器发给模型的是真数据；`blob` 不存在、带前缀回 `error`，读请求不写库 |
| protocol：`fork` | 回执带新 ID 并关闭；带 `preset`：新进程用新预设，之后 `send` 模型收到新系统提示词和工具描述；读不出的预设、放不进的预设回 `error`；`history` 读新进程等于源进程的前缀；之后对新进程 `send`，模型收到复制的消息，系统提示词和源进程一样；各种 `error`（没有进程、越界、不是用户消息、运行中不带 `before`、启动检查、请求校验）；订阅在回执之前收到新进程的 `update`；带图片引用的段 |
| protocol：删除 | `prune`：回执，旧段读不到，当前段在，`before` 越界回 `error`；`history` 读已删的段回 `error`，当前段 0 条回 `end`。`remove`：每条拒绝回 `error` 且库不变；执行器还有该进程的动作时回 `error`；成功时订阅这个进程的连接和订阅全部的连接都先收到 `removed`（断言两种都收到），订阅这个进程的随后关闭，订阅全部的照常订阅，回执在 `removed` 之后。`sweep`：回 `swept`，数目对。请求校验。三个请求不调用 `pump` |
| protocol：`reconfigure`（在 `protocol.test.ts`） | 请求校验（`id`、不认识的键、`fields` 和 `revert` 的组合、值的类型）；`tools` 最多 128 项（129 项、3 万项都立刻回 `error`，去重照旧）；嵌套 2200 层的工具定义不卡住信箱，服务能重启；已有待换配置时只改调用参数，立即生效的那份也过启动检查；窗口换小、段放不进时存 `next`，`pending` 为 `true`；回执的 `pending`；`fields` 只有调用参数时不重读文件（换掉工具定义文件，`pending` 仍为 `false`）；有结构性字段时重读工具定义文件（手动刷新）；`startError` 不通过回 `error`，库不变；进程不存在回 `error`；`revert` 取消待换配置；回执之后空闲进程仍是 `idle`，段里没有新消息 |
| backup（在 `backup.test.ts`） | 回执的 `path` 原样、`bytes` 等于文件大小；备份文件能当库打开，`user_version`、表和每张表的行都对；正斜杠的盘符路径也行；`path` 不合格（空串、`:memory:`、`file:` 开头、相对路径、控制字符、超长、以空格或点结尾、盘符之后还有冒号）回 `error`，不留文件；目标已存在（已有的备份、不是库的文件）回 `error` 且已有文件不动，目录不存在回 `error` 且不建目录；不调用 `pump`，信箱里的信不被处理，库前后一致；进程在运行时也能备份。已存在的 0 字节文件会被覆盖，是已知细节，没有测试 |
| cli：模型不在目录里 | 本轮以“模型目录里没有”的错误结束，回复不入段；模型放回后进程照常可用 |

## 坑点

- **`tau.cmd` 经 cmd.exe 解析参数，`&` 是命令分隔符。** 正文里的 `&` 会把命令截断。外部程序和系统计划任务寄信，要直接连管道，或者直接运行 `node <仓库>\src\main.ts`，不要经 `tau.cmd`。bash 里用 `tau` 脚本，它不经 cmd.exe。
- **`MSYS_NO_PATHCONV` 会留在服务的环境里。** `tau` 脚本只为 `exec node` 设它，但它在 node 的环境里。在 Git Bash 里运行 `tau serve`，服务就带着它。所以 bash 工具构造命令环境时去掉它（[kb-tools](kb-tools.md#包装脚本)）；服务自己的环境不动。
- **在 `pump` 之外推进状态。** `pump` 的同步是服务里“没有并发”的唯一来源。验证：pairing 的停止用例（中止及时到达）、kill 测试。
- **持锁的进程崩了，凭据文件的锁目录留下。** 下一个写者最多等 15 秒，清掉陈旧锁再写。两个写者同时清同一把陈旧锁，有一个极窄的竞态，机器休眠醒来时也可能偷锁，都不处理（[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。轮换 refresh 令牌的供应商，刷新成功之后、写盘之前崩溃，新令牌丢了，要重新登录。
- **客户端发完请求不能半关闭。** 不要调用 `end` 或 `shutdown`。Windows 命名管道不支持半关闭：客户端一半关，连接就整个关了，之后服务写的都丢。两端都设 `allowHalfOpen` 也一样。同步写出的回执、快照和 `history` 还能到，后来的最终回复和 `watch` 的增量都丢，所以简单的测试发现不了。测试里的客户端也不要半关闭。
- **`watch` 订阅方卡住就被断开。** 订阅方读得比服务推得慢，写缓冲涨过上限，连接就被服务关掉。订阅方重连、重新拿快照，再用 `history` 补读。
- **回执提前发。** 回执必须在事务提交之后。kill 测试断言有回执的消息一条不丢。
- **`settle` 不查信箱。** 进程 `idle` 而新消息还在排队时，新连接会拿到上一轮的回复。这一条没有专门的测试。
- **`pump` 抛出。** `handleNext` 或 `claim` 抛出，说明库或代码坏了（[kb-store.md](kb-store.md#坑点)）。在请求里抛出时，已经发了回执的连接再收到一行 `error`，CLI 退出码 1，服务继续跑，信箱卡住。在动作结束后的 `pump` 里抛出时，没有人接住，Node 按未处理的拒绝让进程以码 1 退出，不经过 `fatal`。重启后第一次 `pump` 再抛出，服务起不来。
- **关闭要等连接。** 有连接在等最终回复时，Ctrl+C 之后服务继续工作，直到这些回复发完。要立刻停，再按一次 Ctrl+C。`watch` 订阅不算：它们一开始就被断开。
- **断开之后拿不回回复。** 观察者不持久，CLI 也没有读回复的命令。协议有 `history`，上层可以读；`tau ps` 只给阶段。
- **“结果未知”时 `tau ps` 只能间接判断。** `start` 看有没有多出一个进程；`send` 看不出消息进没进库，`ps` 不显示消息。
- **屏幕上的文字不一定在库里。** CLI 收到过流式文本，就不打印 `final.reply`。流式文本包括交接说明和被丢弃的回复，多次模型调用的文字直接连在一起。
- **Agent 对自己运行 `tau send`。** CLI 等这个进程回到 `idle`，进程在等这次 bash，信一排上队，这个 bash 就被催，最多再等 1 秒转后台（D104；没这条规则时要等到时间，默认 60 秒），这次工具调用返回以后这一轮才往下走。消息已经提交，会作为排队的消息，在下一个安全点或本轮结束时处理。
- **服务运行时别的程序写库。** `openDb` 没设忙等超时。另一个连接持有写锁时，服务的事务立刻报 `database is locked`：请求得到 `error`；动作结束时写库失败则 `fatal` 退出。要备份，用 `backup` 请求（[备份](#备份backup)），不要在服务运行时复制库文件或另开连接。
- **`backup` 是同步的，它跑的时候服务不处理别的输入。** 时间和库的大小成正比，库大了会停好几秒甚至更久：模型回复、请求、回执都得等。定在没人用的时候。
- **`reconfigure` 的回执只说“现在有没有待换配置”。** `pending: false` 只说没有待换的配置，不说结构性字段有没有变：几种情形见[会话配置](#会话配置reconfigure)。要分清，读 `inspect`。
- **`reconfigure` 不重读预设文件。** 预设文件之后改了，不影响已经出生的会话。会话要新的预设内容，用 `reconfigure` 带字段显式给。
- **进程内的“崩溃”不是真崩溃。** pairing 测试关掉库句柄来模拟，运行中的 bash 不会跟着死。真崩溃只在 kill 测试里：子进程被 `taskkill /T /F`，不跑任何退出处理。
- **`tau ps` 随进程数变慢。** 它为每个进程读一次当前段。进程要上层用 `remove` 删（[删除](#删除)，[设计稿的风险](../docs/design/mvp.md#风险)）。

## 关联模块

- [kb-overview.md](kb-overview.md)：运行循环；状态分三层里的观察者。
- [kb-executor.md](kb-executor.md)：`pump` 调用的 `startNext`、`abort`、`hurry`，启动恢复，崩溃窗口。
- [kb-store.md](kb-store.md)：`startProcess`、`send`、`handleNext`；落盘；`self` 的文字。
- [kb-kernel.md](kb-kernel.md)：投影的字段；排队的消息和 `endTurn`。
- [kb-decisions.md](kb-decisions.md)：D11、D16、D17、D18、D21、D71（`reconfigure`）、D73（`backup`）。
- [kb-tools.md](kb-tools.md)：工具；bash 怎样结束进程；服务退出后 bash 继续运行。
