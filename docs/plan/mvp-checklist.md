# tau MVP 执行清单

`updated: 2026-11-15` · **当前：第 0 步，未开始**

按顺序做。每一步结束时，测试全部通过，后面的步骤建立在一个已经被测试保护住的内核上。设计细节见[设计稿](../design/mvp.md)。

## 每一步都要做的收尾

1. 运行完成门槛：`npm test`、`npm run typecheck`、`git diff --check`。
2. 运行 `npm run loc`，检查代码量预算。
3. 勾选本清单，更新顶部的“当前”。
4. 为这一步实现的模块新建或更新 kb 页，同步 `.knowledge/INDEX.md`，把设计稿里对应的章节改成链接。
5. 这一步定下的“待定”项，写进[决策记录](../../.knowledge/kb-decisions.md)，并从设计稿的待定表里删除。
6. 对照设计稿的 [MVP 不做](../design/mvp.md#mvp-不做)，确认没有顺手加进不在范围内的东西。

## 第 0 步：仓库骨架

- [ ] `package.json`：`"type": "module"`，`engines.node >= 24`，`@earendil-works/pi-ai` 精确锁定 `1.0.0`，开发依赖只有 `typescript`。
- [ ] `tsconfig.json`：strict 全开，`noEmit`，`erasableSyntaxOnly`，`allowImportingTsExtensions`。
- [ ] 脚本：`test`（`node --test`）、`typecheck`（`tsc`）、`loc`（统计 `src/` 中不含测试的行数）。
- [ ] 一个测试：扫描 `src/kernel/` 的 import 语句，只允许 kernel 内部的相对路径和 `import type`。
- [ ] `.gitignore`：`node_modules/`。
- [ ] `.gitattributes`：统一用 LF。

**验收**

- 三个门槛命令都能运行。
- 在 `src/kernel/` 放一个导入 `node:fs` 的文件，import 扫描测试失败；验证后删除这个文件。

## 第 1 步：内核（没有 I/O）

- [ ] 类型：`Process`、`Phase`、`Input`、`EffectResult`、`Emit`、`Effect`。
- [ ] `decide` 覆盖这些流程：普通一轮、工具顺序执行、运行中收到的消息排队、停止（补“已中止”的工具结果，丢弃迟到的结果）、步数上限、换段、错误和 `interrupted`。
- [ ] `observe`。
- [ ] `buildContext`：预设快照 + 记忆视图 + 工作段消息 → 模型请求。
- [ ] 不变量检查函数 `assertInvariants`：
  - 每个工具调用恰好有一个结果；
  - 工具调用和它的结果之间没有别的消息；
  - 每种阶段各自的约束成立。
- [ ] 内存版运行器：内存信箱，模拟“一条输入一个事务”，假执行器（按脚本返回结果），假时钟。
- [ ] 每个流程都有测试。
- [ ] 随机序列测试：用带种子的随机数生成输入和结果的交错顺序，每一步之后调用 `assertInvariants`。随机数生成器自己写，不加依赖。
- [ ] 长跑测试：很多轮对话，周期性换段。断言进程状态的大小和当前工作段的大小都有上界。

**验收**

- import 扫描测试证明 `src/kernel/` 没有 I/O。
- 所有 `switch` 都用 `never` 做了穷尽检查。
- 随机序列测试用多个种子运行，不变量都成立。

**收尾**：新建 `kb-kernel.md`。

## 第 2 步：持久化与执行器

- [ ] 核实 SQLite 驱动：`better-sqlite3` 在 Windows 和 Node 24 上能安装，同步 API 和 WAL 正常。装不上就改用 `node:sqlite`，记入决策。
- [ ] 6 张表；`PRAGMA user_version` 不一致就拒绝启动。
- [ ] 处理输入的事务：读出进程和输入 → `decide` → 写回进程 → 删除输入 → 写入全部 `emits`。
- [ ] 执行器：`pending` → `running` → 写回结果；库内副作用在一个事务里完成；取消开关表。
- [ ] 启动恢复：`running` 的库外副作用作为 `interrupted` 送回。
- [ ] 单实例锁。
- [ ] `tau backup`（`VACUUM INTO`）。
- [ ] 崩溃注入测试：在每个事务边界，以及“标记 running 之后、开始动作之前”“开始动作之后、写回结果之前”这两个窗口注入崩溃。重启后断言：
  - 没有输入丢失，也没有输入被处理两次；
  - 每个库外副作用要么完成，要么作为 `interrupted` 送回；
  - `assertInvariants` 成立。

**验收**：崩溃注入测试覆盖设计稿第 6 节列出的每一个窗口。

**收尾**：新建 `kb-store.md` 和 `kb-executor.md`。

## 第 3 步：接上真模型，跑通

- [ ] 核实 `pi-ai` 的消息格式，定下 `segment_messages` 的存储格式。
- [ ] 核实“工作段以工具结果结尾，下一条是用户消息”这种形状，pi-ai 能否正确转换给各家模型。不行就在结束本轮时补一条固定的助手回复。
- [ ] 认证：核实能否复用 `pi-ai` 的凭据存储（和 Pi 共用登录信息）；不能就先用环境变量里的 API Key。
- [ ] 模型适配：`createModels()` 加 `streamSimple`，接成 `callModel` 副作用；流式文本转发给观察者；`usage` 更新上下文用量；`calculateCost` 累加花费。
- [ ] 4 个工具：`read`、`write`、`edit`、`bash`。定下 Windows 上 bash 用哪个 shell。
- [ ] 工具结果的字节上限，超出时保留头尾。
- [ ] 预设读取：5 个字段的前置信息，未知字段报错。
- [ ] CLI（进程内）：`tau start <预设> "消息"`，运行到本轮结束，打印流式文本。

**验收**

- 用 faux 假模型跑通“读一个文件、改一行、跑一次命令”的测试。
- 用真模型手动完成同样的任务。
- 工具调用配对有专门的测试：多个工具调用、中途停止、中途崩溃。

**收尾**：新建 `kb-tools.md`，更新 `kb-executor.md`。

## 第 4 步：换段与记忆

- [ ] 上下文用量：调用后取实测值，之后写入的消息按字节估算。
- [ ] 换段完整接入存储：关闭旧段、开新段、生成记忆视图。
- [ ] 记忆的键值实现、`memory_get`、`memory_set`、`memory_delete`、视图。
- [ ] 定换段阈值、记忆的各项上限和视图预算。

**验收**

- 一个进程经过 20 次换段后，打开它时从库里读取的行数，和只有 1 段时相同。用读取行数衡量，不用耗时衡量。
- 两个进程同时写同一个键：后写的那个得到冲突和最新值，重试后成功。

**收尾**：新建 `kb-memory.md`。

## 第 5 步：自省、守护进程与 CLI

- [ ] `observe` 的数据收集，`self` 工具。
- [ ] `tau serve`：命名管道上的 HTTP；`POST /commands`、`GET /events`（SSE）。
- [ ] CLI：`serve`、`start`、`send`、`chat`、`ps`、`stop`、`backup`，改为调用守护进程。

**验收**

- 用 CLI 同时运行两个进程，一个用全局助手预设，一个用 `memory: false` 的预设。
- `self` 能显示上下文用量、时间、花费和兄弟进程；`tau ps` 显示的内容和它一致。
- 在守护进程运行中随机杀掉它几次，重启后 `assertInvariants` 成立，没有遗留的 `running` 副作用。
- 手动走一遍：启动全局助手 → 对话 → 再启动一个临时进程 → 两个同时运行 → 停止其中一个。

**收尾**：新建 `kb-service.md`，更新 `kb-overview.md` 的入口。

## MVP 完成标准

设计稿第 1 节的每个目标，都在某一步得到验证：

| 目标 | 在哪里验证 |
|---|---|
| 1. 在命令行里和全局助手对话 | 第 3 步（进程内），第 5 步（守护进程） |
| 2. 多个进程同时运行 | 第 5 步 |
| 3. 启动不带记忆的临时进程 | 第 5 步 |
| 4. 并行写同一个键时冲突重试 | 第 4 步 |
| 5. 多次换段后打开的读取量不变 | 第 4 步 |
| 6. Agent 能用 `self` 看到自己 | 第 5 步 |
| 7. 任意副作用边界崩溃后状态正确 | 第 2 步，第 5 步 |
| 8. 步数用完就结束本轮 | 第 1 步 |
