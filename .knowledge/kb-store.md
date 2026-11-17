# 存储

`updated: 2026-11-16`

## 这个模块是干什么的

存储是 `src/store/`：库里的全部状态，以及改动它们的事务。

它负责：

- `~/.tau/tau.db` 的位置、表结构和 PRAGMA。
- 七个存储事务：启动进程、分叉进程、收一条命令、处理一条输入，以及三个删除（删旧段、删进程、清图片）。图片和引用它的信在同一个事务里写入 `blobs`。
- 处理输入时同步待办副作用表（`effects`）。
- 在事务里执行库内工具：`self`、`handoff`、`memory_*`，以及预设含 `agents` 时的 `post`、`spawn`、`stop_process`；还有工具定义在结果里声明的库内动作，它们不看 `agents`（D64）。

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
  tau.db       预设和工具定义以外的全部数据（含图片：`blobs` 表）
  tau.db-wal   SQLite 的 WAL 文件
  tau.db-shm   SQLite 的 WAL 索引
  presets/     预设，纯文本，不在库里
  tools/       工具定义，JSON 文件，不在库里
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
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
```

| 表 | 一行是什么 | 谁写 |
|---|---|---|
| `processes` | 一个进程记录。`state_json` 是 `Process` 的 JSON | `startProcess` 插入；`spawn` 在 `handleNext` 里插；`handleNext` 整行更新；`removeProcess` 删 |
| `segment_messages` | 一条工作段消息。`message_json` 是 pi-ai 的消息，原样存 | `handleNext` 追加；`pruneSegments` 删旧段；`removeProcess` 删全部段 |
| `mailbox` | 一条输入。`input_json` 是 `Input` 的 JSON | 见下 |
| `effects` | 进程正在等的库外副作用：编号 `n` 和状态 | `handleNext` 和执行器 |
| `memory` | 一个键现在的值 | `Memory` 的实现 `src/memory/kv.ts` |
| `blobs` | 一块图片：哈希和原始字节；`sweepBlobs` 删没人引用的行 | `startProcess`、`send` 和引用它的信在同一个事务里插入（`INSERT OR IGNORE`）；带图的工具结果由执行器上报结果的事务写（[kb-executor](kb-executor.md#运行工具actionsts)） |

- 段号从 1 开始。段内序号从 0 开始，每段重新计。
- 旧段和进程只由 `pruneSegments`、`removeProcess` 删（见[删除](#删除)）。
- `mailbox.seq` 和 `memory.version` 用 `AUTOINCREMENT`：删掉的最大编号也不复用。
- 没有外键，也没有另加的索引。`segment_messages` 主键的前缀 `(process_id, segment_seq)` 就是定位当前段的索引。

信箱的写入方：

| 输入 | 谁放进信箱 |
|---|---|
| 信件（CLI 寄来的是用户的信） | `startProcess`、`send` |
| `stop` | `send` |
| 回信 | `handleNext`：处理一条输入的 `decide` 给出 `out`，投进收件人的信箱 |
| 库内工具的结果、工具不存在的错误结果 | `handleNext` 的同步步骤 |
| `post` 的信、`spawn` 的第一封信、`stop_process` 的 `stop` | `handleNext` 的同步步骤：库内工具执行时，放进别的进程的信箱 |
| 库外副作用的 `modelResult`、`toolResult` | 执行器完成动作时 |
| `interrupted` 结果 | 执行器的启动恢复 |

只有 `handleNext` 读出并删除信箱行。

`effects` 的一行由 `handleNext` 插入和删除（见[同步副作用](#同步副作用)），由执行器的三个事务开始、完成和恢复。一行的一生见 [kb-executor.md](kb-executor.md#一行的一生)。

### 打开库与事务

`openDb(path)`：

1. `PRAGMA journal_mode = WAL`。结果不是 `wal` 就关库并抛出。所以 `:memory:` 会被拒绝。
2. `PRAGMA synchronous = FULL`。回执承诺“写进库才返回”，所以每次提交都要落盘。这是连接级设置，每次打开都设。
3. 读 `PRAGMA user_version`：
   - 0 是新库：在一个事务里建 6 张表，并写入 `SCHEMA_VERSION`（现在是 5）。
   - 等于 `SCHEMA_VERSION`：直接用。
   - 其它值：关库并抛出，提示停掉服务、移走旧库、重启后重建。MVP 不做迁移。

`tx(db, f)`：`BEGIN IMMEDIATE`，执行 `f`，`COMMIT`。`f` 抛出时，如果库还开着并且还在事务里，就 `ROLLBACK`，再把错误抛出去。

行的读写函数都在 `db.ts`：`loadProcess`、`loadProcesses`（按 ID 排序）、`saveProcess`、`loadSegment`、`readSegment`、`countMessages`（只数一段的条数，不读消息；`inspect` 用）、`appendMessages`、`putMail`（把一条输入放进一个进程的信箱）。它们不开事务。写入都由调用方放进 `tx`。

### 存储事务

一共七个：`startProcess`、`forkProcess`、`send`、`handleNext`、`pruneSegments`、`removeProcess`、`sweepBlobs`。都在 `src/store/inputs.ts`，每个函数恰好一个 `tx`。

| 函数 | 做什么 | 失败时 |
|---|---|---|
| `startProcess(db, memory, id, preset, text, now, images?)` | 用 `start` 建 `idle` 进程记录并插入；第一条消息作为用户的信进信箱。带图片时，信的内容块在同一个事务里生成，图片存进 `blobs`（见[图片](#图片)） | ID 重复：主键冲突，什么都不写，`blobs` 也不留。启动检查不通过（[kb-kernel](kb-kernel.md#启动检查和交接以后的检查)）：抛错，什么都不写 |
| `forkProcess(db, memory, id, source, before, now, preset?)` | 读源进程记录和当前段，用 `fork` 算出新进程记录和要复制的消息（带 `preset`，是调用方在事务之外读好的新预设快照，记忆视图按它重取，见 [kb-kernel 的 fork](kb-kernel.md#fork)），过启动检查，插入新进程记录，写入复制的消息；返回新记录和复制的段。不寄信，不碰 `effects` 和 `blobs`（图片引用照用，`blobs` 不动） | 没有源进程、`fork` 的拒绝（[kb-kernel](kb-kernel.md#fork)）、启动检查不通过、新 ID 已被占用：抛错，整个事务回滚，什么都不留 |
| `send(db, id, input, images?)` | 把信件或 `stop` 放进已有进程的信箱。带图片时和 `startProcess` 一样，按目标进程的快照处理；图片只能跟着信 | 进程不存在：抛出“没有这个进程”，什么都不写，`blobs` 也不留 |
| `handleNext(db, memory, now, readPreset?)` | 处理信箱里最早的一条输入。`readPreset` 给 `spawn` 读预设用，服务传 `loadPreset` | 抛出时整个事务回滚，这条输入留在队头 |
| `pruneSegments(db, id, before)` | 删这个进程段号小于 `before` 的全部旧段。`before` ≤ 1 什么都不删，照样成功 | 没有这个进程、`before` 大于当前段号：抛错，什么都不删 |
| `removeProcess(db, id)` | 删一个空闲、没人引用的进程的记录和全部段。不碰记忆、`blobs`、`effects` | 没有这个进程、不是 `idle`、信箱里有它的输入、有进程的 `parent` 是它、它在任何 `turn.replyTo` 或排队的信的 `replyTo` 里：抛错，什么都不删 |
| `sweepBlobs(db)` | 删没人引用的 `blobs` 行，返回删掉的行数 | 抛出时整个事务回滚 |

`Env` 怎样算：`now` 由调用方传入；预设 `tools` 含 `memory` 时，`memoryView` 是 `memory.view(preset.id)`，否则是空串，不碰记忆。

### 处理一条输入

`handleNext` 的步骤：

1. 取信箱里 `seq` 最小的一行。不分进程，取全局最早的。信箱空就返回 `null`。
2. 读这一行所属进程的进程记录。不存在就抛出。
3. 读当前段：`segment_seq` 等于记录里段号的全部消息，按 `seq` 排序。
4. 算 `Env`，调用 `decide(旧记录, 当前段, 输入, env)`，得到新记录、要追加的消息和要寄的回信。
5. 写回进程记录。把追加的消息写进新记录的段：没换段时序号接着当前段，换段时从 0 开始。一次 `decide` 只写一段（[kb-kernel.md](kb-kernel.md)）。
6. 投递回信：`decide` 给出的 `out` 里每封回信，放进收件人的信箱。收件人是别的进程，它的记录和段这里不读不写。
7. 删除这条信箱行。
8. 同步副作用，见下一节。库内工具在这一步执行：它们可能写别的进程的信箱，`spawn` 还插进程行。
9. 提交，返回 `{ process: 新记录, segment: 处理后的当前段, abort }`。`segment` 让服务算 `watch` 的 `update` 时不再读库。

`abort` 不为 `null` 时，是这个事务删掉的 `running` 行的编号。调用方在提交之后中止执行器里的这个动作。

### 图片

代码在 `src/store/blobs.ts`。入口检查在 `src/images.ts`，由服务在调用事务之前做（[kb-service](kb-service.md#图片)）。事务收到的是已经检查过的图片：哈希、类型、字节。

- `letterContent(db, text, images, accepts)` 在调用方的事务里生成信的内容块：
  - 没有图片：一个文本块。
  - 目标进程的快照 `input` 含 `image`：`INSERT OR IGNORE INTO blobs`，每张图一个图片块，`data` 是 `blob:<hash>`，`mimeType` 是魔数算出的类型。文本为空时没有文本块。
  - 不含 `image`：不存图片，每张换成一行 `[图片：模型不支持，已省略]`，和文本合成一个文本块，行之间用换行。所以这种进程的段里永远没有图片。
- `hash` 是原始字节的 sha256，64 位小写十六进制。同一张图只存一行。
- 没人引用的行无害（例如已经存下的图片，后来引用它的信被 `decide` 丢掉），由 `sweepBlobs` 清掉（见[删除](#删除)）。带图的工具结果的行在执行器上报结果的事务里写，结果过时被丢弃时，图片也不写。`putBlobs(db, images)` 是这两处共用的插入。
- 带引用的只有协议的信和工具结果。`post`、`spawn` 和回信只有文本。
- `readBlob(db, hash)` 只读，不开事务。服务的 `blob` 请求和执行器都用它。
- 纯函数层里没有图片的字节：`decide`、`buildContext` 照样处理引用。字节只在执行器调用模型之前换进请求（[kb-executor](kb-executor.md#调用模型actionsts)）。

### 删除

三个删除事务（D59，[决策](kb-decisions.md#d59-删除原语旧段和空闲进程)）。由上层经协议调用，什么时候删由上层定；请求和回执见 [kb-service](kb-service.md#删除)。它们不是处理一条输入，和 `forkProcess` 一样另有读取：

| 事务 | 读什么 |
|---|---|
| `pruneSegments` | 这个进程的进程记录（取当前段号） |
| `removeProcess` | 全部进程记录和信箱，在同一个事务里重新读 |
| `sweepBlobs` | 全部进程的全部段、信箱、全部进程记录 |

- `pruneSegments`：当前段永不删。进程在运行也可以删，因为处理输入、执行器的 claim、`fork`、`settle` 都只读当前段。按主键前缀 `(process_id, segment_seq)` 删，不随库变慢。
- 删掉的段是从 1 起连着的一段：总是删“小于 `before`”的全部。旧段要么整段在、不为空，要么整段删掉（[存储层不变量](#存储层不变量)第 9 条）。
- `removeProcess`：拒绝条件见[存储事务](#存储事务)的表。这样被删的进程不再被任何地方引用，所以不用改回信的投递规则（理由见 D59）。它不碰记忆、`blobs`、`effects`：`idle` 的进程没有 `effects` 行。
- `sweepBlobs`：引用在三处：全部进程的全部段、信箱、进程记录里的 `turn.queued`。找引用按原文找 `blob:` 加 64 位小写十六进制：多认只会多留，不会多删。它扫全库，期间服务停着不处理别的事，所以和前两个分开：上层批量清理完再调一次。没人引用的图片本来无害，分开不损失原子性。

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
| `runTool`，库内工具 | 在这个事务里执行（`post`、`spawn`、`stop_process` 还写别的进程的信箱，`spawn` 还插进程行），结果作为 `toolResult` 放进信箱 |
| `runTool`，不认识的工具或预设里没有的工具 | 把内容为这句文本的错误结果（`工具 <name> 不存在，或者预设里没有它。`）作为 `toolResult` 放进信箱 |

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
| 收件人或目标的进程记录（只查存不存在） | 库内工具是 `post`、`stop_process` 时 |
| 预设文件，和子进程的记忆视图 | 库内工具是 `spawn` 时（通过 `readPreset` 和 `Memory`） |
| 已有的进程 ID | `spawn` 算新 ID 时，每次尝试一次 |

`forkProcess` 不是处理一条输入，另有一张读取表：源进程的进程记录和当前段（和 `history` 读当前段一样），不读旧段。带 `preset` 时还读新预设的记忆视图（和 `spawn` 一样）；预设文件和工具定义文件由服务在事务之外读。

处理一条输入和 `forkProcess` 不读旧段，也不读别的进程的工作段。

三个删除事务也不是处理一条输入，读什么见[删除](#删除)。

### 为什么处理输入不会随时间变慢

- 当前段靠主键前缀 `(process_id, segment_seq)` 定位。旧段不加载，不校验。
- 当前段的大小被换段阈值限制住（[kb-kernel.md](kb-kernel.md)）。
- 信箱的行处理完就删。`effects` 每个进程最多一行，只在等库外副作用时存在。
- 记忆视图每条输入都读。它有上界：`set` 拒绝会让渲染后的视图超过上限的写入（[kb-memory.md](kb-memory.md#上限)）。
- 例外：`self` 读全部进程记录。进程不删就一直留着，`self` 和 `tau ps` 随进程数变慢；上层用 `remove` 删不用的进程（D59，[设计稿的风险表](../docs/design/mvp.md#风险)）。

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
| 库内工具只依赖 `Memory` 接口和 `readPreset` | 实现由服务传入；测试换成假的 |

## 认知模型

库里有五类事实，各存一处：

| 事实 | 存在哪 |
|---|---|
| 进程的状态 | `processes` 的一行，加 `segment_messages` 里的当前段 |
| 还没处理的输入 | `mailbox` |
| 进程在等哪个库外副作用，开始了没有 | `effects` |
| 记忆 | `memory` |
| 图片的字节 | `blobs`；引用在信、`turn.queued` 和段里，写成 `blob:<hash>` |

存储有七个事务：`startProcess`、`forkProcess`、`send`、`handleNext`、`pruneSegments`、`removeProcess`、`sweepBlobs`。`startProcess` 和 `send` 还写 `blobs`。`pruneSegments`、`removeProcess` 删段和进程，`sweepBlobs` 删 `blobs`。执行器另有三个事务，只写 `effects` 和 `mailbox`；上报结果的事务还插入 `blobs`（带图的工具结果的图片）。记忆的写入发生在 `handleNext` 的事务里。除了 `openDb` 建表，`src/` 里没有别的代码写库。

判断一次修改是否越界：

- 写库不在某个 `tx` 里：越界。
- 处理一条输入时读旧段，或者读别的进程的工作段：越界。
- 在等的编号没变，`effects` 却被改了：越界。
- 新存一个能从工作段算出来的值：越界。
- 删进程、段或图片不经这三个删除事务：越界。

### 存储层不变量

`test/store/invariants.ts` 的 `assertStoreInvariants(db)`。它们在任何一个事务提交后都必须成立。存储层测试在事务之后调用它，崩溃测试每一步之后都调用：

1. `effects` 的每一行都属于一个存在的进程。
2. 每个进程的记录和当前段满足纯函数层不变量（[kb-kernel.md](kb-kernel.md)）。
3. 每个进程在 `effects` 里最多一行。
4. `effectOf` 为空的进程一定是 `idle`。`idle` 的进程在 `effects` 里没有行。
5. 运行中的进程有 `effects` 行时，行的编号就是 `effectOf` 的编号。
6. 在等库外副作用 n（`callModel`，或 `inStore` 为 false 的工具）：“`effects` 里有 n 这一行”和“信箱里有 n 的结果”，恰好成立一个。
7. 在等库内副作用 n（库内工具、不认识的工具、预设里没有的工具）：`effects` 里没有行，信箱里恰好有一个 n 的结果。

8. 信箱、`turn.queued` 和全部进程的全部段里的每个 blob 引用，`blobs` 里都有对应的行。图片块的 `data` 不是 `blob:<hash>` 也算违反：库里只存引用。检查在 `assertStoreInvariants` 的 `assertBlobRefs`，读全部进程的全部段。
9. 旧段（段号小于当前段）要么整段在、不为空，要么整段删掉；删掉的段是从 1 起连着的一段（`pruneSegments` 总是删“小于 `before`”的全部）。`history` 判断一段是否被删，靠这一条。

“n 的结果”指：同一个进程、种类对得上（`callModel` 对 `modelResult`，`runTool` 对 `toolResult`）、编号是 n 的输入。

## 投影与命令

存储不加 CLI 命令。它在事务里执行 Agent 的库内工具：

| 工具 | 什么时候有 |
|---|---|
| `self` | 总有 |
| `handoff` | 总有 |
| `memory_get`、`memory_set`、`memory_delete` | 预设 `tools` 含 `memory` 时 |
| `post`、`spawn`、`stop_process` | 预设 `tools` 含 `agents` 时 |

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
父进程：<id>
阶段：<阶段>
工作段：第 <n> 段，开始于 <时长>前，共 <m> 条消息
上下文：已用约 <used> token，窗口 <window> token
换段阈值：<threshold> token
累计用量：输入 <a>，输出 <b>，缓存读 <c>，缓存写 <d>（token）
同一个预设下运行中的其他进程：
- <id>：<阶段>，已运行 <时长>
运行中的子进程：
- <id>：预设 <预设 ID>，<阶段>，已运行 <时长>
空闲的子进程：<n> 个
```

