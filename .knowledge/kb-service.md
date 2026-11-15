# 服务与 CLI

`updated: 2026-11-15`

## 这个模块是干什么的

服务是 `tau serve` 这个常驻进程。它持有单实例锁，打开库，做启动恢复，再用一个同步的 `pump` 推进全部进程。CLI 是它唯一的客户端。

它负责：

- 启动顺序：先拿管道（锁），再开库、恢复、处理积压的信箱。
- `pump`：什么时候处理信箱、中止动作、开始副作用。
- 线协议：请求和回复的类型、请求的校验、回执什么时候发。
- 观察者：哪些连接在等哪个进程，最终回复什么时候发、内容怎么算。
- CLI 的命令、输出、退出码，以及“结果未知”。
- `tau ps` 的文字格式。
- 启动脚本 `tau.cmd`、入口 `src/main.ts`、正常退出。

它不负责：

- 三个存储事务，以及回执承诺的落盘：[kb-store.md](kb-store.md#三个事务)。
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
| `start`、`send` | `watch` 发完回执、登记观察者之后 |
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
- 等同一个进程的连接收到同一条最终回复。运行中发来的消息排队到本轮结束（[kb-kernel.md](kb-kernel.md#流程每种输入)），所以先发的连接也要等排队的消息回答完。

最终回复（`finalReply`）只看当前段，从末尾往前找：

- 先遇到用户消息：空串。
- 先遇到助手消息：它所有 `text` 块直接连接，不加分隔。
- 工具结果跳过。

所以本轮不是正常结束时，回复可能是空串，也可能是带工具调用的那条助手消息的正文。本轮以停止、出错或步数用完结束、又有排队的消息时，排队的消息合并写在段末（[kb-kernel.md](kb-kernel.md#流程两个辅助步骤)），回复是空串。

### 线协议（`src/protocol.ts`）

每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭连接。

```ts
type Request =
  | { op: "start"; preset: string; text: string }
  | { op: "send"; process: string; text: string }
  | { op: "stop"; process: string }
  | { op: "ps" };

type Reply =
  | { type: "receipt"; process: string }                    // 命令的事务提交之后
  | { type: "text"; delta: string }                         // 流式文本，只是预览
  | { type: "final"; reply: string; ended: Ended | null }   // 从库里取
  | { type: "ps"; processes: Projection[] }
  | { type: "error"; message: string };
```

| 请求 | 服务做什么 | 回复 |
|---|---|---|
| `start` | `loadPreset` 读预设；生成进程 ID；`startProcess` | `receipt`，若干 `text`，`final` |
| `send` | `send` 放进一条 `userMessage`；进程不存在就抛出 | 同上 |
| `stop` | `send` 放进一条 `stop` | `receipt` |
| `ps` | 读全部进程记录；每个进程 `observe(p, 当前段, 全部进程, now)` | 一行 `ps` |
| 处理时抛出 | — | 一行 `error`，然后关闭 |

- `start` 和 `send` 走同一条路径：提交，然后 `watch`（发回执、登记观察者、`pump`）。
- 回执在事务提交之后才发。库是 `synchronous = FULL`，所以回执表示已经落盘。
- `stop` 的回执只表示停止进了信箱。随后的 `pump` 同步处理它，并中止正在运行的动作。进程已经 `idle` 时停止什么都不做，回执照发。
- `ps` 的进程按 ID 排序，包括 `idle` 的。每个投影带自己的 `now` 和 `siblings`。
- `error` 可能跟在回执后面：`watch` 里的 `pump` 抛出时（见[坑点](#坑点)）。

### 请求的校验（`parseRequest`）

- 每个连接只读第一行。`\r\n` 算一个换行。
- 不是合法 JSON：`error`，内容是 `JSON.parse` 的错误信息。
- 必须是带 `op` 的对象，字段都是字符串：`start` 要 `preset`、`text`；`send` 要 `process`、`text`；`stop` 要 `process`。否则 `error`：“无法识别的请求：<原文>”。
- 只查类型。空串能通过，多余的字段被忽略。空预设 ID 由 `loadPreset` 拒绝；空消息会成为一条用户消息。CLI 不发空消息。
- 预设读不出、进程不存在、进程 ID 冲突，都回 `error`。这些情况下库里什么都没写。

### 进程 ID

`randomBytes(4).toString("hex")`：8 个小写十六进制字符。不含预设 ID，不按时间排序。撞上已有 ID 时 `startProcess` 主键冲突，回 `error`，不重试。

### 流式文本

- 执行器把模型的 `text_delta` 交给服务（[kb-executor.md](kb-executor.md#调用模型actionsts)）。服务转发给这个进程此刻的全部观察者，一段一行 `text`。
- 不进库，不进投影。`ps`、`stop` 的连接收不到。
- 观察者从登记那一刻起收，直到最终回复。中途加入的连接从半句开始收。
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
- 运行多久只用一个单位：`<n>秒`、`<n>分`、`<x.x>时`、`<x.x>天`。和 `self` 一样向下取整，所以 `ps` 不会比 `self` 显示得更久。
- 没有进程时，第二行是 `没有进程。`。
- 投影里有、`ps` 没显示的：模型、排队消息数、本段开始多久、兄弟进程、出错的原因。

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

- `tau.cmd` 只有一行：`@node --disable-warning=ExperimentalWarning "%~dp0src\main.ts" %*`。它按自己所在的目录找 `src\main.ts`，在任何当前目录都能用。需要 PATH 上的 `node`（`package.json` 要求不低于 24.14），直接运行 `.ts`。
- 这个参数让 `node:sqlite` 不打印 `ExperimentalWarning`（[D11](kb-decisions.md#d11-sqlite-驱动)）。只有 `serve` 加载 `node:sqlite`，但脚本对所有命令都加。`npm test` 和 kill 测试的子进程加同样的参数。
- `src/main.ts`：第一个参数是 `serve` 就动态导入服务的模块并启动，其余参数忽略。否则交给 CLI 的 `main`，返回值写进 `process.exitCode`。
- 管道名、库和预设的位置写死在 `protocol.ts`、`main.ts` 和 `presets/load.ts`。`serve()` 和 CLI 的 `main` 接受别的管道和路径，只给测试用。
- 服务的模型目录是 `builtinModels({ credentials })`（[kb-executor.md](kb-executor.md#调用模型actionsts)）。`credentials` 只读 `~/.pi/agent/auth.json` 里 `type` 为 `api_key` 的条目，每次调用都重读，从不写入（`src/server/credentials.ts`，理由见 [D23](kb-decisions.md#d23-凭据只读复用-pi-的凭据文件)）。
- 文件里这个 provider 的 `key` 非空时，API Key 用它。没有这个条目（包括只有 OAuth 条目）、`key` 缺失或为空时，pi-ai 从服务进程的环境变量读 API Key（例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`）。pi-ai 逐字段合并：条目的其他字段（`env`）也一样。
- 只支持字面量 `key`。以 `!` 开头（pi 当命令执行）或含 `$`（pi 当变量和转义）的 `key` 会报错，不原样发出去。
- 文件不存在算没有凭据。不是合法的 JSON、顶层不是对象、`key` 不是字符串时，这次模型调用以错误结束。报错不带文件内容：V8 的 JSON 报错会引用出错处附近的原文，可能是 key 的开头，而报错会存进库、显示在 CLI 上。
- 路径写死成 `~/.pi/agent/auth.json`，不跟随 pi 的 `PI_CODING_AGENT_DIR`。
- 模型调用由服务进程发出。CLI 的环境不影响模型调用。

### 退出

- `main.ts` 用 `process.once` 接第一次 `SIGINT` 和 `SIGTERM`，调用 `service.close()`，完成后退出码 0。
- `close()`：
  1. 标记 `closing`。之后动作的 promise 被拒绝，不再让进程退出。
  2. `server.close()`：不再接受新连接，并等现有连接全部结束。这期间 `pump` 照常工作。
  3. 关库。随后 `process.exit(0)`。
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
| 协议是 JSON 行 | CLI 是唯一的客户端，不需要 HTTP 的路由和 SSE 分帧（D16、D18 第 17 条） |
| 进程 ID 是 8 个十六进制字符；撞上就回 `error`，不重试 | 短，好敲 |
| CLI 打印流式文本；没收到流式文本时，才打印最终回复 | 同一段文字不打印两次。代价：屏幕上的字不一定是库里的最终回复（见[坑点](#坑点)） |
| `main.ts` 走 CLI 时不加载服务的模块 | CLI 只依赖协议（[设计稿第 3 节](../docs/design/mvp.md#3-总体结构)） |

## 认知模型

- 服务 = 一把锁（管道）+ 一个库 + 一个执行器 + 一个同步的 `pump` + 一张观察者表。
- 状态全在库里。服务内存里只有执行器的中止开关和观察者表，崩溃后两者都可以丢。
- 一个命令 = 一个事务 + 一次 `pump`。回执是服务对客户端唯一的承诺：它说的是“已提交”，不是“已处理”。
- 从零重建：`listen`、`openDb`、`createExecutor`、`pump`、`settle`、`parseRequest`，加一个只懂协议的 CLI。
- 一次修改越界的信号：
  - 在 `pump` 之外调用 `handleNext` 或 `startNext`，或者让 `pump` 变成异步。
  - 回执在提交之前发。
  - 往信箱放输入之后不跟一次 `pump`。
  - 最终回复来自流式文本。
  - 观察者表写进库，或者服务在内存里记住别的状态。
  - CLI 导入 `protocol.ts` 以外的 tau 模块，或者自动重发。
  - 在拿到管道之前开库。

## 投影与命令

- 服务不加投影字段。`ps` 回的是 `observe` 的结果：字段归 [kb-kernel.md](kb-kernel.md#投影与命令)，`self` 的文字归 [kb-store.md](kb-store.md#self)，`tau ps` 的文字在本页。
- 命令：`tau serve`、`tau start`、`tau send`、`tau ps`、`tau stop`。
- Agent 没有专门的控制命令。有 `bash` 的进程可以直接运行 `tau`：`self` 只读是接口的范围，不是权限边界（[设计稿第 9 节](../docs/design/mvp.md#9-自省)）。

## 入口

| 路径 | 内容 |
|---|---|
| `src/server/serve.ts` | `serve`：启动顺序、`pump`、`settle`、`watch`、`handle`、`finalReply`、`parseRequest`、`close` |
| `src/server/listen.ts` | `listen`：在命名管道上监听；`EADDRINUSE` 变成“已经有一个 tau 服务” |
| `src/server/credentials.ts` | `piCredentials`：只读 pi 的凭据文件，只交出 `api_key` 条目 |
| `src/protocol.ts` | `PIPE`、`Request`、`Reply` |
| `src/cli/main.ts` | `main`（命令和退出码）、`request`（连接、发一行、逐行交出回复）、`formatPs`、`ago` |
| `src/main.ts` | 入口：`serve` 或 CLI；`~/.tau` 的位置；信号处理 |
| `tau.cmd` | 启动脚本 |
| `test/server/e2e.test.ts` | faux 模型端到端；回执之前断开；连不上 |
| `test/server/pairing.test.ts` | 服务层的工具调用配对：按顺序、运行中停止、运行中崩溃 |
| `test/server/kill.test.ts`、`test/server/child.ts` | 子进程里的真服务被随机硬杀 |
| `test/server/listen.test.ts` | 单实例 |
| `test/server/credentials.test.ts` | 只交出 `api_key`；不写入；文件不存在、格式坏、顶层不是对象，报错不带文件内容；只支持字面量 key；每次重读；接进 pi-ai 后 key 的优先顺序和坏文件的结果 |
| `test/server/cli.test.ts` | 第 5 步验收：经 CLI 同时跑两个进程；`self` 和 `tau ps` 一致；流式文本；模型不在目录里 |

命令：`npm test`。只跑服务测试：`node --disable-warning=ExperimentalWarning --test "test/server/*.test.ts"`。

### 服务测试（`test/server/`）

都走真的管道、库和 `createActions`，模型是 pi-ai 的 faux。

| 测试 | 证明 |
|---|---|
| e2e：读文件、改一行、跑命令 | 第一行是回执，最后一行是 `{ final, "改好了。", done }`；文件被改；3 个工具结果进了段；`ps` 显示 `idle` |
| e2e：回执之前断开 | 一个收下连接就断开的假服务：`tau send` 退出码 3，提示“结果未知” |
| e2e：连不上 | `tau ps` 退出码 2，提示先运行 `tau serve` |
| pairing：3 个调用按顺序 | `read`、`bash`、`read` 各一个结果，按调用顺序紧跟助手消息；第 3 个读到第 2 个写的内容；模型的第二次请求里也是这个顺序 |
| pairing：第 2 个调用运行中停止 | `stop` 只回回执；等着的连接收到 `{ final, "", stopped }`；bash 在断言的 2.5 秒内退出（不中止要 5 秒）；结果依次是真结果、`INTERRUPTED`、`SKIPPED`；之后 `send` 照常；被中止的命令没有跑完 |
| pairing：第 2 个调用运行中崩溃 | 进程内模拟崩溃（先关库句柄，再断开连接、停止监听）：客户端只拿到回执；崩溃点是 `running` 行；下一次 `serve()` 返回时已恢复并处理完，本轮以“服务重启”的错误结束；之后 `send` 照常；崩溃前的 bash 跑完了，结果没进库，也没被重做 |
| kill：随机硬杀 5 次 | 3 个进程不停收消息，有时运行中再发，有时停止；在带种子的时刻 `taskkill /T /F` 杀掉服务。每次杀后测试自己开库：不变量成立；只做恢复后没有 `running` 行，`pending` 行不动。至少一次杀在副作用运行中。最后全部 `idle`，信箱和副作用表为空；工作段里每条用户消息都发过，只在发给的进程里出现一次；有回执的消息都在 |
| listen：跨进程、同进程 | 第二次监听同一个管道失败，提示“已经有一个 tau 服务”；第一个关掉后能再监听 |
| cli：两个进程同时运行 | 经 `main` 启动带记忆和不带记忆的两个预设；`ps` 显示两个都在运行；带记忆的 `memory_set` 后 `memory_get` 读回；不带记忆的看不到记忆工具；`stop` 一个，另一个照常，迟到的回复被丢弃 |
| cli：`self` 和 `ps` 一致 | 同一个预设的两个进程，一个被拦住；另一个的 `self` 显示用量、窗口、时间、时区和运行中的兄弟；`ps` 的投影在 ID、预设、模型、段号、窗口和兄弟上一致 |
| cli：流式文本 | 流式片段拼起来等于最终回复；CLI 只打印一次 |
| cli：模型不在目录里 | 本轮以“模型目录里没有”的错误结束，回复不入段；模型放回后进程照常可用 |

## 坑点

- **在 `pump` 之外推进状态。** `pump` 的同步是服务里“没有并发”的唯一来源。验证：pairing 的停止用例（中止及时到达）、kill 测试。
- **pi 正在写凭据文件。** pi 在锁里原地截断再写，tau 读时不拿锁。读到空文件或半个文件时，这次模型调用以“不是合法的 JSON”结束，重发即可。窗口很小，但服务要跑很多年。
- **回执提前发。** 回执必须在事务提交之后。kill 测试断言有回执的消息一条不丢。
- **`settle` 不查信箱。** 进程 `idle` 而新消息还在排队时，新连接会拿到上一轮的回复。这一条没有专门的测试。
- **`pump` 抛出。** `handleNext` 或 `claim` 抛出，说明库或代码坏了（[kb-store.md](kb-store.md#坑点)）。在请求里抛出时，已经发了回执的连接再收到一行 `error`，CLI 退出码 1，服务继续跑，信箱卡住。在动作结束后的 `pump` 里抛出时，没有人接住，Node 按未处理的拒绝让进程以码 1 退出，不经过 `fatal`。重启后第一次 `pump` 再抛出，服务起不来。
- **关闭要等连接。** 有连接在等最终回复时，Ctrl+C 之后服务继续工作，直到这些回复发完。要立刻停，再按一次 Ctrl+C。
- **断开之后拿不回回复。** 观察者不持久，也没有读回复的命令。`tau ps` 只给阶段。
- **“结果未知”时 `tau ps` 只能间接判断。** `start` 看有没有多出一个进程；`send` 看不出消息进没进库，`ps` 不显示消息。
- **屏幕上的文字不一定在库里。** CLI 收到过流式文本，就不打印 `final.reply`。流式文本包括交接说明和被丢弃的回复，多次模型调用的文字直接连在一起。
- **Agent 对自己运行 `tau send`。** CLI 等这个进程回到 `idle`，进程在等这次 bash，只能等 bash 超时。消息已经提交，会作为排队的消息在本轮结束时处理。
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
