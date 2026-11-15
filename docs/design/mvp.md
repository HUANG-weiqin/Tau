# tau MVP 设计稿

`status: 草稿` · `updated: 2026-11-15`

本稿负责还没有模块页的模块细节：目标、预设、总体结构、记忆、自省、工具、服务与 CLI，以及“MVP 不做”清单和风险。第 4 到 7 节的细节已经交给 [kb-kernel](../../.knowledge/kb-kernel.md)、[kb-store](../../.knowledge/kb-store.md) 和 [kb-executor](../../.knowledge/kb-executor.md)，这里只留链接。规则的摘要在 [AGENTS.md](../../AGENTS.md)，理由和核实证据在[决策记录](../../.knowledge/kb-decisions.md)，构建顺序在[执行清单](../plan/mvp-checklist.md)。

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
  store/       SQLite：表、处理输入的事务、库内工具
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
- `memory` 只依赖 `kernel`。`store` 依赖 `kernel`，通过 `kernel` 里的 `Memory` 接口类型使用记忆，实现由 `server` 传入。`executor` 依赖 `kernel`、`store`（`tx` 和行的读写）、`tools` 和 `pi-ai`。`server` 把它们装配起来。`cli` 只依赖 `protocol.ts`。
- SQL 不只在 `store/`：`memory/kv.ts` 读写 `memory` 表，`executor` 读写 `effects` 表，`server` 查一次 `mailbox`。
- 依赖和工具链见 AGENTS.md 的“小而硬规矩”。

## 4. 内核

### 4.1 进程

进程记录、阶段和派生值的细节在 [kb-kernel.md](../../.knowledge/kb-kernel.md#状态)。

### 4.2 输入

输入的类型和丢弃规则在 [kb-kernel.md](../../.knowledge/kb-kernel.md#输入副作用环境)。

### 4.3 函数

`start`、`decide`、`effectOf`、`buildContext`、`observe` 的签名和约定在 [kb-kernel.md](../../.knowledge/kb-kernel.md#函数)。

### 4.4 处理一条输入

处理一条输入的事务、待办副作用表的同步、库内副作用的执行，都在 [kb-store.md](../../.knowledge/kb-store.md#处理一条输入)。启动进程的事务也在那一页。

## 5. 流程

### 5.1 两个辅助步骤

`continueTurn` 和 `endTurn` 在 [kb-kernel.md](../../.knowledge/kb-kernel.md#流程两个辅助步骤)。

### 5.2 每种输入

每种输入的处理在 [kb-kernel.md](../../.knowledge/kb-kernel.md#流程每种输入)。

### 5.3 模型回复

按 `stopReason` 处理模型回复的规则在 [kb-kernel.md](../../.knowledge/kb-kernel.md#流程模型回复用途-turn)。

### 5.4 换段

换段的步骤和失败时的处理在 [kb-kernel.md](../../.knowledge/kb-kernel.md#流程换段)。

## 6. 执行器与崩溃

待办副作用表的一行怎样开始、完成、中止和启动恢复，以及崩溃注入测试要覆盖什么，都在 [kb-executor.md](../../.knowledge/kb-executor.md)。bash 怎样结束进程树见[第 10 节](#10-工具)。

## 7. 存储

### 7.1 位置

`~/.tau/` 下有哪些文件、怎样备份，见 [kb-store.md](../../.knowledge/kb-store.md#位置)。

### 7.2 表

表结构、PRAGMA 和表结构版本在 [kb-store.md](../../.knowledge/kb-store.md#表)。

### 7.3 为什么处理输入不会随时间变慢

处理一条输入读什么、为什么不随时间变慢，见 [kb-store.md](../../.knowledge/kb-store.md#为什么处理输入不会随时间变慢)。

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
- 工具：`memory_get`、`memory_set`、`memory_delete`。视图是开段时的快照；要拿到现在的值和版本号，用 `memory_get`。参数和结果的写法见 [kb-store.md](../../.knowledge/kb-store.md#记忆工具)。
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

- `self` 是库内副作用，结果和其它工具一样受工具结果的字节上限约束。投影的字段见 [kb-kernel.md](../../.knowledge/kb-kernel.md#投影与命令)，`self` 的文字格式见 [kb-store.md](../../.knowledge/kb-store.md#self)。
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
| 连续多条用户消息：模型出错后你再发消息，或者交接指令接在用户消息后面。有些模型要求用户和助手交替出现（工具结果后面接用户消息的情况，pi-ai 已经处理） | 已核实 pi-ai 的转换原样传过连续的用户消息（D10）；各家模型接不接受，第 3 步用真模型核实；不行再定办法 |
| 自己写循环，要处理工具调用配对、提示缓存和各家模型的差异 | 消息直接用 pi-ai 的格式；配对规则有专门的测试 |
| 换段的质量取决于模型写交接说明的能力，包括能否原样引用最后一条用户消息 | 测试只能验证机制；质量要靠真实使用观察 |
| 普通回复 `length` 截断时，整条回复被丢弃 | 观察实际频率；需要时再定更细的处理 |
| 进程永不删除。`tau ps` 要为每个进程读当前段，`self` 要读全部进程记录，都会随年头变慢 | 先接受；需要时再定 |
| 服务崩溃后，bash 启动的子孙进程可能继续运行，而工具结果写的是“结果未知” | 第 3 步核实；先接受这个风险 |
| `node:sqlite` 仍是实验 API，几年内可能变化 | 只用最基本的同步 API；变化时改 `store/`、`memory/kv.ts`，以及执行器和服务里直接写的 SQL（第 3 节） |
| 没有沙箱 | 见 D7；不拦，但能发现、能撤销 |
