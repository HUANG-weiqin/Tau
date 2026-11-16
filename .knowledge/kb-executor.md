# 执行器

`updated: 2026-11-16`

## 这个模块是干什么的

执行器执行库外副作用：调用模型，运行 `read`、`write`、`edit`、`bash` 和工具定义。它只做三件事：开始、中止、上报。

它负责：

- 从待办副作用表取一个副作用，开始它，把结果放进信箱。
- 中止一个正在运行的副作用。
- 服务启动时，把上次没跑完的副作用作为“被中断”送回。
- 把动作的失败变成普通的结果。
- 带图的工具结果：在上报结果的事务里把图片插入 `blobs`。

它不负责：

- 决定下一步。那是 `decide` 和 `effectOf`（[kb-kernel.md](kb-kernel.md)）。
- 插入待办副作用表的行，或因为停止而删行。那是处理输入的事务（[kb-store.md](kb-store.md#同步副作用)）。
- 库内副作用（`memory_*`、`self`、`handoff`、`post`、`spawn`、`stop_process`）。它们在处理输入的事务里执行。
- 自己重试和超时。执行器自己不重试；模型请求在拿到成功的响应之前的重试，交给 pi-ai（见下“重试”）。模型调用没有超时；bash 的超时在工具里。
- 工具的实现，包括 bash 怎样结束进程（[kb-tools.md](kb-tools.md)）。
- 服务怎样调用执行器、怎样把流式文本转给连接（[kb-service.md](kb-service.md)）。

本页接管[设计稿第 6 节](../docs/design/mvp.md#6-执行器与崩溃)的细节。

## 架构

### 一行的一生

待办副作用表每个进程最多一行：`(process_id, n, status)`。副作用的内容不存，由 `effectOf` 算出。

| 谁 | 什么时候 | 行 | 信箱 |
|---|---|---|---|
| 处理输入 | 进程开始等库外副作用 n | 插入 `pending` | 不动 |
| 执行器 `claim` | `startNext` | `pending` → `running` | 不动 |
| 执行器 `complete` | 动作结束 | 还在就删 | 行还在才放结果，否则丢弃；带图的工具结果，图片同一个事务里插入 `blobs`，丢弃时也不插 |
| 处理输入 | 进程不再等 n（例如停止） | 删；删的是 `running` 时返回 n | 不动 |
| 执行器 `recover` | `createExecutor` | 删掉全部 `running` | 每行放一个 `interrupted` |

- 执行器的三个函数各是一个 `BEGIN IMMEDIATE` 事务（`store/db.ts` 的 `tx`）。
- `claim` 读进程记录和当前段，用 `effectOf` 算出副作用，核对编号。对不上（进程不存在、不在等、编号不同）就抛出，事务回滚。这说明库或代码坏了。
- 同一个进程的编号只增不减，所以 `(process_id, n)` 确定一次副作用。`complete` 按这两列删行。进程删了以后 ID 可能被新进程碰上，编号从头算；所以服务删进程之前先查执行器没有它的动作（`busy`，见 [kb-service.md](kb-service.md#删除)），`(process_id, n)` 照样确定一次副作用。
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
- 执行器不自己发现行被删了。服务的 `pump` 在 `handleNext` 返回 `abort` 时调用 `exec.abort`，然后循环 `startNext` 直到 `null`（`src/server/serve.ts`，[kb-service.md](kb-service.md#pump)）。

### 活状态

执行器内存里只有一张表：`Map<string, AbortController>`，键是 `JSON.stringify([进程 ID, n])`。这是它唯一的活状态。崩溃后它消失，恢复把对应的 `running` 行变成 `interrupted`。

`busy(id)`：只读，看这张表里有没有这个进程的键。服务删进程之前用它（[kb-service.md](kb-service.md#删除)）。

### 失败怎样变成结果

`Actions` 只返回内容。结果的种类和编号由执行器按 `Job.effect` 填写。`runTool` 返回的 `ToolOutput` 是 `ToolResultContent` 加一个可选的 `images`：内容里的图片块已经是 `blob:<hash>` 引用，`images` 是要存的图片（`Image`：哈希、类型、字节）。执行器取出 `images`，其余放进信箱；`complete` 在行还在时先 `putBlobs`，再放结果，同一个事务。

| 情况 | 放进信箱的输入 |
|---|---|
| `callModel` 返回 | `modelResult`，`ok`，助手消息原样 |
| `callModel` 同步抛出或被拒绝 | `modelResult`，`ok`，一条 `stopReason: "error"` 的助手消息：`errorMessage` 是错误信息，`content` 为空，用量为 0，`api` 是 `unknown`，provider 和 model 从预设的模型 ID 拆出 |
| `runTool` 返回 | `toolResult`，`ok`，内容原样（`images` 字段不放进信箱，字节写进 `blobs`） |
| `runTool` 同步抛出或被拒绝 | `toolResult`，`ok`，`工具执行失败：<信息>`，`isError: true` |
| 恢复时进程在 `awaitingModel` | `modelResult`，`interrupted` |
| 恢复时进程在 `awaitingTool` | `toolResult`，`interrupted` |

- 模型失败只有一条路：写在助手消息里，`decide` 按 `stopReason` 处理（[kb-kernel.md](kb-kernel.md)）。
- 结果文本的长度由 `decide` 统一裁剪（[kb-kernel.md](kb-kernel.md)）。

### 调用模型（`actions.ts`）

1. 按第一个 `/` 把快照里的模型 ID 拆成 provider 和模型 ID，用 `models.getModel` 现查。查不到就抛出 `模型目录里没有 <ID>`，执行器把它变成 `error` 回复。
2. `models.streamSimple({ ...model, maxTokens: cap }, resolveImages(buildContext(process, segment), readBlob), { signal, sessionId: process.id, maxTokens: cap, maxRetries: MODEL_RETRIES, reasoning? })`。`cap` = `min(model.maxTokens, outputMax(preset))`，`outputMax` 是窗口的 1/8。快照有 `thinking` 才传 `reasoning`，没有就连键都不传。不传 `thinkingBudgets`。轮次调用和交接调用一样。
3. 只把 `text_delta` 事件连同进程 ID 和副作用编号交给 `onText`。服务怎样转发，见 [kb-service.md](kb-service.md#流式文本)。
4. 返回 `stream.result()`，也就是最终的助手消息。

- 服务的模型目录来自 `@earendil-works/pi-ai/providers/all` 的 `builtinModels`，怎样创建见 [kb-service.md](kb-service.md#启动脚本和入口)。`createModels()` 返回空目录，测试用它装 faux provider。
- `sessionId` 用进程 ID，换段后不变。支持会话缓存的 provider 会用它。
- 凭据由服务在创建模型目录时传入，执行器不管。凭据从哪来见 [kb-service.md](kb-service.md#启动脚本和入口)。
- `resolveImages`（`src/store/blobs.ts`）：请求里图片块的 `blob:<hash>` 换成从 `blobs` 读出的 base64 真数据。`buildContext` 已经成批省略了旧图，所以只读真正要发的图片。段和库不变。引用在 `blobs` 里没有行（存储层不变量保证不会）时抛出，变成 `error` 回复，不发请求。`readBlob` 由服务传给 `createActions`。
- 请求用 `claim` 时读出的进程记录和工作段。运行中排队的用户消息在 `turn.queued` 里，不进这次请求。

输出上限 `maxTokens`：

- 为什么是窗口的 1/8：换段阈值只给一次回复留 `outputMax` 的空间（[kb-kernel](kb-kernel.md#换段阈值)）。请求得更多，交接请求就可能放不进窗口。
- 为什么取较小的：不向模型要它给不了的输出。快照只冻结窗口和 `input`，`model.maxTokens` 调用时现查（[D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)）。
- pi-ai 1.0.0 的 `buildBaseOptions` 取 `options.maxTokens ?? model.maxTokens`，再截到 `max(1, 窗口 − 它的估算 − 4096)`。这一步只会调低。
- pi-ai 的估算是锚点用量加上之后的字符数 / 4，不超过纯函数层的估算（字节数 / 2）。所以轮次调用时这一截不起作用。交接调用时，它最多把交接说明的上限压低“补的结果 + 交接指令”那么多。
思考级别：

- 预设的 `thinking` 是 pi-ai 的 `ThinkingLevel`：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。快照冻结它，执行器照传 `reasoning`。
- 不写就不传，由 pi-ai 按模型的默认处理。不同模型的默认不一样：有的不思考，有的按 provider 的默认思考。
- 思考块照 v1 写进段，按字节算进用量。

一次回复的总输出（含思考）不超过 `cap`，这是换段阈值的前提：

- 传 `{ ...model, maxTokens: cap }`，`options.maxTokens` 也传 `cap`。
- 按预算思考的路径（anthropic-messages 上没有 `forceAdaptiveThinking` 的模型）：pi-ai 先把预算加到 `options.maxTokens` 上，再按模型的 `maxTokens` 截。模型的 `maxTokens` 已经是 `cap`，所以总数不超过 `cap`。预算再被压到“上限减 1,024”以内。
- 其余路径（自适应思考、openai-completions、openai-responses）：思考和回答共用 `max_tokens`（responses 是 `max_output_tokens`），就是 `cap`。这是 provider 的语义，已用真模型核实（[D34](kb-decisions.md#d34-第-3-步真模型核实)）；muse-spark-1.3-contributor 超过上限，不支持。
- `xhigh` 和 `max` 在预算路径上按 `high` 的预算算（pi-ai 的 `clampReasoning`）。
- 为什么不从 `maxTokens` 里减预算：只有预算路径会把预算加回去。别的路径上，减掉的部分白白少了。窗口小的模型只剩 1,024，回复以 `length` 结束，本轮出错。

预算路径上回答的空间：

- 回答最坏剩 max(`cap` − 预算, 1,024)。`cap` 不大于“预算 + 1,024”时，pi-ai 把预算压到 `cap − 1,024`，回答只剩 1,024。
- pi-ai 的默认预算：`minimal` 1,024，`low` 2,048，`medium` 8,192，`high` 及以上 16,384。所以回答只剩 1,024 的边界是：`high` 及以上 `cap` ≤ 17,408，`medium` ≤ 9,216，`low` ≤ 3,072，`minimal` ≤ 2,048。
- pi-ai 1.0.0 的目录里，落在这里的是 vercel-ai-gateway 经 anthropic-messages 接入的 21 个非 Anthropic 模型，例如 zai/glm-4.5。其中 6 个连 `medium` 也落在范围里（`cap` 5,120 到 8,250）。Anthropic 自己的模型 `cap` 都不小于 25,000。在用的 haiku-4-5 在 `high` 及以上最坏剩 8,616。
- 预设换到走预算路径的模型，先按上面的式子算。落在范围里，就把 `thinking` 降到不落在范围里的级别，或者不设 `thinking`，或者换模型。预设没有 `thinkingBudgets`，执行器也不传它。测试和核实表查不出这件事，只能靠算。

重试：

- 执行器传 `maxRetries: MODEL_RETRIES`（5）。pi-ai 1.0.0 的 `maxRetries` 默认是 0，所以必须显式传。`maxRetryDelayMs` 的默认就是 60,000，不传。
- pi-ai 只重试拿到成功的响应之前的失败：没有状态码的连接错误，以及 408、409、429 和 5xx 的错误响应，以错误响应的 `x-should-retry` 头为准。重试可以被中止。
- 等多久：错误响应带 `retry-after-ms` 或 `retry-after` 时，按它等；超过 60 秒就直接失败，429 通常带这个头，5 次最坏约 5 分钟。不带时，退避从 0.5 秒起翻倍，乘 0.75 到 1 的随机数，单次最多 8 秒，5 次一共约 12 到 16 秒。等的时候，进程停在“等模型”。
- 这不是重做副作用：还是同一个副作用，也还没有任何结果。崩溃后照样报“被中断”，不重做。
- 流式输出开始以后出的错不重试，本轮出错结束。这比 Pi SDK 弱：它按最终消息判断要不要重试。
- 状态：重试不存状态。

### 运行工具（`actions.ts`）

1. 从 `toolDescriptions(preset)` 找到工具描述。
2. 用 pi-ai 的 `validateToolArguments(tool, call)` 校验参数。它先按 JSON Schema 转换类型（`"5"` 变成 `5`），再检查。参数整体是 `null`、缺必填字段、多出字段都失败。失败时回 `参数错误：<pi-ai 的说明>`，`isError: true`。说明里带收到的参数原文。
3. 按名字调用 `read`、`write`、`edit`（传工作目录），或 `bash`（传工作目录、中止信号，以及进程 ID 和管道名）。进程 ID 是 `job.process.id`；管道名是 `createActions` 的第三个参数，服务传它实际监听的管道（`opts.pipe`）。bash 把这两个值放进命令的环境（[kb-tools](kb-tools.md#包装脚本)）。别的名字，在快照的 `toolDefs` 里找工具定义，用 `runToolDef` 运行：参数、工作目录、中止信号、进程 ID 和管道名同 `bash`，再加快照的 `input` 是否含 `image`（[kb-tools](kb-tools.md#运行工具定义)）。

- 单个字段是 `null` 不一定失败：校验会改写一些值。工具收到的是改写后的值（[kb-tools.md](kb-tools.md#参数从哪来)）。
- 只有 `bash` 和工具定义拿到中止信号。`read`、`write`、`edit` 被中止时照样跑完，结果被丢弃。
- 库内工具的参数不经过这里。它们在处理输入的事务里处理，`null` 参数当作空对象。
- 工具不在预设里、或者名字是库内工具时，`runTool` 也回错误结果。正常流程走不到这两支：只有库外工具会进待办副作用表。名字既不是内置库外工具、快照的 `toolDefs` 里也没有时，回 `工具 <name> 不由执行器运行。`。

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

- 收到 `interrupted` 后纯函数层结束本轮（[kb-kernel.md](kb-kernel.md)）。
- `running` 行属于 `idle` 或不存在的进程时，恢复抛出，服务不启动。
- 服务正常退出时不中止动作（[kb-service.md](kb-service.md#退出)）。没跑完的动作效果和崩溃一样：行留在 `running`，下次启动作为 `interrupted` 送回。bash 和它的子孙进程继续运行（[kb-tools.md](kb-tools.md#坑点)）。

## 决策

| 决定 | 原因 |
|---|---|
| 执行器只开始、中止、上报，不决策，自己不重试 | 不纯的东西关进执行器（[D4](kb-decisions.md#d4-纯-decide单信箱事务提交)） |
| 三个事务的边界写死；登记中止开关和开始动作之间不让出 | 否则崩溃会让行和结果一起消失（[D19](kb-decisions.md#d19-第四轮审查fable-52-复审-d18-之后的文档)） |
| 停止和删行在同一个处理输入的事务里；`complete` 发现行不在就丢弃 | 执行器不会在停止之后开始或上报副作用（[D18](kb-decisions.md#d18-第三轮审查两个审查者24-项修改) 第 1 条） |
| 恢复一律送 `interrupted`，不重做 | 崩溃后不猜测外部世界（D18） |
| 恢复写在 `createExecutor` 里 | 不能被跳过；运行时中止开关表一定是空的 |
| `Actions` 是两个有类型的函数，执行器自己构造 `Input` | 动作写不错结果的种类和编号；测试换一组假动作就能测执行器 |
| 动作抛出也变成结果 | 模型失败和 pi-ai 一样写在助手消息里（D18 第 3 条）；工具失败是结果内容（[kb-kernel.md](kb-kernel.md)） |
| 调用时才从模型目录取模型 | 快照只冻结 `contextWindow` 和 `input`（D19、D40） |
| 请求的输出上限取 `min(model.maxTokens, 窗口的 1/8)`，不冻结进快照；模型的 `maxTokens` 也换成它 | 换段阈值按窗口的 1/8 留输出的空间；正确性不需要模型自己的上限（[D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)） |

## 认知模型

- 一行是一份租约：`pending` 表示还没开始，`running` 表示可能已经开始。
- 对一个库外副作用 n，“表里有 n 这一行”和“信箱里有 n 的结果”恰好一个成立。三个事务都保持这一条：`claim` 不动信箱；`complete` 删行、存图片和放结果一起做；`recover` 删行和放 `interrupted` 一起做。
- 从零重建：三个事务、一张中止开关表、一个两函数的 `Actions` 接口。
- 一次修改越界的信号：
  - 执行器内存里多了中止开关以外的状态。
  - 执行器读结果内容做判断，或者自己重试。
  - `claim` 和开始动作之间出现 `await`。
  - 删行和放结果分到两个事务。
  - 恢复时重做 `running` 的副作用。

## 投影与命令

- 执行器的状态不进投影。投影里的“等模型”“等工具”来自进程记录的阶段。
- 流式文本不进投影，也不进库（[kb-service.md](kb-service.md#流式文本)）。
- 执行器不新增命令。`tau stop` 经信箱停止进程，间接中止动作。

## 入口

| 路径 | 内容 |
|---|---|
| `src/executor/executor.ts` | `createExecutor`、`Executor`、`Actions`、`Job`、`ToolOutput`；`claim`、`complete`（含 `putBlobs`）、`recover` |
| `src/executor/actions.ts` | `createActions(models, onText, pipe, readBlob)`：调用模型、校验参数、分派工具（含工具定义） |
| `src/server/serve.ts` | `pump`：把 `handleNext` 的 `abort` 接到 `exec.abort`，循环 `startNext` |
| `src/main.ts` | 用 `builtinModels()` 建模型目录 |
| `test/store/executor.test.ts` | 开始、完成、中止、失败上报、启动恢复、竞态 |
| `test/store/model-call.test.ts` | 真目录里在用的六个模型：经 `createActions`、真的 pi-ai 适配器和假 fetch，用 `onPayload` 断言请求体的输出上限和思考预算；执行器传给 pi-ai 的参数；重试的种类和 60 秒上限 |
| `test/store/crash.test.ts` | 真库上的随机序列和崩溃注入；每个 `read` 结果都带一张图片，崩溃前后 `blobs` 和信箱一致 |
| `test/store/toolimages.test.ts` | 带图的工具结果的最小反例：上报前 `blobs` 没有图片、运行中被杀、上报后被杀、停止后结果丢弃时图片也不写 |
| `test/store/fixtures.ts` | `gated`（测试决定何时完成，中止时拒绝）、`scripted`、`settle` |
| `test/store/invariants.ts` | 存储层不变量，每个事务之后都查 |
| `test/server/e2e.test.ts` | 真的 `createActions` 加 faux 模型，走管道和库 |
| `test/server/pairing.test.ts` | 服务层的工具调用配对：按顺序执行、运行中停止、运行中崩溃 |
| `test/server/kill.test.ts` | 服务运行中被硬杀几次：每次恢复后没有 `running` 行，不变量成立 |

命令：`npm test`。服务层测试的细节见 [kb-service.md](kb-service.md#服务测试testserver)。

### 崩溃注入（`test/store/crash.test.ts`）

- 带种子的随机数排出一串步骤。每一步提交一个事务：`start`、`send`、`stop`、`handle`、`claim`、`complete`、`pruneSegments`、`removeProcess`、`sweepBlobs`。例外：`removeProcess` 被拒绝时这一步什么都不提交。
- 假模型的回复只由进程 ID 和副作用编号决定，所以同一个种子重放完全一样。它会调用库外工具、库内工具、预设里没有的工具和不存在的工具；会换段：靠预设的 `handoff` 阈值和假模型的用量上限触发；会出错。
- 每个种子先不崩溃跑一遍，数出步数 N。再对 k = 1…N 各重放一次，在第 k 步之后崩溃。所以每个事务边界都是崩溃点。
- `claim` 开始的动作由测试决定何时完成。动作没完成时崩溃，就是“标记 `running` 之后、结果写回之前”的窗口。
- 崩溃 = 丢下执行器和没完成的动作，关掉库句柄，再 `openDb`、`createExecutor`（恢复）。
- 崩溃后断言：
  - 没完成的动作恰好是 `running` 的行；`pending` 的行原样留着。
  - 信箱原有的部分不变，新增的恰好是每个 `running` 行的 `interrupted`。
  - 旧动作这时才结束，写库失败（`not open`），信箱不变。
  - 恢复之后立刻再崩溃一次，什么都不变。
- 跑到收敛后断言：信箱和副作用表都空，全部 `idle`；每条用户消息恰好出现一次（被 prune、remove 删掉的，删之前先记进归档，一并计入）；没有动作被开始两次；每个工具调用恰好一个结果；每条助手消息只写一次。
- 最后断言每种事务之后都崩溃过，`running` 窗口也崩溃过，三种删除（prune、remove、sweep）都真的发生过。

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
| 调用模型前换成真数据 | `test/store/blobs.test.ts`：10 张图的段，请求里最早的 4 张是省略说明，其余 6 张是真数据，只读了这 6 张；引用对不上时拒绝、不发请求；`test/server/protocol.test.ts`：faux 模型收到的是 base64，库里仍是引用 |
| 调用模型的 `maxTokens`、`reasoning`、`maxRetries` | `model-call.test.ts` 的六个模型；另有真的 `createActions` 加 faux 模型，几组接近真实目录的窗口和上限：轮次调用和交接调用都请求 `min(model.maxTokens, floor(W/8))` |

## 坑点

- 在 `claim` 和开始动作之间加 `await`：中止可能落在登记之前，动作在停止之后照样跑完。“开始、完成”测试断言 `startNext` 返回时动作已经开始。
- 让动作自己写库或构造 `Input`：绕过 `complete` 的“行还在才放”。
- 把中止当成“外部世界没变”：只有模型、bash 和工具定义收到信号，文件工具照样写完。中止只保证结果被丢弃。
- 一次服务启动建两个执行器：第二个的恢复会把第一个正在跑的副作用当成被中断。
- 模型调用挂住时，执行器不会超时。进程一直在 `awaitingModel`，只能停止它。
- 传 `reasoning` 时只传 `maxTokens` 不够：按预算思考的路径会在 `maxTokens` 之上再加预算（默认最多 16,384），换段阈值的上界就不成立。所以模型的 `maxTokens` 也要换成 `cap`。升级 pi-ai 时，重跑 `test/store/model-call.test.ts`，并重查 `maxTokens` 只会被调低、`maxRetries` 默认值、`retry-after` 上限。
- 预算路径上的小窗口模型，回答可能只剩 1,024（算法见上）。
- 安全点之后的消息形状、思考算不算进输出上限，这两件事由后端决定，结论只对核实过的模型成立（[D34](kb-decisions.md#d34-第-3-步真模型核实)）。路径相同、后端不同，也要重核。预设换到没核实过的模型，先真调用核实一次，再用。只有用户没许真调用的模型（现在是 claude-opus-5-5），才只断言请求体（[D45](kb-decisions.md#d45-第-7-步带图的工具结果的真模型核实)）。muse-spark-1.3-contributor 的输出会超过上限，不支持（[D34](kb-decisions.md#d34-第-3-步真模型核实)）。
- opencode-go 要求请求带会话 ID（`x-opencode-session`）。执行器把进程 ID 作为 `sessionId` 传给 pi-ai，去掉它会被以 400 拒绝（`MissingSessionID`）。直接调 pi-ai 的脚本也要传。
- 崩溃测试的库句柄设 `synchronous = OFF`。原因和限制见 [kb-store.md 的坑点](kb-store.md#坑点)。

## 关联模块

- [kb-overview.md](kb-overview.md)：运行循环和状态分层。
- [kb-decisions.md](kb-decisions.md)：D4、D18、D19。
- [kb-kernel.md](kb-kernel.md)：`effectOf`、结果的丢弃和裁剪、`interrupted` 怎样结束本轮。
- [kb-store.md](kb-store.md)：处理输入的事务、待办副作用表的同步、表结构。
- [kb-tools.md](kb-tools.md)：`read`、`write`、`edit`、`bash` 的实现，bash 怎样结束进程。
- [kb-service.md](kb-service.md)：服务的 `pump`、观察者、流式文本、正常退出。
