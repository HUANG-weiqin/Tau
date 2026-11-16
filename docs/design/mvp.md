# tau MVP 设计稿

`status: 草稿` · `updated: 2026-11-16`

本稿负责还没有模块页的模块细节：目标、预设、总体结构、自省，以及“MVP 不做”清单和风险。第 4 到 8 节、第 10 节和第 11 节的细节已经交给 [kb-kernel](../../.knowledge/kb-kernel.md)、[kb-store](../../.knowledge/kb-store.md)、[kb-executor](../../.knowledge/kb-executor.md)、[kb-memory](../../.knowledge/kb-memory.md)、[kb-tools](../../.knowledge/kb-tools.md) 和 [kb-service](../../.knowledge/kb-service.md)，这里只留链接。规则的摘要在 [AGENTS.md](../../AGENTS.md)，理由和核实证据在[决策记录](../../.knowledge/kb-decisions.md)，构建顺序在[执行清单](../plan/mvp-checklist.md)。

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

- 前置信息有 `workdir`、`model`、`tools` 和可选的 `thinking`、`handoff`，每行一个 `key: value`。`thinking` 只收 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`（pi-ai 的思考级别）；不写就不传给模型，值不对就报错。怎么用见 [kb-executor](../../.knowledge/kb-executor.md#调用模型actionsts)。
- `handoff` 是正整数，单位 token：把换段阈值调低到它。写得比算出的阈值大就等于没写；不写就用算出的阈值；不是正整数就报错。怎么用见 [kb-kernel 的换段阈值](../../.knowledge/kb-kernel.md#换段阈值)。
- `tools` 里除了内置工具和工具组，还能写工具定义的名字（`~/.tau/tools/<name>.json`，格式见 [kb-tools](../../.knowledge/kb-tools.md#工具定义)）。
- `tools` 里的 `memory` 表示进程有记忆库。`agents` 表示进程能给别的进程寄信、建进程、停进程（`post`、`spawn`、`stop_process`，[kb-store](../../.knowledge/kb-store.md#进程之间的工具)）。
- 进程启动时，预设被冻结成快照存进进程记录，用到的工具定义也一起冻结（快照的 `toolDefs`）。之后修改预设文件或工具定义文件，只影响新启动的进程。
- 快照里还有两项：从 pi-ai 模型目录查到的这个模型的 `contextWindow` 和 `input`（模型能收的输入）。查不到就启动失败。冻结它们，是为了让 `decide` 不做 I/O。预设写了的 `thinking`、`handoff` 也冻结进快照。调用模型时，执行器仍从模型目录取模型（第 6 节）。

读取预设（`src/presets/load.ts`）的规则：

- 预设 ID 必须和 `presets/` 里的一个文件名（去掉 `.md`）完全相同，大小写也要相同，8.3 短名也不行。理由见 [D20](../../.knowledge/kb-decisions.md#d20-实现第-0-到-2-步时定下的事)。
- 预设 ID 为空，或者含 `/`、`\`、`:`、`..` 时，拒绝。
- 文件开头的 UTF-8 BOM 被忽略。行尾可以是 LF，也可以是 CRLF。
- 第一行必须是 `---`。前置信息到下一行 `---` 为止。
- 每行在第一个 `:` 处拆成键和值，两边去掉空白。空行跳过。
- 没有 `:` 的行、未知字段、重复字段、缺少的字段，都报错。`thinking` 和 `handoff` 可以不写，其余字段缺了报错。
- `workdir` 必须是绝对路径，而且是一个存在的目录。绝对路径只认两种：盘符开头（`E:/x`、`E:\x`）和 UNC（`\\server\share`）。不带盘符的 `/foo` 会落在服务当前目录所在的盘上，所以拒绝。
- `model` 在第一个 `/` 处拆成 provider 和模型 ID，两边都不能为空。模型 ID 里可以再有 `/`。
- `tools` 按逗号拆开，去掉空白，跳过空项。不是内置工具和工具组的名字，都按工具定义读，读不出就报错（找不到、格式不对、重名、超过大小上限）。重复的去掉，保留第一次出现的顺序。
- `tools` 可以为空。这时进程只有 `self` 和 `handoff`。
- 第二个 `---` 之后的正文去掉首尾空白，就是角色提示词。它可以为空。
- 任何一条不满足，启动就失败，库里什么都不写。工具定义读不出和启动检查（[kb-kernel](../../.knowledge/kb-kernel.md#启动检查和交接以后的检查)）不通过也一样（[kb-service](../../.knowledge/kb-service.md#请求的校验parserequest)）。

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
- 工具描述是 `kernel` 里的纯数据：名称、说明、参数，以及它是库内还是库外的副作用。库外工具的实现在 `tools/`。（工具定义的名称、说明和参数来自快照里冻结的文件，读文件在 `presets/tooldefs.ts`，不在 `kernel`。）
- `memory` 只依赖 `kernel`。`store` 依赖 `kernel`，通过 `kernel` 里的 `Memory` 接口类型使用记忆，实现由 `server` 传入。`executor` 依赖 `kernel`、`store`（`tx` 和行的读写）、`tools` 和 `pi-ai`。`server` 把它们装配起来。`cli` 只依赖 `protocol.ts`。
- SQL 不只在 `store/`：`memory/kv.ts` 读写 `memory` 表，`executor` 读写 `effects` 表、插入 `blobs` 表，`server` 查一次 `mailbox`。
- 依赖和工具链见 AGENTS.md 的“小而硬规矩”。

## 4. 纯函数层

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

待办副作用表的一行怎样开始、完成、中止和启动恢复，以及崩溃注入测试要覆盖什么，都在 [kb-executor.md](../../.knowledge/kb-executor.md)。bash 超时或中止时怎样结束进程，见 [kb-tools.md](../../.knowledge/kb-tools.md#结束进程)。

## 7. 存储

### 7.1 位置

`~/.tau/` 下有哪些文件、怎样备份，见 [kb-store.md](../../.knowledge/kb-store.md#位置)。

### 7.2 表

表结构、PRAGMA 和表结构版本在 [kb-store.md](../../.knowledge/kb-store.md#表)。

### 7.3 为什么处理输入不会随时间变慢

处理一条输入读什么、为什么不随时间变慢，见 [kb-store.md](../../.knowledge/kb-store.md#为什么处理输入不会随时间变慢)。

## 8. 记忆

### 8.1 接口

`Memory` 接口的类型、语义和契约在 [kb-memory.md](../../.knowledge/kb-memory.md#接口)。

### 8.2 规则

谁有记忆库、三个上限和检查顺序、视图的格式、版本号的规则，在 [kb-memory.md](../../.knowledge/kb-memory.md)。记忆工具的参数和结果在 [kb-store.md](../../.knowledge/kb-store.md#记忆工具)。

长期方向（挂载、日志、整理）见[决策记录](../../.knowledge/kb-decisions.md#d6-mvp-的记忆是带版本号的键值存储)。

## 9. 自省

`observe` 是纯函数。`self` 工具和 CLI 的 `tau ps` 用的是同一个函数。

| 范围 | 内容 |
|---|---|
| 自己 | 进程 ID、预设 ID、模型、父进程、阶段（运行中含本轮步数和排队消息数；`idle` 含上一轮的结束原因，出错的原因截短）、第几段、本段开始多久、当前段的消息条数、上下文已用和窗口、累计用量 |
| 时间 | 现在的时间和时区、进程运行多久 |
| 兄弟 | 同一个预设下不处于 `idle` 的其他进程：ID、阶段、运行多久 |
| 子进程 | 运行中的各一份，同兄弟；空闲的只给个数 |

- `self` 是库内副作用，结果和其它工具一样受工具结果的字节上限约束。投影的字段见 [kb-kernel.md](../../.knowledge/kb-kernel.md#投影与命令)，`self` 的文字格式见 [kb-store.md](../../.knowledge/kb-store.md#self)。
- `self` 只读，这是接口的范围，不是权限边界：有 bash 的进程可以直接运行 `tau` 命令。

## 10. 工具

`read`、`write`、`edit`、`bash` 的参数、行为、结果文本，以及路径和编码的规则，在 [kb-tools.md](../../.knowledge/kb-tools.md)。哪个预设有哪些工具、给模型看的描述在 [kb-kernel.md](../../.knowledge/kb-kernel.md#工具描述)。工具结果和 `decide` 写入的用户消息共用的字节上限在 [kb-kernel.md](../../.knowledge/kb-kernel.md#常量)。`memory_*` 和 `self` 的参数和结果在 [kb-store.md](../../.knowledge/kb-store.md#投影与命令)。

## 11. 服务与 CLI

服务、线协议和 CLI 的细节在 [kb-service.md](../../.knowledge/kb-service.md)：命名管道和锁、启动顺序、回执、流式文本和最终回复、“结果未知”、CLI 的命令和退出码、`tau ps` 的文字格式。

## MVP 不做

这些已被移出 MVP。要做其中任何一项，先改本稿和执行清单。理由见 D14、D18 和 D19。以后接在哪里，见 [kb-extending](../../.knowledge/kb-extending.md)。

v2 的设计（[kernel-v2](kernel-v2.md)，已冻结，细节在 kb 页）改了其中几项的去向：

- 移出“不做”，v2 要做：派生和进程之间互发消息、Agent 的控制命令（立即换段）、运行中插话、图片输入、累计用量（取代花费统计）、自动重试（交给 pi-ai）。见 [kb-contract 的原语和它在内核的理由](../../.knowledge/kb-contract.md#原语和它在内核的理由)。
- 改成“上层做”，不进内核：Web UI、HTTP、远程访问、grep 工具、扩展（不做宿主）、桌面截图、多设备、通知、MCP。做法见 [kb-extras](../../.knowledge/kb-extras.md)。
- 仍然不做：定时器、审批、推送状态行、LSP。理由见 [D46](../../.knowledge/kb-decisions.md#d46-v2-也不做的)。

**自主和控制**

- 定时器、自我唤醒。
- 推送状态行。

**记忆**

- 一个进程挂载多个库、运行中挂载、库的标题和简介。
- 日志。MVP 不删旧工作段，原始对话本来就在库里。
- 记忆的整理、遗忘、分层；把记忆变化通知兄弟进程。

**交互**

- `tau chat`、`tau backup`。

**统计、上限和存储**

- 花费上限、并发上限、全局停止、每个预设单独的步数上限。
- `self` 里的记忆统计、“距你上次说话多久”。
- 表结构迁移、项目表、删除旧工作段。

**其它**

- Windows 以外的平台。
- 路径限制。
- LSP、沙箱、多用户。
- 审批、密钥检测、彻底删除、导入 Pi Web 的数据。
- MCP。

## 风险

| 风险 | 应对 |
|---|---|
| 重写时重新长出同样的复杂度 | 准入规则；YAGNI；同一个事实只有一个来源；代码量预算 |
| 连续多条用户消息：模型出错或本轮被停止后你再发消息；换段循环里段只剩第一条用户消息时，交接指令接在它后面（段末其它用户消息不进交接请求）；工具结果后面接用户消息。有些模型要求用户和助手交替出现 | pi-ai 原样传过连续的用户消息（D10），对“工具结果后接用户消息”也没有通用的处理。已在 opencode-go/deepseek-v4.1-flash（openai-completions）上核实（[D24](../../.knowledge/kb-decisions.md#d24-真模型验收)）。换 API 或 provider 时再核实，不行再定办法 |
| 停止或模型失败后，段里不写回复，也不写标记。模型下一轮可能把没做完的请求当成还要做的事 | 停止：已处理。下一条用户消息前面加一句说明（[D25](../../.knowledge/kb-decisions.md#d25-上一轮没有正常结束时下一条消息加说明)）。真模型复测时，停止后发无关的消息，模型不再做被停的请求。说“继续”时照常继续。出错和步数用完：说明只陈述事实，模型仍可能接着做。这是有意的，没量过 |
| 自己写循环，要处理工具调用配对、提示缓存和各家模型的差异 | 消息直接用 pi-ai 的格式；配对规则有专门的测试 |
| 换段的质量取决于模型写交接说明的能力。段末还没处理的用户消息原样带到新段，但模型写说明时看不到它们 | 测试只能验证机制；质量要靠真实使用观察。真模型还没换过一次段：1M 窗口要用到约 73 万 token |
| 用量估算假设真实分词至少 2 字节一个 token。只在 deepseek-v4.1-flash 上量过，常见文本都高于 2，最低的是十六进制和 base64，约 1.4（[D24](../../.knowledge/kb-decisions.md#d24-真模型验收)）。别家的分词器没量：设计时估计 Claude 4.7 以后中文约 2.0 到 2.2；字节级分词最低是 1。低于 2 的内容会被少算：一个 32 KiB 的 hex 或 base64 结果少算约 6.7K token，超过余量 3,862。误差在两次真实用量之间按字节累加，最多累加到阈值再加一个结果。超过窗口时，同一个请求每次重试都同样失败 | 先接受。交接调用仍要留出整个输出上限，能盖住误差的只有上一条回复没用完的输出，再加余量 3,862。1M 窗口的 deepseek-v4.1-flash 上，一次回复的工具调用要读回约 630 KB 这样的内容才会超；64K 窗口上两个满 32 KiB 的 base64 结果就可能超。用到别的 provider 时，照 D24 的量法再量。真超过时只能开新进程。理由见 [D22](../../.knowledge/kb-decisions.md#d22-换段阈值用量估算和记忆上限) |
| 一次回复的输出上限是窗口的 1/8：200K 的 Claude 从 64K 降到 25K，64K 窗口只有 8K。大的 `write`、长推理会以“输出被截断”结束；不能关推理的模型可能交出空的交接说明 | 先接受，观察“输出被截断”的频率。空的交接说明算交接失败，再发一条消息就重试（[kb-kernel](../../.knowledge/kb-kernel.md#流程换段)） |
| 模型目录里窗口写 400K 的 GPT-5 系列条目（多个 provider）：窗口含输出，输入上限约 272K。换段阈值 279,520 和交接请求的上界 346,138 都超过它 | 没核实：现在不用 400K 的条目，用到时再核实。属实就在读取预设时修正窗口，记进决策，纯函数层不变。在用的 deepseek-v4.1-flash 的 1M 窗口是不是真实的输入上限，也没核实 |
| 小窗口：阈值不大于 0，或固定部分加记忆到阈值；64K 窗口给预设提示词只留几 KB | 启动检查挡住这些预设（`start` 和 `spawn`）。差得不远的由交接以后的检查兜住。界线见 [kb-kernel 的坑点](../../.knowledge/kb-kernel.md#坑点) |
| 一次回复的工具调用很多：补的“未执行”结果放不进余量，交接请求可能超过窗口 | 已处理：这样的回复不写入，本轮以“一次回复的工具调用太多”结束。能带多少个调用取决于 ID 的长度（[kb-kernel](../../.knowledge/kb-kernel.md#流程模型回复用途-turn)） |
| 普通回复 `length` 截断时，整条回复被丢弃 | 观察实际频率；需要时再定更细的处理 |
| 进程永不删除。`tau ps` 要为每个进程读当前段，`self` 要读全部进程记录，都会随年头变慢 | 先接受；需要时再定 |
| 服务崩溃或正常退出后，bash 和它启动的子孙进程继续运行，而工具结果写的是“被中断，结果未知” | 先接受。第 3 步手动核实过，没有代码清理它们，也没有测试（[kb-tools 的坑点](../../.knowledge/kb-tools.md#坑点)）。超时或中止时怎样结束进程、会漏掉什么，见 [kb-tools](../../.knowledge/kb-tools.md#结束进程) |
| `node:sqlite` 还不是稳定 API，几年内可能变化 | 只用最基本的同步 API；变化时改 `store/`、`memory/kv.ts`，以及执行器和服务里直接写的 SQL（第 3 节） |
| 没有沙箱 | 见 D7；不拦，但能发现、能撤销 |
