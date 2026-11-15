# 存储

`updated: 2026-11-15`

## 这个模块是干什么的

存储是 `src/store/`：库里的全部状态，以及改动它们的事务。

它负责：

- `~/.tau/tau.db` 的位置、表结构和 PRAGMA。
- 三个事务：启动进程、收一条命令、处理一条输入。
- 处理输入时同步待办副作用表（`effects`）。
- 在事务里执行库内工具：`self` 和 `memory_*`。

它不负责：

- `decide`、`effectOf`、`observe` 的逻辑：[kb-kernel.md](kb-kernel.md)。
- 取 `pending` 行、标记 `running`、写回结果、启动恢复：[kb-executor.md](kb-executor.md)。
- 什么时候调用这些事务、回执：[kb-service.md](kb-service.md)。服务的 `pump` 怎样中止动作：[kb-executor.md](kb-executor.md#控制流)。
- `Memory` 接口的语义、记忆的上限、视图的格式：[kb-memory.md](kb-memory.md)。

本页接管[设计稿](../docs/design/mvp.md)第 4.4 节和第 7 节的细节。

## 架构

### 位置

```text
~/.tau/
  tau.db       预设以外的全部数据
  tau.db-wal   SQLite 的 WAL 文件
  tau.db-shm   SQLite 的 WAL 索引
  presets/     预设，纯文本，不在库里
```

- `tau serve` 先建出 `~/.tau/presets/`，再打开 `tau.db`（`src/main.ts`）。
- 项目目录里不写任何东西。
- 备份：停掉服务，复制整个 `~/.tau/`。

### 表

`src/store/db.ts` 的 `SCHEMA`：

```sql
CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
) STRICT;
CREATE TABLE segment_messages (
  process_id TEXT NOT NULL,
  segment_seq INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (process_id, segment_seq, seq)
) STRICT;
CREATE TABLE mailbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  process_id TEXT NOT NULL,
  input_json TEXT NOT NULL
) STRICT;
CREATE TABLE effects (
  process_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running'))
) STRICT;
CREATE TABLE memory (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (ns, key)
) STRICT;
```

| 表 | 一行是什么 | 谁写 |
|---|---|---|
| `processes` | 一个进程记录。`state_json` 是 `Process` 的 JSON | `startProcess` 插入，`handleNext` 整行更新 |
| `segment_messages` | 一条工作段消息。`message_json` 是 pi-ai 的消息，原样存 | `handleNext` 追加 |
| `mailbox` | 一条输入。`input_json` 是 `Input` 的 JSON | 见下 |
| `effects` | 进程正在等的库外副作用：编号 `n` 和状态 | `handleNext` 和执行器 |
| `memory` | 一个键现在的值 | `Memory` 的实现 `src/memory/kv.ts` |

- 段号从 1 开始。段内序号从 0 开始，每段重新计。
- 没有删除进程或旧段的代码。旧段一直留在库里。
- `mailbox.seq` 和 `memory.version` 用 `AUTOINCREMENT`：删掉的最大编号也不复用。
- 没有外键，也没有另加的索引。`segment_messages` 主键的前缀 `(process_id, segment_seq)` 就是定位当前段的索引。

信箱的写入方：

| 输入 | 谁放进信箱 |
|---|---|
| `userMessage` | `startProcess`、`send` |
| `stop` | `send` |
| 库内工具的结果、工具不存在的错误结果 | `handleNext` 的同步步骤 |
| 库外副作用的 `modelResult`、`toolResult` | 执行器完成动作时 |
| `interrupted` 结果 | 执行器的启动恢复 |

只有 `handleNext` 读出并删除信箱行。

`effects` 的一行由 `handleNext` 插入和删除（见[同步副作用](#同步副作用)），由执行器的三个事务开始、完成和恢复。一行的一生见 [kb-executor.md](kb-executor.md#一行的一生)。

### 打开库与事务

`openDb(path)`：

1. `PRAGMA journal_mode = WAL`。结果不是 `wal` 就关库并抛出。所以 `:memory:` 会被拒绝。
2. `PRAGMA synchronous = FULL`。回执承诺“写进库才返回”，所以每次提交都要落盘。这是连接级设置，每次打开都设。
3. 读 `PRAGMA user_version`：
   - 0 是新库：在一个事务里建 5 张表，并写入 `SCHEMA_VERSION`（现在是 1）。
   - 等于 `SCHEMA_VERSION`：直接用。
   - 其它值：关库并抛出，提示停掉服务、移走旧库、重启后重建。MVP 不做迁移。

`tx(db, f)`：`BEGIN IMMEDIATE`，执行 `f`，`COMMIT`。`f` 抛出时，如果库还开着并且还在事务里，就 `ROLLBACK`，再把错误抛出去。

行的读写函数都在 `db.ts`：`loadProcess`、`loadProcesses`（按 ID 排序）、`saveProcess`、`loadSegment`、`appendMessages`、`post`。它们不开事务。写入都由调用方放进 `tx`。

### 三个事务

都在 `src/store/inputs.ts`，每个函数恰好一个 `tx`。

| 函数 | 做什么 | 失败时 |
|---|---|---|
| `startProcess(db, memory, id, preset, text, now)` | 用 `start` 建 `idle` 进程记录并插入；第一条消息作为 `userMessage` 进信箱 | ID 重复：主键冲突，什么都不写 |
| `send(db, id, input)` | 把 `userMessage` 或 `stop` 放进已有进程的信箱 | 进程不存在：抛出“没有这个进程”，什么都不写 |
| `handleNext(db, memory, now)` | 处理信箱里最早的一条输入 | 抛出时整个事务回滚，这条输入留在队头 |

`Env` 怎样算：`now` 由调用方传入；预设 `tools` 含 `memory` 时，`memoryView` 是 `memory.view(preset.id)`，否则是空串，不碰记忆。

### 处理一条输入

`handleNext` 的步骤：

1. 取信箱里 `seq` 最小的一行。不分进程，取全局最早的。信箱空就返回 `null`。
2. 读这一行所属进程的进程记录。不存在就抛出。
3. 读当前段：`segment_seq` 等于记录里段号的全部消息，按 `seq` 排序。
4. 算 `Env`，调用 `decide(旧记录, 当前段, 输入, env)`，得到新记录和要追加的消息。
5. 写回进程记录。把追加的消息写进新记录的段：没换段时序号接着当前段，换段时从 0 开始。一次 `decide` 只写一段（[kb-kernel.md](kb-kernel.md)）。
6. 删除这条信箱行。
7. 同步副作用，见下一节。
8. 提交，返回 `{ process: 新记录, abort }`。

`abort` 不为 `null` 时，是这个事务删掉的 `running` 行的编号。调用方在提交之后中止执行器里的这个动作。

### 同步副作用

设 `before = effectOf(旧记录, 当前段)`，`after = effectOf(新记录, 新段)`。没换段时，新段是当前段加上追加的消息；换段时，新段就是追加的消息。

1. 两者编号相同，包括都没有：什么都不做。
2. 否则，`before` 存在时执行 `DELETE FROM effects WHERE process_id = ? AND n = ? RETURNING status`。删掉的行是 `running` 时，`abort = before.n`。
3. 再看 `after`：

| `after` | 做什么 |
|---|---|
| 没有 | 结束 |
| `callModel` | 插入一行 `pending` |
| `runTool`，库外工具 | 插入一行 `pending` |
| `runTool`，库内工具 | 在这个事务里执行，结果作为 `toolResult` 放进信箱 |
| `runTool`，不认识的工具或预设里没有的工具 | 把 `{ text: "工具 <name> 不存在，或者预设里没有它。", isError: true }` 作为 `toolResult` 放进信箱 |

- 库内还是库外，按进程快照里的预设判断：`findTool(p.preset, name)` 的 `inStore`。
- 事务里放进信箱的 `toolResult`，`status` 总是 `ok`，失败写在 `isError` 里。
- 库内副作用不进 `effects`，恰好执行一次。
- 事务只通过 `Memory` 接口访问记忆。`self` 的兄弟进程从 `processes` 表读出。

### 处理一条输入读什么

| 读什么 | 什么时候 |
|---|---|
| 信箱最早的一行 | 每次 |
| 这个进程的进程记录 | 每次 |
| 这个进程当前段的全部消息 | 每次 |
| 记忆视图 `memory.view(preset.id)` | 预设含 `memory` 时，每次 |
| 被删掉的 `effects` 行 | 在等的编号变了，并且 `before` 存在 |
| 一个记忆键 | 库内工具是 `memory_*` 时 |
| 全部进程记录 | 库内工具是 `self` 时 |

不读旧段，也不读别的进程的工作段。

### 为什么处理输入不会随时间变慢

- 当前段靠主键前缀 `(process_id, segment_seq)` 定位。旧段不加载，不校验。
- 当前段的大小被换段阈值限制住（[kb-kernel.md](kb-kernel.md)）。
- 信箱的行处理完就删。`effects` 每个进程最多一行，只在等库外副作用时存在。
- 记忆视图每条输入都读。它有上界：`set` 拒绝会让渲染后的视图超过上限的写入（[kb-memory.md](kb-memory.md#上限)）。
- 例外：`self` 读全部进程记录。进程永不删除，所以它和 `tau ps` 一样会随年头变慢（[设计稿的风险表](../docs/design/mvp.md#风险)）。

## 决策

跨模块的决定见 [kb-decisions.md](kb-decisions.md)：

- D4：一条输入一个事务。
- D8：一个用户级 SQLite，项目目录里不写东西。
- D11：用 `node:sqlite`，只用同步 API。
- D17：没有 `segments` 表；输入不带 ID 和时间，信箱只留自增序号。
- D18、D19：`effects` 由 `effectOf` 同步，只看编号变化；停止和删行在同一个事务；记忆版本号用 `AUTOINCREMENT`。

模块内的决定：

| 决定 | 原因 |
|---|---|
| `handleNext` 取全局最早的一行 | 一个全局序号就是全部输入的到达顺序，每个进程的输入也按到达顺序处理。代价见坑点 |
| 表都是 `STRICT` | 列类型由 SQLite 检查 |
| `effects` 以 `process_id` 为主键，`status` 带 `CHECK` | 表结构本身保证“每个进程最多一行”和“只有两种状态” |
| 删 `effects` 行用 `DELETE … RETURNING status` | 一条语句就知道删掉的是不是 `running`，要不要中止 |
| 开不了 WAL 就拒绝打开 | 不降级运行。测试因此用临时文件，不用 `:memory:` |
| 建表和写 `user_version` 在一个事务里 | 建到一半崩溃时版本仍是 0，下次打开重新建 |
| 不认识的工具和预设里没有的工具，回同一条错误 | 对这个进程是同一件事：它用不了这个工具 |
| 库内工具只依赖 `Memory` 接口 | 实现由服务传入；测试换成假记忆库 |

## 认知模型

库里有四类事实，各存一处：

| 事实 | 存在哪 |
|---|---|
| 进程的状态 | `processes` 的一行，加 `segment_messages` 里的当前段 |
| 还没处理的输入 | `mailbox` |
| 进程在等哪个库外副作用，开始了没有 | `effects` |
| 记忆 | `memory` |

存储有三个事务：`startProcess`、`send`、`handleNext`。执行器另有三个事务，只写 `effects` 和 `mailbox`。记忆的写入发生在 `handleNext` 的事务里。除了 `openDb` 建表，`src/` 里没有别的代码写库。

判断一次修改是否越界：

- 写库不在某个 `tx` 里：越界。
- 处理一条输入时读旧段，或者读别的进程的工作段：越界。
- 在等的编号没变，`effects` 却被改了：越界。
- 新存一个能从工作段算出来的值：越界。

### 存储层不变量

`test/store/invariants.ts` 的 `assertStoreInvariants(db)`。它们在任何一个事务提交后都必须成立。存储层测试在事务之后调用它，崩溃测试每一步之后都调用：

1. `effects` 的每一行都属于一个存在的进程。
2. 每个进程的记录和当前段满足内核不变量（[kb-kernel.md](kb-kernel.md)）。
3. 每个进程在 `effects` 里最多一行。
4. `effectOf` 为空的进程一定是 `idle`。`idle` 的进程在 `effects` 里没有行。
5. 运行中的进程有 `effects` 行时，行的编号就是 `effectOf` 的编号。
6. 在等库外副作用 n（`callModel`，或 `inStore` 为 false 的工具）：“`effects` 里有 n 这一行”和“信箱里有 n 的结果”，恰好成立一个。
7. 在等库内副作用 n（库内工具、不认识的工具、预设里没有的工具）：`effects` 里没有行，信箱里恰好有一个 n 的结果。

“n 的结果”指：同一个进程、种类对得上（`callModel` 对 `modelResult`，`runTool` 对 `toolResult`）、编号是 n 的输入。

## 投影与命令

存储不加 CLI 命令。它在事务里执行 Agent 的库内工具：

| 工具 | 什么时候有 |
|---|---|
| `self` | 总有 |
| `memory_get`、`memory_set`、`memory_delete` | 预设 `tools` 含 `memory` 时 |

共同规则（`src/store/instore.ts` 的 `runInStore`）：

- 参数不是对象时（包括 `null`），当作空对象。pi-ai 把流式 JSON 的 `null` 解析成 `null`。
- 结果和其它工具结果一样，在 `decide` 里按字节上限裁剪（[kb-kernel.md](kb-kernel.md)）。
- 记忆的 `ns` 是进程快照里的预设 ID。

### 记忆工具

| 工具 | 参数 | 成功的结果 |
|---|---|---|
| `memory_get` | `key` 字符串 | `<key>（版本 <v>）：` 换行接值。键不存在时是 `键 <key> 不存在。`，不算错误 |
| `memory_set` | `key`、`value` 字符串；`version` 整数、`null` 或省略 | `已写入 <key>，版本 <v>。` |
| `memory_delete` | `key` 字符串；`version` 整数，必填 | `已删除 <key>。` |

- `version` 省略或为 `null`：这个键现在必须不存在。
- `version` 必须是整数，`1.5` 也不行。
- 参数不对：结果是 `参数错误：<说明>`，`isError` 为 `true`，不碰记忆。
- 版本对不上：不写入，`isError` 为 `true`，结果带最新值：`版本冲突，没有写入。现在的值是 <key>（版本 <v>）：` 换行接值。键已不存在时是 `版本冲突，没有写入。键 <key> 现在不存在。`。`memory_delete` 也用这两句。
- `memory_set` 超出上限：不写入，`isError` 为 `true`。结果是 `超出上限，没有写入：` 接下表的一句。`N` 是 `Memory.set` 返回的 `bytes`，上限取自 `src/kernel/tools.ts` 的常量。

| 超出的 | 接的那句 |
|---|---|
| `key` | `键有 N 字节，上限 128 字节。` |
| `value` | `值有 N 字节，上限 4096 字节。` |
| `view` | `写入后记忆视图有 N 字节，上限 16384 字节。先删掉或缩短不需要的键。` |

- 超出上限和版本冲突同时发生时报哪个，见 [kb-memory.md 的检查顺序](kb-memory.md#set-的检查顺序)。`memory_set` 的描述引用这三个上限（[kb-kernel.md](kb-kernel.md#工具描述)）。
- 这一节的文字由 `instore.ts` 写。`Memory` 只返回结构化的失败，不带文字。

### `self`

结果是 `observe(新记录, 新段, 全部进程记录, now)` 的文字版。新记录是这次 `decide` 之后的，所以自己的阶段总是“等工具结果”。

```text
现在：<本地时间>（<IANA 时区>）
进程：<id>，预设 <预设 ID>，模型 <模型>，已运行 <时长>
阶段：<阶段>
工作段：第 <n> 段，开始于 <时长>前
上下文：已用约 <used> token，窗口 <window> token
同一个预设下运行中的其他进程：
- <id>：<阶段>，已运行 <时长>
```

- 本地时间用 `toLocaleString("zh-CN", { hour12: false })`，时区用 `Intl.DateTimeFormat().resolvedOptions().timeZone`。两者都取服务所在机器的设置，在内核外格式化。
- 没有兄弟进程时，最后两行换成 `同一个预设下没有其他运行中的进程。`。兄弟按进程 ID 排序。
- 时长取最大的两个非零单位（天、小时、分、秒）。全为零时是 `0 秒`。
- 阶段的写法：

| 阶段 | 文字 |
|---|---|
| `idle` | `空闲`。跑过一轮时是 `空闲，上一轮` 接 `正常结束`、`步数用完`、`被停止` 或 `出错：<原因>` |
| `awaitingModel` | `等模型回复` 或 `等模型写交接说明`，接 `，本轮第 <s> 步，排队消息 <q> 条` |
| `awaitingTool` | `等工具结果，本轮第 <s> 步，排队消息 <q> 条` |

投影里有哪些字段见 [kb-kernel.md](kb-kernel.md)。

## 入口

| 文件 | 内容 |
|---|---|
| `src/store/db.ts` | `SCHEMA`、`SCHEMA_VERSION`、`openDb`、`tx`、行的读写 |
| `src/store/inputs.ts` | `startProcess`、`send`、`handleNext`、同步副作用 |
| `src/store/instore.ts` | `runInStore`：`self` 和 `memory_*` |
| `src/memory/kv.ts` | `Memory` 的 SQLite 实现，服务用它；规则见 [kb-memory.md](kb-memory.md) |
| `test/store/db.test.ts` | 表、PRAGMA、表结构版本、主键和 `CHECK`、编号不复用、回滚 |
| `test/store/inputs.test.ts` | 三个事务、同步规则、库内工具、只读当前段（读取行数和查询计划） |
| `test/store/invariants.ts` | 存储层不变量 |
| `test/store/regressions.test.ts` | 审查发现的缺陷的最小反例 |
| `test/store/crash.test.ts` | 真库上的随机序列；在每个事务之后崩溃 |
| `test/store/longrun.test.ts` | 多次换段后，处理一条输入读取的行数不增长 |
| `test/store/executor.test.ts` | 执行器和竞态（见 [kb-executor.md](kb-executor.md)） |
| `test/store/fixtures.ts` | 临时库、假记忆库、`countReads`、带种子的随机数 |

只跑存储测试：`node --test "test/store/*.test.ts"`。完成门槛见 AGENTS.md。

## 坑点

- **一条抛错的输入会卡住所有进程。** `handleNext` 取全局最早的一行。事务抛出就回滚，这一行留在队头，以后每次都在它这里抛出。所以库内工具不能因为模型给的参数抛出：参数为 `null` 时按空对象处理。验证：`regressions.test.ts`。
- **`tx` 只接同步函数。** `f` 返回 promise 时，`COMMIT` 会在 promise 完成之前执行。库内工具和 `Memory` 的实现都必须同步。
- **`tx` 不能嵌套。** 库内工具和 `Memory` 已经在 `handleNext` 的事务里。里面再调用 `tx`，`BEGIN` 会抛出，整个外层事务回滚。
- **同步要比较编号，不能只看新阶段在等什么。** 结果还在信箱里排队时，先处理一条用户消息，编号不变，副作用不能再插入或再执行一次。验证：`executor.test.ts` 的两个“结果还在信箱里排队”竞态。
- **库内工具执行了，结果却写成“被中断，结果未知”。** 结果还在信箱里时先处理了停止，`endTurn` 给这个调用补 `INTERRUPTED`。记忆其实已经写入。这符合“结果未知”的说法，不要重做，也不要补写。
- **`synchronous` 是连接级设置。** 崩溃和长跑测试在自己的句柄上设成 `OFF` 来提速：模拟的崩溃是关掉句柄，不是断电。`openDb` 每次都设 `FULL`，`db.test.ts` 断言它。不要把 `OFF` 带进 `src/`。
- **改表结构必须提高 `SCHEMA_VERSION`。** `openDb` 只在版本为 0 时建表。版本没变时，旧库带着旧表照常打开。
- **新的读取要看会不会随时间增长。** 处理一条输入只该读上面“读什么”表里的东西。验证：`inputs.test.ts` 数读取行数并检查查询计划；`longrun.test.ts` 比较不同段的读取行数。

## 关联模块

- [kb-kernel.md](kb-kernel.md)：`decide`、`effectOf`、`observe`、内核不变量、工具结果的裁剪。
- [kb-executor.md](kb-executor.md)：`effects` 的另一半：开始、完成、中止、启动恢复。
- [kb-memory.md](kb-memory.md)：`Memory` 接口、上限、视图格式、版本号；测试用的假记忆库和真的有什么不同。
- [kb-service.md](kb-service.md)：服务、回执、`tau ps`。
- [kb-decisions.md](kb-decisions.md)、[kb-overview.md](kb-overview.md)。
