# 服务与 CLI

`updated: 2026-11-16`

## 这个模块是干什么的

服务是 `tau serve` 这个常驻进程。它持有单实例锁，打开库，做启动恢复，再用一个同步的 `pump` 推进全部进程。CLI 是它自己的客户端；协议还有 `history`、`watch` 和 `fork`，给上层用。

它负责：

- 启动顺序：先拿管道（锁），再开库、恢复、处理积压的信箱。
- `pump`：什么时候处理信箱、中止动作、开始副作用。
- 线协议：请求和回复的类型、请求的校验、回执什么时候发。
- 观察者：哪些连接在等哪个进程，最终回复什么时候发、内容怎么算。
- `history` 和 `watch`：读历史，订阅变化，订阅的写缓冲上限。
- 图片：`start`、`send` 的入口检查，`blob` 请求。
- `fork`：请求的参数、什么时候拒绝、回执和订阅的推送。复制什么在[纯函数层](kb-kernel.md#fork)。
- CLI 的命令、输出、退出码，以及“结果未知”。
- `tau ps` 的文字格式。
- 启动脚本 `tau.cmd`、入口 `src/main.ts`、正常退出。

它不负责：

- 四个存储事务，以及回执承诺的落盘：[kb-store.md](kb-store.md#四个事务)。
- 执行器的开始、中止、上报和启动恢复：[kb-executor.md](kb-executor.md)。
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
    有订阅时 push(进程, update)            （见“历史和订阅”）
    settle(进程)                          （见“观察者和最终回复”）
  循环 exec.startNext 直到 null：
    动作结束 → pump；动作的 promise 被拒绝 → fatal
```

- 只有 `pump` 推进状态。它是同步函数，中间没有 `await`；处理请求也是同步的。所以服务里没有并发：两次 `pump` 不会交错，一个请求的提交和随后的 `pump` 之间不会插进别的请求。
- 每条输入的 `now` 是那次 `handleNext` 调用时的 `Date.now()`。
- 每个往信箱放输入的地方，后面都跟着一次 `pump`：

| 输入从哪来 | 之后的 `pump` |
|---|---|
| 启动恢复 | `serve()` 末尾 |
| `start`、`send` | `awaitFinal` 发完回执、登记观察者之后 |
| `stop` | 发完回执之后 |
| 动作结束（`complete`） | `run.then(pump)` |
| 库内工具的结果 | 同一个 `handleNext` 循环接着处理 |

- `ps` 不调用 `pump`。
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
- 进程不存在、段号小于 1 或大于当前段，回 `error`。`from` 超过段尾只发 `end`。
- 消息是库里存的 JSON，不做转换。读整段进内存再写出，不分批。
- 客户端看到投影里的消息条数变了，就用 `from` 读新增的部分。

`watch`（可选的 `process`）：

- 订阅表 `Set<{ socket, process, limit }>`，只在内存里，和观察者表分开。`settle` 不看它。
- 订阅时先推快照：带 `process` 时推它的一条 `update`，不带时按进程 ID 推每个进程的 `update`。快照和登记在同一个同步调用里，所以先 `ps` 再 `watch` 不会漏。
- `update` 只有 `self` 部分，不带兄弟和子进程。它由 `observe(新记录, 新段, [新记录], now)` 算出，用的是 `handleNext` 返回的 `process` 和 `segment`，不再读库。
- 每次 `handleNext` 处理了某个进程的输入，`pump` 给订阅它的连接（或订阅全部的连接）推这个进程的 `update`。没有订阅时不算。
- 流式文本照样推：`text`，带进程 ID 和副作用编号。不推最终回复：客户端看到进程回到 `idle`，自己用 `history` 读。
- 订阅不存在的进程回 `error`，然后关闭。订阅由客户端断开结束。服务登记订阅后恢复读取，请求行之后的字节丢掉，所以多发的字节不会挡住断开。
- 写缓冲上限：推完快照时记下连接的 `writableLength`，记作 S。之后每次推送完，`writableLength` 超过 S + `WATCH_BUFFER_MAX`（1 MiB）就断开这个订阅。
  - `writableLength` 对字符串按字符计，上限也按字符。
  - 不能等快照排空再查：订阅方一直不读、快照又大于管道的缓冲时，快照永远排不空，上限就永远不生效。
  - 一次推送突发超过 1 MiB 字符的快速订阅方也会被断开。真实的模型流式输出远没有这么快。
- 退出：见[退出](#退出)。

### 线协议（`src/protocol.ts`）

每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭连接。

```ts
type Request =
  | { op: "start"; preset: string; text: string; images?: string[] }   // images 是 base64
  | { op: "send"; process: string; text: string; images?: string[] }
  | { op: "stop"; process: string }
  | { op: "ps" }
  | { op: "fork"; process: string; before?: number; preset?: string } // before 是当前段里一条用户消息的段内序号；preset 是换角色
  | { op: "history"; process: string; segment?: number; from?: number }
  | { op: "blob"; hash: string }                            // hash 不带 blob: 前缀
  | { op: "watch"; process?: string };

type Reply =
  | { type: "receipt"; process: string }                    // 命令的事务提交之后；fork 的回执带新进程的 ID
  | { type: "text"; process: string; n: number; delta: string } // 流式文本，只是预览；n 是副作用编号
  | { type: "final"; reply: string; ended: Ended | null }   // 从库里取
  | { type: "ps"; processes: Projection[] }
  | { type: "message"; segment: number; seq: number; message: Message }
  | { type: "end"; segment: number; messages: number }      // history 读完
  | { type: "blob"; mimeType: string; data: string }        // data 是 base64
  | { type: "update"; self: Projection["self"] }            // watch 的快照和增量
  | { type: "error"; message: string };
```

| 请求 | 服务做什么 | 回复 |
|---|---|---|
| `start` | `checkImages` 检查图片；`loadPreset` 读预设；生成进程 ID；`startProcess`（启动检查不通过就抛错，回 `error`，什么都不建） | `receipt`，若干 `text`，`final` |
| `send` | `checkImages` 检查图片；`send` 放进一封用户的信；进程不存在就抛出 | 同上 |
| `stop` | `send` 放进一条 `stop` | `receipt` |
| `fork` | 生成进程 ID（和 `start` 一样）；带 `preset` 时，用 `loadPreset` 读预设（含工具定义），读不出就回 `error`；`forkProcess`（拒绝的情形见下，什么都不建）。提交之后，给订阅的连接推新进程的 `update`，再回执。不调用 `pump`：没有输入要处理 | `receipt`，然后关闭；拒绝回 `error` |
| `ps` | 读全部进程记录；每个进程 `observe(p, 当前段, 全部进程, now)` | 一行 `ps` |
| `history` | 读一段的消息 | 若干 `message`，一行 `end`，然后关闭 |
| `blob` | 读一张图片：`hash` 不带 `blob:` 前缀。不开写事务 | 一行 `blob`，然后关闭。`hash` 不存在回 `error` |
| `watch` | 推快照，登记订阅 | 一直推 `update` 和 `text`，直到客户端断开 |
| 处理时抛出 | — | 一行 `error`，然后关闭 |

- `start` 和 `send` 走同一条路径：提交，然后 `awaitFinal`（发回执、登记观察者、`pump`）。
- 回执在事务提交之后才发。库是 `synchronous = FULL`，所以回执表示已经落盘。
- `fork` 的拒绝（都回 `error`，库里什么都没写）：没有这个进程；带 `before` 时，`before` 超出当前段，或那条消息不是用户消息；不带 `before` 时源进程不是 `idle`；带 `preset` 时，预设读不出，或复制来的段放不进新预设的换段阈值；新进程通不过启动检查。复制什么、为什么这样拒绝，见 [kb-kernel 的 fork](kb-kernel.md#fork)。源进程在运行时，带 `before` 的 `fork` 照常可以。
- `fork` 的回执在事务提交之后才发，之前先推 `update`：订阅的客户端收到回执时，已经见过新进程。`update` 由 `observe` 用 `forkProcess` 返回的记录和段算出，不读库。
- `stop` 的回执只表示停止进了信箱。随后的 `pump` 同步处理它，并中止正在运行的动作。进程已经 `idle` 时停止什么都不做，回执照发。
- `ps` 的进程按 ID 排序，包括 `idle` 的。每个投影带自己的 `now` 和 `siblings`。
- `error` 可能跟在回执后面：`awaitFinal` 里的 `pump` 抛出时（见[坑点](#坑点)）。
- 客户端可以在回执之后直接断开（`destroy`）：服务照常处理，不再给它写。`tau send` 被 Ctrl+C 就是这样。
- 没有单独的“寄信不等回复”的请求。它就是 `send` 收到回执后断开（[D29](kb-decisions.md#d29-放到上层的和不做的)）。

### 请求的校验（`parseRequest`）

- 每个连接只读第一行。`\r\n` 算一个换行。
- 不是合法 JSON：`error`，内容是 `JSON.parse` 的错误信息。
- 必须是带 `op` 的对象，字段类型要对：`start` 要字符串 `preset`、`text`；`send` 要字符串 `process`、`text`；`stop` 要字符串 `process`；`fork` 要字符串 `process`，可选的 `before` 要是非负整数，可选的 `preset` 要是字符串；`history` 要字符串 `process`，可选的 `segment`、`from` 要是非负整数；`blob` 要字符串 `hash`；`start`、`send` 的 `images` 可以没有，有就要是字符串数组；`watch` 的 `process` 可以没有，有就要是字符串。否则 `error`：“无法识别的请求：<原文>”。
- 只查类型。空串能通过，多余的字段被忽略。空预设 ID 由 `loadPreset` 拒绝；空消息会成为一条用户消息。CLI 不发空消息。
- 预设读不出、进程不存在、进程 ID 冲突，都回 `error`。这些情况下库里什么都没写。

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
- 图片只从两个入口进来：协议的 `start`、`send`，和工具定义的 `content` 输出。后一个入口的不合格是错误结果，检查和协议的完全一样，函数是同一个（`checkImages`，[kb-tools](kb-tools.md#运行工具定义)）。
- 文件头完好、数据损坏的图片仍可能进段，模型接口会拒绝它（[风险表](kb-contract.md#风险表)）。
- CLI 不带图片：CLI 的命令、输出和退出码冻结在 v1。上层的命令行直接用协议。

### 进程 ID

`randomBytes(4).toString("hex")`：8 个小写十六进制字符。不含预设 ID，不按时间排序。撞上已有 ID 时 `startProcess` 主键冲突，回 `error`，不重试。

### 流式文本

- 执行器把模型的 `text_delta` 交给服务（[kb-executor.md](kb-executor.md#调用模型actionsts)）。服务转发给这个进程此刻的全部观察者和订阅（订阅它或订阅全部的 `watch`），一段一行 `text`，带进程 ID 和副作用编号 `n`。客户端用编号丢掉过时的文本。
- 不进库，不进投影。`ps`、`stop`、`history` 的连接收不到。
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
- 服务的模型目录是 `builtinModels({ credentials })`（[kb-executor.md](kb-executor.md#调用模型actionsts)）。`credentials` 只读 `~/.pi/agent/auth.json` 里 `type` 为 `api_key` 的条目，每次调用都重读，从不写入（`src/server/credentials.ts`，理由见 [D23](kb-decisions.md#d23-凭据只读复用-pi-的凭据文件)）。
- 文件里这个 provider 的 `key` 非空时，API Key 用它。没有这个条目（包括只有 OAuth 条目），或者 `key` 缺失时，pi-ai 从服务进程的环境变量读 API Key（例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。
- `key` 是空串时各家不同。多数 provider 照样读环境变量。cloudflare-workers-ai、cloudflare-ai-gateway、google-vertex 把空串当成已有的值，不读环境变量，结果是没有配置。条目的 `env` 字段也是这样逐字段合并。
- tau 不检查 `env` 的形状。写坏的 `env` 可能被忽略，退回进程的环境变量。pi 自己不会写出这种文件。
- 只支持字面量 `key`。以 `!` 开头（pi 当命令执行）或含 `$`（pi 可能当变量或转义）的 `key` 会报错，不原样发出去。含 `$` 一律拒绝，比 pi 严；已知的 provider key 都不含 `$`。
- 文件不存在算没有凭据。不是合法的 JSON、顶层不是对象、`key` 不是字符串时，这次模型调用以错误结束。报错不带文件内容：V8 的 JSON 报错会引用出错处附近的原文，可能是 key 的开头，而报错会存进库、显示在 CLI 上。
- 路径写死成 `~/.pi/agent/auth.json`，不跟随 pi 的 `PI_CODING_AGENT_DIR`。
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

## 认知模型

- 服务 = 一把锁（管道）+ 一个库 + 一个执行器 + 一个同步的 `pump` + 一张观察者表和一张订阅表。
- 状态全在库里。服务内存里只有执行器的中止开关、观察者表和订阅表，崩溃后都可以丢。
- 一个命令 = 一个事务 + 一次 `pump`。回执是服务对客户端唯一的承诺：它说的是“已提交”，不是“已处理”。
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
| `src/server/serve.ts` | `serve`：启动顺序、`pump`、`settle`、`push`、`awaitFinal`、`handle`（含 `fork`）、`parseRequest`、`close`；`WATCH_BUFFER_MAX` |
| `src/server/listen.ts` | `listen`：在命名管道上监听；`EADDRINUSE` 变成“已经有一个 tau 服务” |
| `src/server/credentials.ts` | `piCredentials`：只读 pi 的凭据文件，只交出 `api_key` 条目 |
| `src/protocol.ts` | `PIPE`、`Request`、`Reply` |
| `src/images.ts` | `checkImages`、`imageType`、`imageSize`、`IMAGE_MAX_BYTES`、`IMAGE_MAX_EDGE` |
| `test/server/protocol.test.ts` | `history`、`watch`、`text` 的进程和编号、图片和 `blob`、`fork` |
| `test/images.test.ts` | 入口检查：常量、魔数、每种格式的尺寸、张数、大小、类型、尺寸、顺序、base64 |
| `src/cli/main.ts` | `main`（命令和退出码）、`request`（连接、发一行、逐行交出回复）、`formatPs`、`ago` |
| `src/main.ts` | 入口：`serve` 或 CLI；`~/.tau` 的位置；信号处理 |
| `tau.cmd` | 启动脚本（cmd.exe） |
| `tau` | 启动脚本（bash，git 里可执行） |
| `test/server/e2e.test.ts` | faux 模型端到端；回执之前断开；连不上 |
| `test/server/pairing.test.ts` | 服务层的工具调用配对：按顺序、运行中停止、运行中崩溃 |
| `test/server/kill.test.ts`、`test/server/child.ts` | 子进程里的真服务被随机硬杀 |
| `test/server/listen.test.ts` | 单实例 |
| `test/server/credentials.test.ts` | 只交出 `api_key`；不写入；文件不存在、格式坏、顶层不是对象，报错不带文件内容；只支持字面量 key；每次重读；接进 pi-ai 后 key 的优先顺序和坏文件的结果 |
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
| protocol：`text` | `start`、`send` 的观察者收到的 `text` 带进程和编号 |
| protocol：`watch` 快照和增量 | 带不带 `process` 的快照；每次处理输入一条 `update`，消息条数和用量与库一致；不推 `final`；只推订阅的进程；订阅不存在的进程回 `error` |
| protocol：`watch` 断开和退出 | 客户端断开后连接被释放，其余订阅照常；服务退出时断开订阅；退出开始以后才到的 `watch` 回 `error`，等最终回复的连接照常收到 |
| protocol：`watch` 写缓冲上限 | 快照大于管道缓冲、订阅方一直不读：到上限才断开，读的订阅不受影响；快照很小、订阅方不读：少量推送不断开，超过上限才断开 |
| protocol：图片 | `start`、`send` 带图：段里是引用，`blob` 取回原字节和类型，`history` 不带字节；`images` 的校验；不合格回 `error`、什么都不建；不收图片的模型先检查、再换说明；执行器发给模型的是真数据；`blob` 不存在、带前缀回 `error`，读请求不写库 |
| protocol：`fork` | 回执带新 ID 并关闭；带 `preset`：新进程用新预设，之后 `send` 模型收到新系统提示词和工具描述；读不出的预设、放不进的预设回 `error`；`history` 读新进程等于源进程的前缀；之后对新进程 `send`，模型收到复制的消息，系统提示词和源进程一样；各种 `error`（没有进程、越界、不是用户消息、运行中不带 `before`、启动检查、请求校验）；订阅在回执之前收到新进程的 `update`；带图片引用的段 |
| cli：模型不在目录里 | 本轮以“模型目录里没有”的错误结束，回复不入段；模型放回后进程照常可用 |

## 坑点

- **`tau.cmd` 经 cmd.exe 解析参数，`&` 是命令分隔符。** 正文里的 `&` 会把命令截断。外部程序和系统计划任务寄信，要直接连管道，或者直接运行 `node <仓库>\src\main.ts`，不要经 `tau.cmd`。bash 里用 `tau` 脚本，它不经 cmd.exe。
- **`MSYS_NO_PATHCONV` 会留在服务的环境里。** `tau` 脚本只为 `exec node` 设它，但它在 node 的环境里。在 Git Bash 里运行 `tau serve`，服务就带着它。所以 bash 工具构造命令环境时去掉它（[kb-tools](kb-tools.md#包装脚本)）；服务自己的环境不动。
- **在 `pump` 之外推进状态。** `pump` 的同步是服务里“没有并发”的唯一来源。验证：pairing 的停止用例（中止及时到达）、kill 测试。
- **pi 正在写凭据文件。** pi 在锁里原地截断再写，tau 读时不拿锁。读到空文件或半个文件时，这次模型调用以“不是合法的 JSON”结束，重发即可。窗口很小，但服务要跑很多年。
- **客户端发完请求不能半关闭。** 不要调用 `end` 或 `shutdown`。Windows 命名管道不支持半关闭：客户端一半关，连接就整个关了，之后服务写的都丢。两端都设 `allowHalfOpen` 也一样。同步写出的回执、快照和 `history` 还能到，后来的最终回复和 `watch` 的增量都丢，所以简单的测试发现不了。测试里的客户端也不要半关闭。
- **`watch` 订阅方卡住就被断开。** 订阅方读得比服务推得慢，写缓冲涨过上限，连接就被服务关掉。订阅方重连、重新拿快照，再用 `history` 补读。
- **回执提前发。** 回执必须在事务提交之后。kill 测试断言有回执的消息一条不丢。
- **`settle` 不查信箱。** 进程 `idle` 而新消息还在排队时，新连接会拿到上一轮的回复。这一条没有专门的测试。
- **`pump` 抛出。** `handleNext` 或 `claim` 抛出，说明库或代码坏了（[kb-store.md](kb-store.md#坑点)）。在请求里抛出时，已经发了回执的连接再收到一行 `error`，CLI 退出码 1，服务继续跑，信箱卡住。在动作结束后的 `pump` 里抛出时，没有人接住，Node 按未处理的拒绝让进程以码 1 退出，不经过 `fatal`。重启后第一次 `pump` 再抛出，服务起不来。
- **关闭要等连接。** 有连接在等最终回复时，Ctrl+C 之后服务继续工作，直到这些回复发完。要立刻停，再按一次 Ctrl+C。`watch` 订阅不算：它们一开始就被断开。
- **断开之后拿不回回复。** 观察者不持久，CLI 也没有读回复的命令。协议有 `history`，上层可以读；`tau ps` 只给阶段。
- **“结果未知”时 `tau ps` 只能间接判断。** `start` 看有没有多出一个进程；`send` 看不出消息进没进库，`ps` 不显示消息。
- **屏幕上的文字不一定在库里。** CLI 收到过流式文本，就不打印 `final.reply`。流式文本包括交接说明和被丢弃的回复，多次模型调用的文字直接连在一起。
- **Agent 对自己运行 `tau send`。** CLI 等这个进程回到 `idle`，进程在等这次 bash，只能等 bash 超时。消息已经提交，会作为排队的消息，在下一个安全点或本轮结束时处理。
- **服务运行时别的程序写库。** `openDb` 没设忙等超时。另一个连接持有写锁时，服务的事务立刻报 `database is locked`：请求得到 `error`；动作结束时写库失败则 `fatal` 退出。备份要先停服务（[kb-store.md](kb-store.md#位置)）。
- **进程内的“崩溃”不是真崩溃。** pairing 测试关掉库句柄来模拟，运行中的 bash 不会跟着死。真崩溃只在 kill 测试里：子进程被 `taskkill /T /F`，不跑任何退出处理。
- **`tau ps` 随年头变慢。** 它为每个进程读一次当前段，进程永不删除（[设计稿的风险](../docs/design/mvp.md#风险)）。

## 关联模块

- [kb-overview.md](kb-overview.md)：运行循环；状态分三层里的观察者。
- [kb-executor.md](kb-executor.md)：`pump` 调用的 `startNext`、`abort`，启动恢复，崩溃窗口。
- [kb-store.md](kb-store.md)：`startProcess`、`send`、`handleNext`；落盘；`self` 的文字。
- [kb-kernel.md](kb-kernel.md)：投影的字段；排队的消息和 `endTurn`。
- [kb-decisions.md](kb-decisions.md)：D11、D16、D17、D18、D21。
- [kb-tools.md](kb-tools.md)：工具；bash 怎样结束进程；服务退出后 bash 继续运行。
