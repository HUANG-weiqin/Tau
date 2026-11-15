# 执行器

`updated: 2026-11-15`

## 这个模块是干什么的

执行器执行库外副作用：调用模型，运行 `read`、`write`、`edit`、`bash`。它只做三件事：开始、中止、上报。

它负责：

- 从待办副作用表取一个副作用，开始它，把结果放进信箱。
- 中止一个正在运行的副作用。
- 服务启动时，把上次没跑完的副作用作为“被中断”送回。
- 把动作的失败变成普通的结果。

它不负责：

- 决定下一步。那是 `decide` 和 `effectOf`（[kb-kernel.md](kb-kernel.md)）。
- 插入待办副作用表的行，或因为停止而删行。那是处理输入的事务（[kb-store.md](kb-store.md#同步副作用)）。
- 库内副作用（`memory_*`、`self`）。它们在处理输入的事务里执行。
- 重试和超时。没有自动重试。模型调用没有超时；bash 的超时在工具里。
- 工具的实现，包括 bash 怎样结束进程树（[设计稿第 10 节](../docs/design/mvp.md#10-工具)）。

本页接管[设计稿第 6 节](../docs/design/mvp.md#6-执行器与崩溃)的细节。

## 架构

### 一行的一生

待办副作用表每个进程最多一行：`(process_id, n, status)`。副作用的内容不存，由 `effectOf` 算出。

| 谁 | 什么时候 | 行 | 信箱 |
|---|---|---|---|
| 处理输入 | 进程开始等库外副作用 n | 插入 `pending` | 不动 |
| 执行器 `claim` | `startNext` | `pending` → `running` | 不动 |
| 执行器 `complete` | 动作结束 | 还在就删 | 行还在才放结果，否则丢弃 |
| 处理输入 | 进程不再等 n（例如停止） | 删；删的是 `running` 时返回 n | 不动 |
| 执行器 `recover` | `createExecutor` | 删掉全部 `running` | 每行放一个 `interrupted` |

- 执行器的三个函数各是一个 `BEGIN IMMEDIATE` 事务（`store/db.ts` 的 `tx`）。
- `claim` 读进程记录和当前段，用 `effectOf` 算出副作用，核对编号。对不上（进程不存在、不在等、编号不同）就抛出，事务回滚。这说明库或代码坏了。
- 同一个进程的编号只增不减，所以 `(process_id, n)` 确定一次副作用。`complete` 按这两列删行。
- `claim` 不排序，取到哪个 `pending` 行不确定。服务每次把 `pending` 行全部开始。
- 每个进程最多一行，所以同时运行的动作不超过运行中的进程数。没有并发上限。

### 控制流

```text
startNext()
  claim 提交 → 登记中止开关 → 同步开始动作      （三步之间不让出）
  动作结束 → 构造 Input → complete 提交 → 删掉中止开关
abort(id, n)
  有这个中止开关就中止；没有就什么都不做
```

- `startNext` 返回时动作已经开始。没有 `pending` 行时返回 `null`。
- 返回的 promise 在结果写回或被丢弃之后完成。`complete` 抛出（例如库已关）时，promise 被拒绝。
- 中止开关在 `finally` 里删掉。
- 执行器不自己发现行被删了。服务的 `pump` 在 `handleNext` 返回 `abort` 时调用 `exec.abort`，然后循环 `startNext` 直到 `null`（`src/server/serve.ts`，[设计稿第 11 节](../docs/design/mvp.md#11-服务与-cli)）。

### 活状态

执行器内存里只有一张表：`Map<string, AbortController>`，键是 `JSON.stringify([进程 ID, n])`。这是它唯一的活状态。崩溃后它消失，恢复把对应的 `running` 行变成 `interrupted`。

### 失败怎样变成结果

`Actions` 只返回内容。结果的种类和编号由执行器按 `Job.effect` 填写。

| 情况 | 放进信箱的输入 |
|---|---|
| `callModel` 返回 | `modelResult`，`ok`，助手消息原样 |
| `callModel` 同步抛出或被拒绝 | `modelResult`，`ok`，一条 `stopReason: "error"` 的助手消息：`errorMessage` 是错误信息，`content` 为空，用量为 0，`api` 是 `unknown`，provider 和 model 从预设的模型 ID 拆出 |
| `runTool` 返回 | `toolResult`，`ok`，内容原样 |
| `runTool` 同步抛出或被拒绝 | `toolResult`，`ok`，`工具执行失败：<信息>`，`isError: true` |
| 恢复时进程在 `awaitingModel` | `modelResult`，`interrupted` |
| 恢复时进程在 `awaitingTool` | `toolResult`，`interrupted` |

- 模型失败只有一条路：写在助手消息里，`decide` 按 `stopReason` 处理（[kb-kernel.md](kb-kernel.md)）。
- 结果文本的长度由 `decide` 统一裁剪（[kb-kernel.md](kb-kernel.md)）。

### 调用模型（`actions.ts`）

1. 按第一个 `/` 把快照里的模型 ID 拆成 provider 和模型 ID，用 `models.getModel` 现查。查不到就抛出 `模型目录里没有 <ID>`，执行器把它变成 `error` 回复。
2. `models.streamSimple(model, buildContext(process, segment), { signal, sessionId: process.id })`。
3. 只把 `text_delta` 事件交给 `onText`。服务转发给等这个进程的连接。流式文本只是预览，不进库。
4. 返回 `stream.result()`，也就是最终的助手消息。

- 服务的模型目录是 `builtinModels()`（`@earendil-works/pi-ai/providers/all`）。`createModels()` 返回空目录，测试用它装 faux provider。
- `sessionId` 用进程 ID，换段后不变。支持会话缓存的 provider 会用它。
- tau 不传凭据。凭据由 pi-ai 的模型目录解决。
- 请求用 `claim` 时读出的进程记录和工作段。运行中排队的用户消息在 `turn.queued` 里，不进这次请求。

### 运行工具（`actions.ts`）

1. 从 `toolDefinitions(preset)` 找到工具描述。
2. 用 pi-ai 的 `validateToolArguments(tool, call)` 校验参数。它先按 JSON Schema 转换类型（`"5"` 变成 `5`），再检查。`null`、缺必填字段、多出字段都失败。失败时回 `参数错误：<pi-ai 的说明>`，`isError: true`。说明里带收到的参数原文。
3. 按名字调用 `read`、`write`、`edit`（传工作目录），或 `bash`（传工作目录和中止信号）。

- 只有 `bash` 拿到中止信号。`read`、`write`、`edit` 被中止时照样跑完，结果被丢弃。
- 库内工具的参数不经过这里。它们在处理输入的事务里处理，`null` 参数当作空对象。
- 工具不在预设里、或者名字是库内工具时，`runTool` 也回错误结果。正常流程走不到这两支：只有库外工具会进待办副作用表。

### 崩溃窗口

进程可能在任何一条指令上被杀。事务中途被杀等于没提交，由 SQLite 回滚。所以只看两次提交之间：

| 被杀时 | 库里 | 重启后 |
|---|---|---|
| 处理输入插入 `pending` 之后、`claim` 之前 | `pending` 行 | 照常开始：它从没开始过 |
| `claim` 提交之后、动作开始之前 | `running` 行 | `interrupted`：和下面两行无法区分 |
| 动作运行中 | `running` 行 | `interrupted`：外部世界可能已经改了 |
| 动作结束之后、`complete` 提交之前 | `running` 行 | `interrupted`：结果丢失 |
| `complete` 提交之后 | 结果在信箱里 | 照常处理 |
| 停止删掉 `running` 行之后、动作结束之前 | 没有行，进程 `idle` | 什么都不送 |
| 恢复提交之后 | 没有 `running` 行 | 再恢复一次什么都不改 |

- 收到 `interrupted` 后内核结束本轮（[kb-kernel.md](kb-kernel.md)）。
- `running` 行属于 `idle` 或不存在的进程时，恢复抛出，服务不启动。
- 服务正常退出时只关库，不中止动作。效果和崩溃一样：行留在 `running`，下次启动作为 `interrupted` 送回。bash 的子孙进程可能还在跑（设计稿[风险](../docs/design/mvp.md#风险)）。

## 决策

| 决定 | 原因 |
|---|---|
| 执行器只开始、中止、上报，不决策，不重试 | 不纯的东西关进执行器（[D4](kb-decisions.md#d4-纯-decide单信箱事务提交)） |
| 三个事务的边界写死；登记中止开关和开始动作之间不让出 | 否则崩溃会让行和结果一起消失（[D19](kb-decisions.md#d19-第四轮审查fable-52-复审-d18-之后的文档)） |
| 停止和删行在同一个处理输入的事务里；`complete` 发现行不在就丢弃 | 执行器不会在停止之后开始或上报副作用（[D18](kb-decisions.md#d18-第三轮审查两个审查者24-项修改) 第 1 条） |
| 恢复一律送 `interrupted`，不重做 | 崩溃后不猜测外部世界（D18） |
| 恢复写在 `createExecutor` 里 | 不能被跳过；运行时中止开关表一定是空的 |
| `Actions` 是两个有类型的函数，执行器自己构造 `Input` | 动作写不错结果的种类和编号；测试换一组假动作就能测执行器 |
| 动作抛出也变成结果 | 模型失败和 pi-ai 一样写在助手消息里（D18 第 3 条）；工具失败是结果内容（[kb-kernel.md](kb-kernel.md)） |
| 调用时才从模型目录取模型 | 快照只冻结 `contextWindow`（D19） |

## 认知模型

- 一行是一份租约：`pending` 表示还没开始，`running` 表示可能已经开始。
- 对一个库外副作用 n，“表里有 n 这一行”和“信箱里有 n 的结果”恰好一个成立。三个事务都保持这一条：`claim` 不动信箱；`complete` 删行和放结果一起做；`recover` 删行和放 `interrupted` 一起做。
- 从零重建：三个事务、一张中止开关表、一个两函数的 `Actions` 接口。
- 一次修改越界的信号：
  - 执行器内存里多了中止开关以外的状态。
  - 执行器读结果内容做判断，或者重试。
  - `claim` 和开始动作之间出现 `await`。
  - 删行和放结果分到两个事务。
  - 恢复时重做 `running` 的副作用。

## 投影与命令

- 执行器的状态不进投影。投影里的“等模型”“等工具”来自进程记录的阶段。
- 流式文本只发给 `start`、`send` 的连接，不进投影，也不进库。
- 执行器不新增命令。`tau stop` 经信箱停止进程，间接中止动作。

## 入口

| 路径 | 内容 |
|---|---|
| `src/executor/executor.ts` | `createExecutor`、`Executor`、`Actions`、`Job`；`claim`、`complete`、`recover` |
| `src/executor/actions.ts` | `createActions`：调用模型、校验参数、分派工具 |
| `src/server/serve.ts` | `pump`：把 `handleNext` 的 `abort` 接到 `exec.abort`，循环 `startNext` |
| `src/main.ts` | 用 `builtinModels()` 建模型目录 |
| `test/store/executor.test.ts` | 开始、完成、中止、失败上报、启动恢复、竞态 |
| `test/store/crash.test.ts` | 真库上的随机序列和崩溃注入 |
| `test/store/fixtures.ts` | `gated`（测试决定何时完成，中止时拒绝）、`scripted`、`settle` |
| `test/store/invariants.ts` | 存储层不变量，每个事务之后都查 |
| `test/server/e2e.test.ts` | 真的 `createActions` 加 faux 模型，走管道和库 |
| `test/server/pairing.test.ts` | 服务层的工具调用配对：按顺序执行、运行中停止、运行中崩溃 |
| `test/server/kill.test.ts` | 服务运行中被硬杀几次：每次恢复后没有 `running` 行，不变量成立 |

命令：`npm test`。

### 崩溃注入（`test/store/crash.test.ts`）

- 带种子的随机数排出一串步骤。每一步恰好提交一个事务：`start`、`send`、`stop`、`handle`、`claim`、`complete`。
- 假模型的回复只由进程 ID 和副作用编号决定，所以同一个种子重放完全一样。它会调用库外工具、库内工具、预设里没有的工具和不存在的工具；窗口小，会换段；会出错。
- 每个种子先不崩溃跑一遍，数出步数 N。再对 k = 1…N 各重放一次，在第 k 步之后崩溃。所以每个事务边界都是崩溃点。
- `claim` 开始的动作由测试决定何时完成。动作没完成时崩溃，就是“标记 `running` 之后、结果写回之前”的窗口。
- 崩溃 = 丢下执行器和没完成的动作，关掉库句柄，再 `openDb`、`createExecutor`（恢复）。
- 崩溃后断言：
  - 没完成的动作恰好是 `running` 的行；`pending` 的行原样留着。
  - 信箱原有的部分不变，新增的恰好是每个 `running` 行的 `interrupted`。
  - 旧动作这时才结束，写库失败（`not open`），信箱不变。
  - 恢复之后立刻再崩溃一次，什么都不变。
- 跑到收敛后断言：信箱和副作用表都空，全部 `idle`；每条用户消息恰好出现一次；没有动作被开始两次；每个工具调用恰好一个结果；每条助手消息只写一次。
- 最后断言每种事务之后都崩溃过，`running` 窗口也崩溃过。

### 执行器测试（`test/store/executor.test.ts`）

| 测试 | 证明 |
|---|---|
| 开始、完成 | `startNext` 返回时动作已经开始，行是 `running`；完成后删行，结果进信箱 |
| 模型动作同步抛出 | 变成 `error` 回复，进程回到 `idle`，结束原因是错误信息 |
| 工具 promise 被拒绝 | 变成 `工具执行失败：<信息>` |
| 中止 | 停止删掉 `running` 行并返回编号；`abort` 让信号中止；结果被丢弃；再 `abort` 什么都不做 |
| 动作结束时行已不在 | 没人中止也丢弃结果 |
| 启动恢复 | `running` 行按阶段送回 `interrupted`；`pending` 行照常开始；旧动作写不进新库 |
| 竞态：停止时还是 `pending` | 执行器绝不会再开始它 |
| 竞态：库外工具结果排在用户消息后面 | 先处理用户消息不会再插行，工具只执行一次 |
| 竞态：库内工具结果排在用户消息后面 | `memory_set` 只执行一次 |

## 坑点

- 在 `claim` 和开始动作之间加 `await`：中止可能落在登记之前，动作在停止之后照样跑完。“开始、完成”测试断言 `startNext` 返回时动作已经开始。
- 让动作自己写库或构造 `Input`：绕过 `complete` 的“行还在才放”。
- 把中止当成“外部世界没变”：只有模型和 bash 收到信号，文件工具照样写完。中止只保证结果被丢弃。
- 一次服务启动建两个执行器：第二个的恢复会把第一个正在跑的副作用当成被中断。
- 模型调用挂住时，执行器不会超时。进程一直在 `awaitingModel`，只能停止它。
- 崩溃测试的库句柄设 `synchronous = OFF`。原因和限制见 [kb-store.md 的坑点](kb-store.md#坑点)。

## 关联模块

- [kb-overview.md](kb-overview.md)：运行循环和状态分层。
- [kb-decisions.md](kb-decisions.md)：D4、D18、D19。
- [kb-kernel.md](kb-kernel.md)：`effectOf`、结果的丢弃和裁剪、`interrupted` 怎样结束本轮。
- [kb-store.md](kb-store.md)：处理输入的事务、待办副作用表的同步、表结构。
- 工具和 bash 的进程树：[设计稿第 10 节](../docs/design/mvp.md#10-工具)。
- 服务的 `pump` 和观察者：[设计稿第 11 节](../docs/design/mvp.md#11-服务与-cli)。
