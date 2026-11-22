# 记忆

`updated: 2026-11-22`

## 这个模块是干什么的

记忆是 `src/memory/kv.ts`：`Memory` 接口的 SQLite 实现。接口的类型在 `src/kernel/types.ts`，上限常量在 `src/kernel/tools.ts`。

它负责：

- `Memory` 接口的语义和契约。
- 谁有记忆库，`ns` 是什么。
- 四个上限、`set` 的检查顺序、在哪里检查。
- 视图的格式：视图是索引，不是全部内容（[D81](kb-decisions.md#d81-记忆视图改成索引键更新日期字节数摘要)）。
- 版本号的规则。
- 键和值的编码：U+0000、孤立的代理项。

它不负责：

- `memory` 表的结构和 `AUTOINCREMENT`：[kb-store.md](kb-store.md#表)。
- `memory_get`、`memory_set`、`memory_edit`、`memory_delete` 的参数、结果和文字，包括超出上限时的文字：[kb-store.md](kb-store.md#记忆工具)。
- 什么时候读视图、在哪个事务里执行：[kb-store.md](kb-store.md#处理一条输入读什么)。
- 视图怎样进系统提示词、开段时的快照 `segment.memoryView`：[kb-kernel.md](kb-kernel.md#函数)。预设文件声明的上下文文件，也在开段时读成快照 `segment.contextView`，放在记忆前面，不属于记忆库：[kb-store.md](kb-store.md#上下文文件视图)。
- 视图在换段阈值里占多少：[kb-kernel.md](kb-kernel.md#换段阈值)。
- 服务启动时建 `sqliteMemory`：[kb-service.md](kb-service.md#启动顺序)。

本页接管[设计稿](../docs/design/mvp.md)第 8.1 节和第 8.2 节的细节。长期方向（挂载、日志、整理）见 [D6](kb-decisions.md#d6-mvp-的记忆是带版本号的键值存储)。

## 架构

### 接口

`src/kernel/types.ts`：

```ts
interface Versioned { value: string; brief: string; updated: Instant; version: number }

interface Memory {
  view(ns: string): string;
  entries(ns: string): (Versioned & { key: string })[]; // 按键的 UTF-8 字节序
  namespaces(): string[];                                // 有键的全部 ns，按字节序
  get(ns: string, key: string): Versioned | null;
  set(ns: string, key: string, put: { value: string; brief: string; now: Instant }, expected: number | null):
    | { ok: true; version: number }
    | { ok: false; current: Versioned | null }
    | { ok: false; over: "key" | "value" | "brief" | "view"; bytes: number };
  delete(ns: string, key: string, expected: number):
    { ok: true } | { ok: false; current: Versioned | null };
}
```

- 写（`set`、`delete`）在调用方的事务里执行，随事务提交或回滚；读（`view`、`get`、`entries`、`namespaces`）也可以由服务在事务外直接调，比如协议的 `memory`。哪个事务调用它们，见 [kb-store](kb-store.md#处理一条输入读什么)。
- `ns` 参数的理由：一张表里存着多个库。
- `expected: null` 表示“这个键现在必须不存在”。`delete` 的 `expected` 必填。
- `put.now` 记成这一行的 `updated`（毫秒）。`kv.ts` 不读时钟：时间由调用方传入，和 `decide` 的 `Env.now` 一样。处理输入的事务传这条输入的 `now`，协议写入传服务的 `now`。
- `brief` 是模型给这个值写的摘要，是视图里唯一展示值的部分。空串合法。
- 版本对不上：返回 `current`，即现在的值、摘要、更新时间和版本号。键不存在时是 `null`。工具层把它放进结果，由模型合并。
- 超出上限：`over` 说是哪一项超了。`bytes` 是那一项的 UTF-8 字节数；`view` 时是写入后整个视图的字节数。
- 失败不带原因文字。给模型看的文字由工具层写（[kb-store](kb-store.md#记忆工具)）。
- 被拒绝的 `set` 和 `delete` 不改库。
- 处理输入的事务和 `writeMemory` 只通过这个接口访问记忆。以后换成分层设计，只换实现。
- `entries(ns)`、`namespaces()` 给协议的 `memory` 读。键和 ns 都按 `CAST(... AS BLOB)` 读出再解码，所以 U+0000 不截断；排序是 SQLite 的 `BINARY`，即 UTF-8 字节序。

契约，写在接口的注释里：

> 全部同步。写（set、delete）在调用方的事务里执行，随事务提交或回滚；读（view、get、entries、namespaces）也可以由服务在事务外直接调。
> `view(ns)` 的 UTF-8 字节数永远不超过 `MEMORY_VIEW_MAX_BYTES`；`set` 拒绝会超出的写入。

换段阈值的算术依赖这条契约。换实现时也要守住它。视图是全部键的索引，不是全部值：要值用 `get`。

### 谁有记忆库

- 预设 `tools` 含 `memory` 的进程有记忆库，`ns` 等于预设 ID。它有四个记忆工具：读、整条写、换一段（`memory_edit`，[D89](kb-decisions.md#d89-memory_edit记忆工具的另一半只换一段不重发整个值)）、删。
- 不含 `memory` 时，模型没有记忆工具，`Env.memoryView` 为空，提示词里不挂记忆。但工具定义仍能在结果里声明 `memory_get`、`memory_set`、`memory_edit`、`memory_delete`，在处理这条结果的事务里读写 `ns` 等于预设 ID 的库，不看预设有没有 `memory`（[kb-store](kb-store.md#声明的库内动作)，[D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)）。
- 同一个预设的进程共用一个库。并行写同一个键，靠版本号发现冲突。
- 视图是开段时的索引快照。要看一个值，或者拿到现在的版本号，用 `memory_get`。
- 记忆变化不通知兄弟进程。
- 协议也能读写任何 `ns` 的记忆（D64 第 6 组），不要求预设存在、也不要求有 `memory`：`memory`、`memory_write`（[kb-service](kb-service.md#读写记忆memorymemory_write)）。`ns` 过预设 ID 的检查（`checkPresetId`，和 `loadPreset` 同一个函数）。管道不认调用方是谁：有 bash 或能连管道的工具定义的进程，都能写任何预设的库。`memory` 给全部值、摘要和更新时间；`memory_write` 的 `set` 的 `brief` 可选，缺省是 `briefOf(value)`（[D81](kb-decisions.md#d81-记忆视图改成索引键更新日期字节数摘要)）。
- 协议写入和兄弟进程的 `memory_set` 效果一样：改库，不写任何进程记录、段和信箱。已有进程当前段的 `memoryView` 不变；同预设之后开的新段（`start`、换段、`spawn`、带 `preset` 的 `fork`，以及 `reconfigure` 直接采用新快照时，条件见 [kb-kernel](kb-kernel.md#流程会话配置reconfigure)）看得到，前提是快照含 `memory`；不带 `preset` 的 `fork` 复制源进程段里的视图，看不到。记忆不是进程状态，它像 `now` 一样经 `Env` 进 `decide`。
- 没有不带版本号的强写，没有 `memory_view`（视图是渲染的结论，进程的在 `segment.memoryView`，`inspect` 能给），没有单键的读（`entries` 一次全给，带版本）。

### 上限

| 常量 | 值 | 理由 |
|---|---|---|
| `MEMORY_KEY_MAX_BYTES` | 128 | 键是名字，不是内容。约 40 个汉字 |
| `MEMORY_VALUE_MAX_BYTES` | 4096 | 一个键是一条笔记，不是文档。一次 `memory_get` 最多进上下文约 2K token |
| `MEMORY_BRIEF_MAX_BYTES` | 200 | 摘要是一句话，约 66 个汉字。视图里每行都带它 |
| `MEMORY_VIEW_MAX_BYTES` | 32768 | 索引在每次模型请求里。按纯函数层的估算最多 16,384 token，约占 1M 窗口换段阈值的 2.2%；64K 窗口装不下它加第一条消息（[D80](kb-decisions.md#d80-记忆视图的上限从-16-kib-放到-32-kib)）。D81 以后它限制的是条数，不是值的总量 |

- 都按 UTF-8 字节算（`utf8Bytes`）。
- 视图的上限量的是渲染后的索引文本，转义也算在内。不是键和摘要的字节数之和。
- 视图永远是这个 `ns` 全部键的索引，没有截断规则。库的容量由条数乘值的上限决定：一行最短约 28 字节，条数理论上界约 1,170，值的总量理论上界约 4.6 MB；典型的一行约 200 字节，约 160 条。
- `delete` 没有上限。
- 常量放在 `src/kernel/tools.ts`，因为 `memory_set` 的工具描述要引用它们。

### `set` 的检查顺序

1. 把键、值、摘要里孤立的代理项换成替换字符（`toWellFormed()`）。理由见[编码](#编码u0000-和孤立的代理项)。
2. 键的字节数。
3. 值的字节数。
4. 摘要的字节数。
5. 版本号。对不上就返回 `current`。
6. 视图：这个 `ns` 的其它行，加上新的一行，用 `render` 渲染后量字节数。旧的那一行按版本号去掉。
7. 都通过了：按版本号删掉旧行，插入新行（`updated` 是 `put.now`），返回新的版本号。

- 键、值、摘要只看参数。先报它们，模型改小后直接重试，不用先合并一次再撞上限。
- 版本在视图之前：视图的大小取决于现在的值。版本对不上时，模型要先拿到最新值合并，合并后的大小才有意义。
- 旧行不算在内：在上限处用同样长的值覆盖，可以写。
- 被拒绝的写入不插入行，所以不用掉版本号。下一次成功的写入拿到最大值加一。

### 上限在哪里检查

在实现 `kv.ts` 的 `set` 里，不在工具层（`src/store/instore.ts`）。

- 只有实现渲染视图，只有实现知道总量。
- 在工具层检查，就要复制一份视图格式。同一个事实会有两个来源。
- 工具层只把 `{ over, bytes }` 翻译成文字。

### 视图的格式

```text
"城市" | 2026-11-18 | 6 B | "住在上海"
"项目.进度" | 2026-11-19 | 1824 B | "第一行摘要\n第二行"
```

- 每行一个键：`` `${JSON.stringify(key)} | ${utcDate(updated)} | ${bytes} B | ${JSON.stringify(brief)}` ``。
- `utcDate` 是 UTC 的 `YYYY-MM-DD`：`new Date(updated).toISOString().slice(0, 10)`。工具结果里也用它，在 `src/memory/kv.ts`：纯函数层不许建 `Date`，而内核里没有地方用它。
- `bytes` 是值的 UTF-8 字节数。从值算出来，不存：`kv.ts` 用 `length(CAST(value AS BLOB))` 读，不读值本体。
- 行之间用 `"\n"` 连接，末尾没有换行。
- 按键的 UTF-8 字节序排列：SQLite 的 `BINARY` 排序（`ORDER BY memory.key`）。
- 空库的视图是空串。
- 每行除了转义后的键和摘要，还固定有 4 个引号、三个 ` | `（9 字节）、10 字节的日期、` B`（2 字节），加上字节数的位数。最短的一行约 27 字节，加换行 28。
- `view()` 和 `set` 的视图检查用同一个 `render()`。量的就是给出去的。
- `memory_get` 给原值，不转义，还带摘要、更新日期和版本。

为什么这样写：

- `JSON.stringify` 转义全部 U+0000 到 U+001F 的控制字符、引号和反斜杠。所以一行永远是一个键。
- 键和摘要不需要字符规则。换行、竖线、冒号都可以有。
- 汉字不转义。代价只落在控制字符、引号和反斜杠上，例如 Windows 路径的 `\` 变成两个字节。
- 排序让同样的内容总是同样的文本，和写入顺序、版本号无关，也不依赖区域设置。
- 视图里没有值：它在每次请求里，是固定开销。值按需用 `memory_get` 取（[D81](kb-decisions.md#d81-记忆视图改成索引键更新日期字节数摘要)）。
- 字节数让模型估算展开一个值要花多少上下文；日期让它判断新旧。
- 日期用 UTC，不用本地时区：同样的库在任何机器上渲染出同样的文本。

### 临时的键（约定）

- 只对眼下这件事有用的内容，键以 `tmp.` 开头。长期的知识不用这个前缀（[D82](kb-decisions.md#d82-记忆不分级临时的键用-tmp-前缀)）。
- 这是约定，不是机制：内核不校验前缀，不按它做任何事，也不自动清理。
- 约定写在 `memory_set` 的描述里。模型看索引里的更新日期，自己删过期的。
- 要自动清理，由上层的定时脚本按前缀和 `updated` 选，用协议 `memory_write` 的 `delete` 删。

### `briefOf`

`briefOf(value, budget = MEMORY_BRIEF_MAX_BYTES)` 在 `src/kernel/derive.ts`：取值的前 `budget` 字节（缺省 `MEMORY_BRIEF_MAX_BYTES`），不切断字符。值不超过时原样返回。记忆里两处用它：协议 `memory_write` 的 `set` 没带 `brief` 时，和表结构升级（5 到 6）时给旧行填摘要（[kb-store](kb-store.md#表)）。模型写入时不走它：`memory_set` 的 `brief` 必填。

### 版本号

- `memory.version` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`。全库一个序列，不分 `ns`。
- 写入 = 按版本号删掉旧行，插入新行。新行的行号就是新的版本号。
- `AUTOINCREMENT` 不复用被删掉的最大编号。普通的整数主键会复用它。
- 所以没有 ABA：删掉一个键再重建，新版本号一定比旧的大。拿旧版本号写入一定失败。
- 同一个键的版本号不连续。不能从它推算写了几次。

### 编码：U+0000 和孤立的代理项

- `node:sqlite` 读 `TEXT` 列时，在 U+0000 处截断。写入和 `WHERE` 里的参数不截断。
- 所以 `kv.ts` 读键、值、摘要都用 `CAST(… AS BLOB)`，再按 UTF-8 解码。U+0000 原样存取。
- `node:sqlite` 把字符串里孤立的代理项存成替换字符 U+FFFD。
- `JSON.stringify` 却把孤立的代理项写成 6 字节的 `\ud800`。不先换的话，量的视图和存下的视图不是同一份文本。
- 所以 `set` 先对键、值、摘要 `toWellFormed()`，再量，再存。
- 结果：两个不同的孤立代理项是同一个键。
- `get` 和 `delete` 不先换。`node:sqlite` 绑定参数时同样换成替换字符，所以也能找到。这一条在 Node 24.14 和 24.22.1 上手动核实过，没有测试。
- 视图检查去掉旧行时，按版本号认，不按 JS 字符串比较键。读回的键曾因为上面两点和传入的键不一样，旧行被算了两次，在上限处覆盖失败。

## 决策

跨模块的决定见 [kb-decisions.md](kb-decisions.md)：

- D6：MVP 的记忆是带版本号的键值存储；长期方向。
- D18 第 4 条、D19：版本号是全库自增 ID，用 `AUTOINCREMENT`，写入 = 删旧行插新行。
- D18 第 20 条：只有一个总上限。D81 把它改成：整个库的索引不超过视图上限，视图永远是全部键。
- [D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)：第 4 步定下的上限、换段阈值和用量估算。
- [D80](kb-decisions.md#d80-记忆视图的上限从-16-kib-放到-32-kib)：视图上限 32 KiB。
- [D81](kb-decisions.md#d81-记忆视图改成索引键更新日期字节数摘要)：视图改成索引，加摘要和更新时间；改了 D18 第 20 条。
- [D82](kb-decisions.md#d82-记忆不分级临时的键用-tmp-前缀)：记忆不分级，临时的键用 `tmp.` 前缀。

模块内的决定：

| 决定 | 原因 |
|---|---|
| 上限在实现里检查 | 只有实现渲染视图、知道总量。工具层检查要复制视图格式 |
| 失败是结构化的 `{ over, bytes }`，不带原因文字 | 给模型看的文字只在工具层写一处 |
| 契约写进接口 | 换段阈值依赖视图有上界。换实现时不能丢 |
| 视图上限量渲染后的文本 | 模型看到的就是这份文本，转义也占 token |
| 键和值都写成 JSON 字符串 | 一行一个键，键不需要字符规则 |
| 按键的 UTF-8 字节序排列 | 确定，不依赖区域设置 |
| 先查键、值、摘要，再查版本，最后查视图 | 见[检查顺序](#set-的检查顺序) |
| 视图是索引，值只经 `memory_get` | 视图在每次请求里；库的容量不再被视图上限卡住（D81） |
| 摘要由模型每次写入时给，必填 | 值和摘要不分家；内核不自动截取（D81） |
| `kv.ts` 不读时钟，`now` 由调用方传 | 和 `Env.now` 一样；测试确定 |
| 视图和 `set` 的检查只读键、摘要、更新时间、值的字节数 | 不读值本体，读取量随条数涨，不随值的大小涨 |
| 按 `BLOB` 读，`set` 先 `toWellFormed()` | 存进去的和读出来的、量的和存的，都是同一份文本 |

放弃的：

- 在工具层检查上限、`Memory` 返回自由文本的原因：理由见上表前两行。
- 设计稿原来的视图格式 `key: value`，不转义：键或值里的换行和冒号加空格会让一行看起来像两个键。
- 视图里放值的前缀，或者放不放值由模型选：视图会重新随值变长，摘要也不再是模型决定的（D81）。

## 认知模型

记忆是一张表里按 `ns` 分开的键值对。每行有一个全库唯一、永不复用的版本号。

- 版本号就是行的身份。读到版本 v，写入时带上 v。v 还在，说明从读到现在没有人写过这个键。
- 视图是这个 `ns` 全部行的索引（键、更新日期、值的字节数、摘要）的确定渲染，大小有上界。值不在视图里。
- `set` 通过版本检查后，读这个 `ns` 全部行的索引字段，不读值本体。条数有上界，所以读取量也有上界。

判断一次修改是否越界：

- 不经过 `Memory` 接口读写记忆：越界。
- 新的写入路径绕过 `set` 的检查：越界，契约会破。
- 在工具层或纯函数层里另算一份视图大小：越界。
- 用 `UPDATE` 改原行，版本号不变：越界，冲突检测失效。
- 截断视图，或者只放一部分键：越界。视图永远是全部键的索引。
- 把值或值的前缀放回视图：越界。视图会重新随值变长，要看值走 `get`。
- `Memory` 的实现里 `await` 或开事务：越界（[kb-store 的坑点](kb-store.md#坑点)）。

## 投影与命令

- 记忆不进 `observe` 的投影。`self` 不显示记忆统计（设计稿的 [MVP 不做](../docs/design/mvp.md#mvp-不做)）。
- 记忆不加 CLI 命令。协议的 `memory`、`memory_write` 给上层用。
- Agent 用 `memory_get`、`memory_set`、`memory_edit`、`memory_delete` 访问记忆（[kb-store](kb-store.md#记忆工具)）。
- Agent 在系统提示词里看到开段时的视图（[kb-kernel](kb-kernel.md#函数)）。

## 入口

| 文件 | 内容 |
|---|---|
| `src/memory/kv.ts` | `sqliteMemory`：`render`、按 `BLOB` 读、`set` 的检查；`utcDate` |
| `src/kernel/types.ts` | `Memory`、`Versioned`，契约的注释 |
| `src/kernel/tools.ts` | 四个上限常量；`memory_set` 的描述引用它们 |
| `src/kernel/derive.ts` | `utf8Bytes`、`briefOf` |
| `src/store/instore.ts` | 记忆工具：把 `Memory` 的结果翻译成文字（[kb-store](kb-store.md#记忆工具)） |
| `src/store/inputs.ts` | `writeMemory`：整批一个事务（[kb-store](kb-store.md#存储事务)） |
| `test/memory/kv.test.ts` | 真库上的实现，见下 |
| `test/store/memory-write.test.ts` | `writeMemory`：整批回滚、顺序有关 |
| `test/kernel/context.test.ts` | `memory_set` 的描述引用四个上限，四个常量的值；记忆一节的标题 |
| `test/store/fixtures.ts` | `fakeMemory`：不检查上限，视图格式不是真的 |

`test/memory/kv.test.ts` 覆盖：

- 键、值、摘要、视图各自超出上限：确切的文字和 `{ over, bytes }`；库不变；版本号不前进。
- 边界：128 字节的键、4096 字节的值、200 字节的摘要可以写，各多 1 字节拒绝；视图正好 32768 字节可以写，多 1 字节拒绝。用满摘要的键先填到离上限不到一行，再补最后一行。
- 在上限处用同样长的值覆盖可以写。键里有 U+0000 或孤立的代理项时也一样。
- U+0000 原样存取；孤立的代理项按替换字符存。
- 视图的格式和排序：索引行里没有值，字节数是值的 UTF-8 字节数，日期是 `put.now` 的 UTC 日期；`memory_get` 给原值、摘要和更新时间。
- 值从 999 字节变成 1000 字节，索引行多 1 字节：上限处的检查按新行渲染。
- `briefOf`：短值原样，长值取前 200 字节（第二个参数能改这个预算），不切断多字节字符，不切断代理对。
- 检查顺序。
- `entries`：字节序（和 UTF-16 码元序不同的字符）、只给这个 ns、空库；`namespaces`：去重、按字节序、键删光后消失、空库；键、值、ns 里的 U+0000 不截断。
- 第 4 步的验收：两个进程写同一个键，后写的得到冲突和最新值，重试后成功；删掉再重建持有最大版本号的键，拿旧版本号写入失败。

只跑记忆测试：`node --test "test/memory/*.test.ts"`。完成门槛见 AGENTS.md。

## 坑点

- **假记忆库不是真的。** `fakeMemory` 不检查上限，视图格式也不是真实的。测试不要断言它的视图文本。上限和格式只在 `kv.test.ts` 里用真库测。
- **读 `TEXT` 列会丢掉 U+0000 之后的内容。** 新加的查询也要用 `CAST(… AS BLOB)` 读。验证：`kv.test.ts` 的 U+0000 用例。
- **不要按 JS 字符串比较键。** 找旧行用版本号。验证：`kv.test.ts` 在上限处覆盖含 U+0000 和孤立代理项的键。
- **`view()` 和视图检查必须用同一个 `render()`。** 两份格式会让契约悄悄失效。
- **上限只在写入时检查。** 改小常量后，已有的库可能超出。这时 `view` 照常给全部内容，契约被打破；`set` 只接受让视图回到上限以内的写入；`delete` 总能执行。
- **视图的大小和值无关。** 只和键、摘要、日期、字节数的位数有关。上限处改值，长度的位数变了，一行可能多 1 字节：检查按新行渲染，不会漏。
- **改大视图上限要看换段阈值。** 视图是新段固定开销的一部分。64K 窗口留给预设提示词的空间只有几 KB（[kb-kernel](kb-kernel.md#换段阈值)）。
- **`JSON.stringify` 不转义 U+2028、U+2029、U+0085。** 按 `"\n"` 拆行仍然不会错。

## 关联模块

- [kb-store.md](kb-store.md)：`memory` 表；处理输入的事务；记忆工具的参数、结果和文字。
- [kb-kernel.md](kb-kernel.md)：视图进系统提示词；开段时的快照；换段阈值。
- [kb-service.md](kb-service.md)：服务启动时建 `sqliteMemory`。
- [kb-decisions.md](kb-decisions.md)：D6、D18、D19、D22、D80、D81、D82。