- `父进程` 一行只在有父进程时出现。`运行中的子进程` 和它的各行只在有运行中的子进程时出现；`空闲的子进程` 一行只在个数大于 0 时出现。
- 换段阈值一行是 `context.threshold`：`handoffThreshold`，含预设的 `handoff`。
- 工作段一行：段里还没有消息时没有“开始于”。消息条数是当前段的。累计用量跨段。
- 空闲子进程的 ID 不在文字里，要找就用协议 `ps` 的投影按 `parent` 挑。

- 本地时间用 `toLocaleString("zh-CN", { hour12: false })`，时区用 `Intl.DateTimeFormat().resolvedOptions().timeZone`。两者都取服务所在机器的设置，在纯函数层外格式化。
- 没有兄弟进程时，`同一个预设下运行中的其他进程：` 和它下面的各行，换成一行 `同一个预设下没有其他运行中的进程。`。兄弟按进程 ID 排序。
- 时长取最大的两个非零单位（天、小时、分、秒）。全为零时是 `0 秒`。
- 阶段的写法：

| 阶段 | 文字 |
|---|---|
| `idle` | `空闲`。跑过一轮时是 `空闲，上一轮` 接 `正常结束`、`步数用完`、`被停止` 或 `出错：<原因>`（文字由纯函数层的 `endedText` 给出，见 [kb-kernel.md](kb-kernel.md#结束原因的文字)：原因截到 1024 字节，回车换行换成空格） |
| `awaitingModel` | `等模型回复` 或 `等模型写交接说明`，接 `，本轮第 <s> 步，排队消息 <q> 条` |
| `awaitingTool` | `等工具结果，本轮第 <s> 步，排队消息 <q> 条` |

投影里有哪些字段见 [kb-kernel.md](kb-kernel.md)。

### `handoff`

没有参数。结果是 `将在这批工具结果之后换段。`，`isError` 为假。它什么都不改：换段由 `decide` 发起，条件和时机见 [kb-kernel.md](kb-kernel.md#主动换段handoff)。

### 进程之间的工具

预设 `tools` 含 `agents` 时才有。参数和说明在 `src/kernel/tools.ts`（[kb-kernel](kb-kernel.md#工具描述)）。执行在 `runInStore`，在处理输入的事务里，和工具结果一起提交：崩溃时要么都发生，要么都没发生。

| 工具 | 参数 | 做什么 |
|---|---|---|
| `post` | `to`、`text`、`reply?` | 往 `to` 的信箱放一封信。`reply` 为真时，信带 `replyTo` = 自己 |
| `spawn` | `preset`、`text` | 读预设，建新进程（`parent` = 自己），第一封信带 `replyTo` = 自己 |
| `stop_process` | `process` | 往目标的信箱放一个 `stop` |

信的 `from` 是 `{ kind: "process", id: 自己, preset: 自己的预设 ID }`，内容是一个文本块，`hops` = `turn.hops + 1`。

结果：

| 情形 | 结果 | `isError` |
|---|---|---|
| `post` 成功 | `已寄给 <id>。`；`reply` 为真时再加 `它处理这封信的那一轮结束时会给你回信，之后的几轮不会。` | 否 |
| `spawn` 成功 | `已建进程 <id>，预设 <preset>。它这一轮结束时会给你回信，之后的几轮不会。` | 否 |
| `stop_process` 成功 | `已给 <id> 发出停止。` | 否 |
| 收件人或目标不存在 | `没有进程 <id>。` | 是 |
| `post` 给自己 | `不能给自己寄信。` | 是 |
| `stop_process` 停自己 | `不能停止自己。要结束这一轮，直接回复，不再调用工具。` | 是 |
| 预设读不出 | `预设 <preset> 读不出：<原因>`，原因是读预设抛出的错误信息 | 是 |
| 预设通不过启动检查 | `预设 <preset> 的窗口太小，装不下：固定部分 <f> token，记忆的上界 <m> token，换段阈值 <T> token`，什么都不建 | 是 |
| 跳数到上限 | `跳数到上限（1024）：这封信是被进程之间的信一路引出来的。结束本轮，等用户的下一封信。` | 是 |
| 参数不对 | `参数错误：<说明>` | 是 |

- 永不抛错：抛错会让事务回滚，这条输入留在队头，所有进程都卡住（见[坑点](#坑点)）。所有失败都是 `isError` 的结果，什么都不写。
- 检查顺序：参数，对象是不是自己，对象存不存在，跳数，（`spawn`）读预设。`spawn` 没有“对象”这两步。
- 跳数：用户的信 `hops` 为 0；`post`、`spawn` 寄出的信 `hops` = `turn.hops + 1`，超过 `HOPS_MAX`（1024）就失败；回信不受这个限制。跳数只保证进程之间的信不会无限循环，不限制花费，也不是边界：从 bash 寄的信都是用户的信，`hops` 为 0。
- 顺序委派（子进程不再委派，父进程每次等到回信再派下一个）：每派一个、收一封回信，`turn.hops` 加 2。第 k 次寄出的信跳数是 2k − 1，所以一封用户的信引出的顺序委派最多 512 次，第 513 次是 1025，报跳数到上限。每多一层嵌套，约减半。安全点并入的旧回信，也会把用户新开的一轮的跳数抬高。真不够用时放宽 `HOPS_MAX`，放宽它不算改契约（为什么是 1024，见 [D50](kb-decisions.md#d50-hops_max-放宽到-1024)）。

`spawn`：

- 不调用 `startProcess`，因为事务不能嵌套。它用 `start` 建记录，加上 `parent`，插入 `processes`，再把第一封信放进新进程的信箱。
- `start` 的 `Env` 按子进程的预设算：记忆视图是子进程的，不是父进程的（`envFor`）。
- 预设用 `handleNext` 收到的 `readPreset` 读（服务传的是 `loadPreset`，测试传假的）。读出的是快照，读不出（抛出）就是错误结果，什么都不建。不传时，任何预设都读不出。
- 新 ID：`spawnId(父进程 ID, 这次调用的副作用编号, 尝试次数)`，取 sha256 的前 8 个十六进制字符，尝试次数从 0 开始。已有这个 ID 的进程，就把尝试次数加一再算。副作用编号是 `p.lastEffect`：进程在等的就是这次调用。所以崩溃后重放得到同一个 ID。
- 第一封信带 `replyTo` = 自己：子进程这一轮结束时回信一次，之后的几轮不回。

`stop_process`：

- `stop` 结束目标此刻正在跑的这一轮。它不认是哪一轮：发出之前目标已经开了新一轮，停掉的就是新的那一轮。目标空闲时什么都不发生。
- 被停止的一轮照样寄回信，所以停一个子进程，会唤醒在等它的父进程。
- 要停一棵进程树：先停全部子孙，再停祖先，直到 `ps` 里都空闲。这不原子，只能尽力而为：被回信唤醒的祖先，在停止到达之前可能又建了新的子进程，要再停一遍；每个被回信唤醒的祖先，多一次被中止的模型调用；能运行命令的进程用 `tau start` 建的进程没有 `parent`，按 `parent` 找不到。

两处规则的例外（理由和别的做法见 [D36](kb-decisions.md#d36-第-4-步第二部分进程之间的工具的执行和两处例外)）：

- “库内工具只碰库”：`spawn` 还读预设文件和它用到的工具定义文件，查工作目录。
- “处理一条输入只读进程记录和当前工作段”：`post`、`stop_process` 读收件人的进程记录，`spawn` 读文件。

## 入口

| 文件 | 内容 |
|---|---|
| `src/store/db.ts` | `SCHEMA`、`SCHEMA_VERSION`、`openDb`、`tx`、行的读写 |
| `src/store/inputs.ts` | `startProcess`、`forkProcess`、`send`、`handleNext`、`pruneSegments`、`removeProcess`、`sweepBlobs`、同步副作用 |
| `src/store/instore.ts` | `runInStore`：`self`、`handoff`、`memory_*`、`post`、`spawn`、`stop_process`；`spawnId`、`envFor`、`ReadPreset` |
| `src/store/blobs.ts` | `letterContent`（信的内容块，存图片或换成说明）、`readBlob`、`resolveImages`（请求里的引用换成 base64） |
| `src/memory/kv.ts` | `Memory` 的 SQLite 实现，服务用它；规则见 [kb-memory.md](kb-memory.md) |
| `test/store/db.test.ts` | 表、PRAGMA、表结构版本、主键和 `CHECK`、编号不复用、回滚 |
| `test/store/inputs.test.ts` | `startProcess`、`send`、`handleNext` 三个事务、同步规则、库内工具、只读当前段（读取行数和查询计划） |
| `test/store/blobs.test.ts` | 图片：存字节和引用、同一事务（反例：进程不存在、启动检查不过、ID 重复时不留 `blobs`）、不收图片的模型换说明、`resolveImages`、执行器调用模型前换成真数据、不变量能抓到缺行 |
| `test/store/invariants.ts` | 存储层不变量（含 blob 引用完整性） |
| `test/store/fork.test.ts` | `forkProcess`：新进程和复制的消息、源进程和库里别的东西不变；运行中带 `before` 可以、不带被拒；各种拒绝和启动检查不通过什么都不建；新 ID 被占用或写到一半失败时回滚；带图片引用的段不变量成立、`blobs` 不增；带 `preset`：快照和记忆视图来自新预设，图片按新模型处理，放不进什么都不建 |
| `test/store/delete.test.ts` | 三个删除事务（D59）：`pruneSegments`（当前段不删、`before` 越界被拒、`before` ≤ 1 什么都不删、运行中也能删、没有进程被拒）；`removeProcess` 的每条拒绝（没有进程、不是 `idle`、信箱里有它的输入、有子进程、在 `turn.replyTo` 里、在排队的信和信箱里的信的 `replyTo` 里）各一个最小反例，拒绝后库不变，成功时记忆和 `blobs` 不动；`sweepBlobs`（只在 `turn.queued` 里引用的图片留下，到安全点调用模型拿得到真字节；`fork` 共用的图片、旧段的图片）；不变量第 8、9 条能抓到违反 |
| `test/store/regressions.test.ts` | 审查发现的缺陷的最小反例 |
| `test/store/crash.test.ts` | 真库上的随机序列（含要回信的信和回信、带图片的信、三个删除事务，`removeProcess` 被拒绝也是正常结果）；在每个事务之后崩溃 |
| `test/store/longrun.test.ts` | 多次换段后，处理一条输入读取的行数不增长 |
| `test/store/replies.test.ts` | 回信在处理那条输入的事务里投递（回滚时一起撤销）；同一轮合并的几封信只回一封 |
| `test/store/agents.test.ts` | `post`、`spawn`、`stop_process` 的结果和失败；A 问 B、B 被停止；互相寄信停在 `HOPS_MAX`；顺序委派 512 次；`spawn` 的 ID 和记忆视图；回滚；在每一步之后崩溃，结果和不崩溃时一样 |
| `test/store/executor.test.ts` | 执行器和竞态（见 [kb-executor.md](kb-executor.md)） |
| `test/store/fixtures.ts` | 临时库、假记忆库、`countReads`、带种子的随机数 |

删除测试（D59，`delete.test.ts`，服务层在 `test/server/protocol.test.ts`）：

- 运行中的进程有带图的排队信，`sweepBlobs` 之后到安全点，调用模型照常成功。
- `fork` 共用的图片不被 `sweepBlobs` 清掉。
- `removeProcess` 的每条拒绝：没有进程、不是 `idle`、信箱里有它的输入、有子进程、在 `turn.replyTo` 里、在排队的信的 `replyTo` 里。
- `pruneSegments`：当前段不删；`before` 大于当前段号被拒；`before` ≤ 1 成功但什么都不删；进程运行中也能删；不变量第 8、9 条成立。
- 读已删的段回 `error`（服务层）。
- `assertStoreInvariants`：`assertBlobRefs` 读全部进程的全部段；第 9 条的检查（`assertSegmentRows`，另查没有属于不存在进程的消息）。
- 随机序列和崩溃注入测试含三个请求。

只跑存储测试：`node --test "test/store/*.test.ts"`。完成门槛见 AGENTS.md。

## 坑点

- **一条抛错的输入会卡住所有进程。** `handleNext` 取全局最早的一行。事务抛出就回滚，这一行留在队头，以后每次都在它这里抛出。所以库内工具不能因为模型给的参数抛出：参数为 `null` 时按空对象处理。`post`、`spawn`、`stop_process` 也不抛：收件人不存在、跳数到上限、预设读不出，都是 `isError` 的结果。验证：`regressions.test.ts`、`agents.test.ts`。
- **`tx` 只接同步函数。** `f` 返回 promise 时，`COMMIT` 会在 promise 完成之前执行。库内工具和 `Memory` 的实现都必须同步。
- **`tx` 不能嵌套。** 库内工具和 `Memory` 已经在 `handleNext` 的事务里。里面再调用 `tx`，`BEGIN` 会抛出，整个外层事务回滚。
- **同步要比较编号，不能只看新阶段在等什么。** 结果还在信箱里排队时，先处理一条用户消息，编号不变，副作用不能再插入或再执行一次。验证：`executor.test.ts` 的两个“结果还在信箱里排队”竞态。
- **库内工具执行了，结果却写成“被中断，结果未知”。** 结果还在信箱里时先处理了停止，`endTurn` 给这个调用补 `INTERRUPTED`。记忆其实已经写入。这符合“结果未知”的说法，不要重做，也不要补写。
- **`synchronous` 是连接级设置。** 崩溃和长跑测试在自己的句柄上设成 `OFF` 来提速：模拟的崩溃是关掉句柄，不是断电。`openDb` 每次都设 `FULL`，`db.test.ts` 断言它。不要把 `OFF` 带进 `src/`。
- **改表结构必须提高 `SCHEMA_VERSION`。** `openDb` 只在版本为 0 时建表。版本没变时，旧库带着旧表照常打开。
- **新的读取要看会不会随时间增长。** 处理一条输入只该读上面“读什么”表里的东西。验证：`inputs.test.ts` 数读取行数并检查查询计划；`longrun.test.ts` 比较不同段的读取行数。

## 关联模块

- [kb-kernel.md](kb-kernel.md)：`decide`、`effectOf`、`observe`、纯函数层不变量、工具结果的裁剪。
- [kb-executor.md](kb-executor.md)：`effects` 的另一半：开始、完成、中止、启动恢复。
- [kb-memory.md](kb-memory.md)：`Memory` 接口、上限、视图格式、版本号；测试用的假记忆库和真的有什么不同。
- [kb-service.md](kb-service.md)：服务、回执、`tau ps`。
- [kb-decisions.md](kb-decisions.md)、[kb-overview.md](kb-overview.md)。
