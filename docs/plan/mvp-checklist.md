# tau MVP 执行清单

`updated: 2026-11-15` · **当前：第 5 步**（第 3、4 步还有用真模型核实的项）

按顺序做。每一步结束时，测试全部通过。设计细节见[设计稿](../design/mvp.md)，本清单只列任务和验收，不复述设计。

## 每一步都要做的收尾

1. 运行完成门槛：`npm test`、`npm run typecheck`、`git diff --check`。
2. 运行 `npm run loc`，检查代码量预算。
3. 勾选本清单，更新顶部的“当前”。
4. 为这一步实现的模块新建或更新 kb 页，同步 `.knowledge/INDEX.md`，把设计稿里对应的章节改成链接。
5. 这一步定下的选择写进[决策记录](../../.knowledge/kb-decisions.md)，并删掉设计稿里对应的“第 N 步定”。
6. 对照设计稿的 [MVP 不做](../design/mvp.md#mvp-不做)，确认没有顺手加进范围外的东西。

## 第 0 步：仓库骨架

- [x] `package.json`、`tsconfig.json`、`.gitignore`、`.gitattributes`（统一 LF），按 AGENTS.md 的“小而硬规矩”配置依赖和工具链。
- [x] 脚本：`test`、`typecheck`、`loc`（统计 `src/` 中不含测试的行数）。
- [x] 一个测试：扫描 `src/kernel/` 的 import 语句，只允许 kernel 内部的相对路径和 `import type`。

**验收**

- 三个门槛命令都能运行。
- 在 `src/kernel/` 放一个导入 `node:fs` 的文件，import 扫描测试失败；验证后删除这个文件。

## 第 1 步：内核（没有 I/O）

- [x] 第 4 节的类型、工具描述（含库内还是库外）、派生函数、`start`、`decide`（含 `continueTurn`、`endTurn`）、`effectOf`、`observe`、`buildContext`。
- [x] 不变量检查函数 `assertInvariants`：
  - 每条带工具调用的助手消息后面，紧跟它的工具结果，顺序相同，中间没有别的消息。`idle` 和 `awaitingModel` 时结果齐全；`awaitingTool` 时恰好从 `effectOf` 指的那个调用开始缺。
  - 每种阶段各自的约束成立。
- [x] 一个很小的测试辅助函数：把 `decide` 返回的进程记录和消息应用到内存里的数组上。
- [x] 第 5 节每一行流程都有测试，包括：
  - 换段失败后重试；交接调用也计步；交接回复 `length` 被接受，`toolUse` 算失败；
  - `stopReason` 的每种取值；`toolUse` 但没有工具调用；
  - 工具结果写入后用量到阈值：剩下的工具调用补“未执行”，然后换段；
  - 工具被中断时结束本轮。
- [x] 随机序列测试：用带种子的随机数生成输入的交错顺序，每一步之后调用 `assertInvariants`。随机数生成器自己写。
- [x] 长跑测试：很多轮对话，周期性换段。断言进程记录和当前段的大小都有上界。

**验收**

- import 扫描测试通过。
- 所有 `switch` 都用 `never` 做了穷尽检查。
- 随机序列测试用多个种子运行，不变量都成立。
- 一个测试证明换段不能无限循环：步数用完时一定结束本轮。
- 一条助手消息带很多工具调用、每个结果都很大时，工作段不超过窗口。

**收尾**：新建 `kb-kernel.md`。

## 第 2 步：存储与执行器

- [x] 第 7.2 节的 5 张表；`PRAGMA user_version` 不一致就拒绝启动。
- [x] 第 4.4 节处理输入的事务，包括同步待办副作用表和执行库内副作用。实际在这一步就做了真的 `self` 和 `memory_*`，建在 `Memory` 接口上，测试用假记忆库（[D20](../../.knowledge/kb-decisions.md#d20-实现第-0-到-2-步时定下的事)）。
- [x] 第 6 节的执行器。
- [x] 启动恢复。
- [x] `assertInvariants` 加上存储层的三条：
  - 进程在等库外副作用 n 时，“待办副作用表里有 n 这一行”和“信箱里有 n 的结果”恰好成立一个；
  - 进程在等库内副作用时，信箱里有它的结果；`idle` 时表里没有这个进程的行；
  - 每个进程在表里最多一行。
- [x] 单实例：在命名管道上监听；跨进程核实第二个监听会失败。
- [x] 崩溃注入测试：在第 6 节列出的每一个位置注入崩溃。重启后断言：
  - 没有输入丢失，也没有输入被处理两次；
  - 每个库外副作用要么完成，要么作为 `interrupted` 送回；
  - `assertInvariants` 成立。
- [x] 竞态测试：
  - 副作用还是 `pending` 时收到停止，执行器绝不会再开始它；
  - 副作用的结果还在信箱里排队时，先处理一条用户消息，副作用不会被再执行一次（库外和库内各测一次）。
- [x] 随机序列测试和长跑测试改为在真库（临时文件）上运行。

**验收**：崩溃注入测试覆盖第 6 节列出的每一个位置；竞态测试通过。

**收尾**：新建 `kb-store.md` 和 `kb-executor.md`。

## 第 3 步：真模型、工具、服务

- [x] 核实 pi-ai 的消息格式，定下 `segment_messages` 的存储格式（[D21](../../.knowledge/kb-decisions.md#d21-第-3-步定下的事)）。
- [ ] 核实连续多条用户消息（模型出错后再发消息、交接指令接在用户消息后面），pi-ai 能否正确转换给各家模型。
- [x] 认证：只读复用 pi 的凭据文件里的 `api_key` 条目，没有时用环境变量（[D23](../../.knowledge/kb-decisions.md#d23-凭据只读复用-pi-的凭据文件)）。
- [x] 模型适配：`builtinModels()`（`@earendil-works/pi-ai/providers/all`）的模型目录加 `streamSimple`；按模型 ID 从目录取模型，查不到就上报 `error`；流式文本转发给观察者；助手消息原样存进工作段。
- [x] 预设读取：3 个字段的前置信息，未知字段报错；启动时从模型目录查出 `contextWindow` 冻结进快照，查不到就启动失败。
- [x] 4 个工具：`read`、`write`、`edit`、`bash`。定下 bash 用哪个 shell（[D21](../../.knowledge/kb-decisions.md#d21-第-3-步定下的事)）。
- [x] 工具结果的字节上限，超出时保留头尾。
- [x] `tau serve`、`tau start` 和 `tau send`：第 11 节的 JSON 行协议。`send` 和 `start` 走同一条路径。

**验收**

- [x] 用 faux 假模型跑通“读一个文件、改一行、跑一次命令”的测试（`test/server/e2e.test.ts`）。
- [ ] 用真模型手动完成同样的任务。
- [x] 工具调用配对有专门的测试：多个工具调用、中途停止、中途崩溃（`test/server/pairing.test.ts`）。
- [x] bash 超时能结束它启动的孙进程（`test/tools/bash.test.ts`）。
- [x] 服务在回执之前断开时，CLI 提示“结果未知”（`test/server/e2e.test.ts`）。

**收尾**：新建 `kb-tools.md` 和 `kb-service.md`，更新 `kb-executor.md`。

## 第 4 步：换段与记忆

- [x] 上下文用量的派生函数接上真实的 `usage`；定按字节估算的系数（[D22](../../.knowledge/kb-decisions.md#d22-换段阈值用量估算和记忆上限)，`test/kernel/derive.test.ts`）。
- [x] 记忆的键值实现（`AUTOINCREMENT` 版本号）、`memory_get`、`memory_set`、`memory_delete`、视图；`Env.memoryView` 接上记忆实现（[kb-memory](../../.knowledge/kb-memory.md)，`test/memory/kv.test.ts`、`test/store/inputs.test.ts`）。
- [x] 定换段阈值、记忆的各项上限和视图预算（D22，`test/kernel/derive.test.ts`、`test/kernel/context.test.ts`）。
- [x] 补上换段阈值的空档：交接请求加交接说明放得进窗口（[kb-kernel](../../.knowledge/kb-kernel.md#换段阈值)，`test/kernel/acceptance.test.ts`）。

**验收**

- [x] 一个进程经过 20 次换段后，处理一条输入时从库里读取的行数，和只有 1 段时相同。用读取行数衡量，不用耗时衡量（`test/store/longrun.test.ts`：换段 20 次以上，最后一段每条输入的读取行数和第 2 段相同）。
- [x] 两个进程同时写同一个键：后写的那个得到冲突和最新值，重试后成功（`test/memory/kv.test.ts`）。
- [x] 库里还有别的键，被删的键持有最大的版本号：删掉再重建，拿着旧版本号写入一定失败（`test/memory/kv.test.ts`）。
- [x] 5 种窗口（65,536 到 1,000,000）下，主路径和三条角落路径（停止、步数用完、交接一直失败，之后再发大消息）的交接请求加交接说明都放得进窗口（`test/kernel/acceptance.test.ts`）。
- [x] 记忆的三个上限在边界上准确，被拒绝的写入不改库、不用掉版本号（`test/memory/kv.test.ts`）。
- [x] 调用模型时请求的输出上限是 `min(model.maxTokens, 窗口的 1/8)`，交接调用也一样（`test/store/executor.test.ts`）。
- [ ] 用真模型核实 2 字节一个 token 的估算：对用到的每家 provider，各发约 32 KiB 的中文文档、TS 代码、英文、JSON 日志，下一次回复的 `input + cacheRead + cacheWrite` 不超过上一次的用量加上中间消息的估算。
- [ ] 核实 GPT-5 的 400K 条目的输入上限是不是约 272K（[设计稿的风险](../design/mvp.md#风险)）。

**收尾**：新建 `kb-memory.md`。

## 第 5 步：自省与其余 CLI

- [x] `observe` 的数据收集，`self` 工具。`self` 已在第 2 步先写好（[kb-store](../../.knowledge/kb-store.md#self)），按验收核对过（`test/server/cli.test.ts`）。
- [x] `tau ps`、`tau stop`。代码已在第 3 步先写好（[kb-service](../../.knowledge/kb-service.md#clisrcclimaints)），按验收核对过（`test/server/cli.test.ts`）。

**验收**

- [x] 用 CLI 同时运行两个进程，一个用 `tools` 含 `memory` 的预设，一个用不含的（`test/server/cli.test.ts`，faux 模型）。
- [x] `self` 能显示上下文用量、时间和运行中的兄弟进程；`tau ps` 显示的内容和它一致（`test/server/cli.test.ts`）。
- [x] 在服务运行中随机杀掉它几次。每次重启后，恢复完成、执行器开始之前，没有 `running` 行，`assertInvariants` 成立（`test/server/kill.test.ts`）。
- [ ] 手动走一遍：用带记忆的预设启动进程 → 用 `send` 对话 → 再用不带记忆的预设启动一个进程 → 两个同时运行 → 停止其中一个。

**收尾**：更新 `kb-service.md` 和 `kb-overview.md` 的入口。

## MVP 完成标准

设计稿第 1 节的每个目标，都在某一步得到验证：

| 目标 | 在哪里验证 |
|---|---|
| 1. 用带记忆的预设启动进程并对话 | 第 4 步 |
| 2. 多个进程同时运行 | 第 5 步 |
| 3. 用不带记忆的预设启动进程 | 第 3 步 |
| 4. 并行写同一个键时冲突重试 | 第 4 步 |
| 5. 多次换段后处理输入的读取量不变 | 第 4 步 |
| 6. Agent 能用 `self` 看到自己 | 第 5 步 |
| 7. 任意副作用边界崩溃后状态正确 | 第 2 步，第 5 步 |
| 8. 步数用完就结束本轮 | 第 1 步 |
