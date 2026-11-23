# 总览

`updated: 2026-11-18`

## 这个模块是干什么的

tau 是本机常驻的个人 Agent harness，目标是连续运行很多年。

tau 负责：

- 进程的生命周期：启动、并行、停止、换段。
- 信箱和事务：所有输入怎样排队，状态怎样提交。
- 记忆：Agent 的长期知识。
- 投影：用户和 Agent 看到的同一份状态视图。

tau 不负责：

- Git、编辑器、终端能完整做到的事：diff、历史、回滚、文件浏览、交互式 shell。
- 设计稿里 [MVP 不做](../docs/design/mvp.md#mvp-不做) 的一切。

用词、必须遵守的规则和准入规则在 [AGENTS.md](../AGENTS.md)。三种 Agent 怎样写成预设，见[设计稿第 2 节](../docs/design/mvp.md#2-预设)。

## 架构

### 运行循环

```text
输入（信件 / 副作用结果 / 停止 / 换配置）
        ↓
   信箱（SQLite）
        ↓  按到达顺序一次取一条
   decide：纯函数，算出新的进程记录、要追加的消息和要寄的回信
        ↓  一条输入一个事务（步骤见 kb-store.md）
   effectOf：纯函数，算出进程在等的副作用
        ↓  库内副作用在事务里执行；库外副作用进待办副作用表
        ↓
   执行器：开始 / 中止 / 上报
        ↓
   副作用结果作为新输入回到信箱

   observe：纯函数，给 CLI 的 tau ps 和 Agent 的 self 工具用
```

### 状态分三层

| 层 | 内容 | 能否持久 | 崩溃后 |
|---|---|---|---|
| 库 | 进程记录、工作段、信箱、待办副作用、记忆、图片（`blobs`） | 能 | 原样恢复 |
| 执行器活状态 | 子进程、模型流、中止开关、催的开关 | 不能 | 正在运行的库外副作用全部作为“被中断”送回 |
| 观察者 | 连接和 `watch` 订阅、流式文本 | 不需要 | 重连后重新拉取投影 |

## 决策

跨模块的决定和理由见 [kb-decisions.md](kb-decisions.md)。

## 认知模型

这一节是 tau 的最小心智模型。加功能前，先在这里找到它的位置，再去模块页看细节。怎样一步步推出位置，见 [kb-extending 的推导顺序](kb-extending.md#推导顺序)。

### 名词

定义在 AGENTS.md 的[用词](../AGENTS.md#用词)。推导时只用到这几个：

- 预设是身份。Agent 不是运行时对象，只是预设的 ID。
- 进程是一条正在工作的线，是带持久信箱的 actor：一次处理一条输入，进程之间只靠信件（[D28](kb-decisions.md#d28-v2-的原语)）。
- 工作段是模型的上下文，也是对话的历史。
- 副作用是纯函数层之外的动作。库内的在事务里做，库外的交给执行器。
- 投影是给人和给 Agent 看的同一份视图。

### 一个循环

只有上面那一个[运行循环](#运行循环)，没有旁路。外面的事（CLI 和上层程序的请求）只在边上变成一条输入。例外是建进程的请求（`start` 和 `fork`）：它们只建新进程，不改已有的进程，见 [D49](kb-decisions.md#d49-fork-进内核)。删除的请求（`prune`、`remove`、`sweep`）也是例外：它们不改任何进程的状态，只删不再被引用的东西，见 [D59](kb-decisions.md#d59-删除原语旧段和空闲进程)。写记忆的请求（`memory_write`）也是例外：记忆不是进程状态，协议写入的效果和同预设的兄弟进程写入一样，见 [D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)。只读的请求不改任何东西。`backup` 请求也不改库里的任何东西，只在库外写一个新文件，不算旁路，见 [D73](kb-decisions.md#d73-backup-请求)。`reconfigure` 不是例外：它在信箱里是一条输入，由 `decide` 处理，和信件一样，见 [D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)。

### 进程是一个小状态机

类型见 [kb-kernel](kb-kernel.md#状态)。

- 3 个阶段：`idle`、`awaitingModel`、`awaitingTool`。
- 5 种输入：信件、模型结果、工具结果、停止、换配置（`reconfigure`）。换配置只改进程记录里的会话快照：不写进段，不唤醒进程（[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)）。
- 2 种副作用：调用模型、运行工具。
- 工具分两种。库内工具只碰库，在处理输入的事务里同步执行。例外：`spawn` 还读预设文件和它用到的工具定义文件，查工作目录（[D36](kb-decisions.md#d36-第-4-步第二部分进程之间的工具的执行和两处例外)）。库外工具碰外面的世界，由执行器执行。
- 进程的状态 = 进程记录 + 当前工作段。处理一条输入只读这两样。例外：`post`、`stop_process` 还读收件人的进程记录，`spawn` 还读预设文件和它用到的工具定义文件（[D36](kb-decisions.md#d36-第-4-步第二部分进程之间的工具的执行和两处例外)）；工具定义在结果里声明的同样动作，读的也一样（D64）；开段（建进程、换段被接受、`reconfigure` 直接采用）还读会话快照声明的上下文文件（[D72](kb-decisions.md#d72-上下文文件开段重读)）。

### 模型知道事情的三个入口

模型看到的只有 `buildContext(进程记录, 工作段)`：系统提示词、工具描述、工作段的消息。工具描述来自会话快照，一段里不变。所以要让模型知道一件事，只有三个入口：

| 入口 | 什么时候定 | 适合放 |
|---|---|---|
| 系统提示词 | 开段时定下，整段不变 | 整段都成立的背景：预设提示词、工作目录、上下文文件的视图（开段时重读）、开段时的记忆快照 |
| `decide` 写进消息正文 | 处理某条输入时 | 发生过一次、要告诉模型一次的事，例如 D25 的“上一轮没有正常结束” |
| 工具结果 | 模型自己调用工具时 | 需要时才看的信息，例如 `self` 返回的投影 |

没有第四个入口。不在每次请求时换系统提示词，也不改写工作段里已有的消息。唯一的例外：请求里的旧图成批省略，换成一行说明，库里的段不变（[D40](kb-decisions.md#d40-第-6-步前一半的选择)）。

### 人看到什么

- 投影：`observe` 算出，CLI 的 `tau ps` 和 Agent 的 `self` 看同一份。
- 最终回复：一轮结束时给等着的连接。
- 流式文本：只给正在看的观察者，不是状态，不进库。

### 崩溃时

见上面的[状态分三层](#状态分三层)。库里的原样恢复。正在跑的库外副作用作为“被中断”送回，不自动重做。观察者重连后重新拉取投影。

### 从零重建只需要四样东西

1. 纯函数 `decide` 和 `effectOf`。
2. 一个信箱，加上“一条输入一个事务”。
3. 一个只会开始、中止、催、上报的执行器。
4. 一个纯函数 `observe`。

## 投影与命令

投影的内容见[设计稿第 9 节](../docs/design/mvp.md#9-自省)，字段见 [kb-kernel.md](kb-kernel.md#投影与命令)。

## 入口

| 路径 | 内容 | 细节 |
|---|---|---|
| `src/main.ts` | `tau serve` 启动服务；其余命令交给 CLI | [kb-service.md](kb-service.md#启动脚本和入口) |
| `src/server/serve.ts` | 把库、执行器和管道装配起来；`pump` 处理信箱、开始副作用 | [kb-service.md](kb-service.md) |
| `src/server/listen.ts` | 在命名管道上监听，监听成功就是单实例锁 | [kb-service.md](kb-service.md) |
| `src/server/credentials.ts` | tau 自己的凭据文件 `~/.tau/auth.json`，可读可写，交给模型目录 | [kb-service.md](kb-service.md#启动脚本和入口) |
| `src/cli/main.ts`、`src/protocol.ts` | 命令行和线协议；CLI 只依赖协议 | [kb-service.md](kb-service.md) |
| `src/kernel/` | 纯函数：`decide`、`effectOf`、`observe`、`buildContext`、派生值、工具描述、会话快照的比较（`snapshot.ts`） | [kb-kernel.md](kb-kernel.md) |
| `src/store/` | 表、处理输入的事务、库内工具、读上下文文件拼开段视图（`context-files.ts`） | [kb-store.md](kb-store.md) |
| `src/executor/` | 库外副作用的开始、中止、催、上报，启动恢复 | [kb-executor.md](kb-executor.md) |
| `src/memory/kv.ts` | `Memory` 接口的 SQLite 实现 | [kb-memory.md](kb-memory.md) |
| `src/tools/` | `read`、`write`、`edit`、`bash` | [kb-tools.md](kb-tools.md) |
| `src/presets/load.ts` | 读预设文件，生成快照；`reconfigure` 造新快照也走它（`buildPreset`、`presetFields`、`reconfigured`） | [设计稿第 2 节](../docs/design/mvp.md#2-预设)、[kb-service](kb-service.md#会话配置reconfigure) |
测试在 `test/`，按模块分目录；执行器的测试在 `test/store/`。命令：`npm test`、`npm run typecheck`、`npm run loc`。完成门槛见 AGENTS.md，当前进度见[执行清单](../docs/plan/kernel-v2-checklist.md)。

## 坑点

这些错误不容易从规则本身看出来：

- 把 Agent 当成运行时对象：并行和记忆归属会乱。Agent 只是预设的 ID。
- 崩溃后猜测外部世界：未知就报告未知，让模型决定下一步。
- 用摘要压缩“修好”长上下文：用换段。
- 加一个“很便宜”的机制：每个都便宜，加起来就不便宜。先问 YAGNI。

## 关联模块

- [kb-kernel.md](kb-kernel.md)、[kb-store.md](kb-store.md)、[kb-executor.md](kb-executor.md)、[kb-memory.md](kb-memory.md)、[kb-tools.md](kb-tools.md)、[kb-service.md](kb-service.md)
- [kb-decisions.md](kb-decisions.md)
- [kb-piweb-lessons.md](kb-piweb-lessons.md)
