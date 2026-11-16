# 记忆

`updated: 2026-11-16`

## 这个模块是干什么的

记忆是 `src/memory/kv.ts`：`Memory` 接口的 SQLite 实现。接口的类型在 `src/kernel/types.ts`，上限常量在 `src/kernel/tools.ts`。

它负责：

- `Memory` 接口的语义和契约。
- 谁有记忆库，`ns` 是什么。
- 三个上限、`set` 的检查顺序、在哪里检查。
- 视图的格式。
- 版本号的规则。
- 键和值的编码：U+0000、孤立的代理项。

它不负责：

- `memory` 表的结构和 `AUTOINCREMENT`：[kb-store.md](kb-store.md#表)。
- `memory_get`、`memory_set`、`memory_delete` 的参数、结果和文字，包括超出上限时的文字：[kb-store.md](kb-store.md#记忆工具)。
- 什么时候读视图、在哪个事务里执行：[kb-store.md](kb-store.md#处理一条输入读什么)。
- 视图怎样进系统提示词、开段时的快照 `segment.memoryView`：[kb-kernel.md](kb-kernel.md#函数)。
- 视图在换段阈值里占多少：[kb-kernel.md](kb-kernel.md#换段阈值)。
- 服务启动时建 `sqliteMemory`：[kb-service.md](kb-service.md#启动顺序)。

本页接管[设计稿](../docs/design/mvp.md)第 8.1 节和第 8.2 节的细节。长期方向（挂载、日志、整理）见 [D6](kb-decisions.md#d6-mvp-的记忆是带版本号的键值存储)。

## 架构

### 接口

`src/kernel/types.ts`：

```ts
interface Versioned { value: string; version: number }

interface Memory {
  view(ns: string): string;
  get(ns: string, key: string): Versioned | null;
  set(ns: string, key: string, value: string, expected: number | null):
    | { ok: true; version: number }
    | { ok: false; current: Versioned | null }
    | { ok: false; over: "key" | "value" | "view"; bytes: number };
  delete(ns: string, key: string, expected: number):
    { ok: true } | { ok: false; current: Versioned | null };
}
```

- 所有函数都是同步的，在存储的事务里执行。哪个事务调用它们，见 [kb-store](kb-store.md#处理一条输入读什么)。
- `ns` 参数的理由：一张表里存着多个库。
- `expected: null` 表示“这个键现在必须不存在”。`delete` 的 `expected` 必填。
- 版本对不上：返回 `current`，即现在的值和版本号。键不存在时是 `null`。工具层把它放进结果，由模型合并。
- 超出上限：`over` 说是哪一项超了。`bytes` 是那一项的 UTF-8 字节数；`view` 时是写入后整个视图的字节数。
- 失败不带原因文字。给模型看的文字由工具层写（[kb-store](kb-store.md#记忆工具)）。
- 被拒绝的 `set` 和 `delete` 不改库。
- 处理输入的事务只通过这个接口访问记忆。以后换成分层设计，只换实现。

契约，写在接口的注释里：

> `view(ns)` 的 UTF-8 字节数永远不超过 `MEMORY_VIEW_MAX_BYTES`；`set` 拒绝会超出的写入。

换段阈值的算术依赖这条契约。换实现时也要守住它。

### 谁有记忆库

- 预设 `tools` 含 `memory` 的进程有记忆库，`ns` 等于预设 ID。它有三个记忆工具。
- 不含 `memory` 时，没有记忆库和记忆工具。`Env.memoryView` 为空，处理输入不碰记忆。
- 同一个预设的进程共用一个库。并行写同一个键，靠版本号发现冲突。
- 视图是开段时的快照。要拿到现在的值和版本号，用 `memory_get`。
- 记忆变化不通知兄弟进程。

### 上限

| 常量 | 值 | 理由 |
|---|---|---|
| `MEMORY_KEY_MAX_BYTES` | 128 | 键是名字，不是内容。约 40 个汉字 |
| `MEMORY_VALUE_MAX_BYTES` | 4096 | 一个键是一条笔记，不是文档。一个键最多占视图约四分之一 |
| `MEMORY_VIEW_MAX_BYTES` | 16384 | 视图在每次模型请求里。按纯函数层的估算最多 8,192 token，约占 64K 窗口换段阈值的 29%、1M 窗口换段阈值的 1.1%；收图片的 64K 预设，阈值是 17,520，视图约占 47% |

- 都按 UTF-8 字节算（`utf8Bytes`）。
- 视图的上限量的是渲染后的视图文本，转义也算在内。不是键和值的字节数之和。
- 整个库不超过视图上限，所以视图永远是全部内容，不需要截断规则。
- `delete` 没有上限。
- 常量放在 `src/kernel/tools.ts`，因为 `memory_set` 的工具描述要引用它们。

### `set` 的检查顺序

1. 把键和值里孤立的代理项换成替换字符（`toWellFormed()`）。理由见[编码](#编码u0000-和孤立的代理项)。
2. 键的字节数。
3. 值的字节数。
4. 版本号。对不上就返回 `current`。
5. 视图：这个 `ns` 的其它行，加上新的一对，用 `render` 渲染后量字节数。旧的那一行按版本号去掉。
6. 都通过了：按版本号删掉旧行，插入新行，返回新的版本号。

- 键和值只看参数。先报它们，模型改小后直接重试，不用先合并一次再撞上限。
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
"城市": "上海"
"项目.进度": "第一行\n第二行"
```

- 每行一个键：`` `${JSON.stringify(key)}: ${JSON.stringify(value)}` ``。
- 行之间用 `"\n"` 连接，末尾没有换行。
- 按键的 UTF-8 字节序排列：SQLite 的 `BINARY` 排序（`ORDER BY memory.key`）。
- 空库的视图是空串。
- 每行比转义后的键和值多 6 字节：4 个引号、一个冒号、一个空格。行之间各 1 字节换行。
- `view()` 和 `set` 的视图检查用同一个 `render()`。量的就是给出去的。
- `memory_get` 给原值，不转义。

为什么这样写：

- `JSON.stringify` 转义全部 U+0000 到 U+001F 的控制字符、引号和反斜杠。所以一行永远是一个键。
- 键和值不需要字符规则。换行、冒号加空格都可以有。
- 汉字不转义。代价只落在控制字符、引号和反斜杠上，例如 Windows 路径的 `\` 变成两个字节。
- 排序让同样的内容总是同样的文本，和写入顺序、版本号无关，也不依赖区域设置。

### 版本号

- `memory.version` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`。全库一个序列，不分 `ns`。
- 写入 = 按版本号删掉旧行，插入新行。新行的行号就是新的版本号。
- `AUTOINCREMENT` 不复用被删掉的最大编号。普通的整数主键会复用它。
- 所以没有 ABA：删掉一个键再重建，新版本号一定比旧的大。拿旧版本号写入一定失败。
- 同一个键的版本号不连续。不能从它推算写了几次。

### 编码：U+0000 和孤立的代理项

- `node:sqlite` 读 `TEXT` 列时，在 U+0000 处截断。写入和 `WHERE` 里的参数不截断。
- 所以 `kv.ts` 读键和值都用 `CAST(… AS BLOB)`，再按 UTF-8 解码。U+0000 原样存取。
- `node:sqlite` 把字符串里孤立的代理项存成替换字符 U+FFFD。
- `JSON.stringify` 却把孤立的代理项写成 6 字节的 `\ud800`。不先换的话，量的视图和存下的视图不是同一份文本。
- 所以 `set` 先 `toWellFormed()`，再量，再存。
- 结果：两个不同的孤立代理项是同一个键。
- `get` 和 `delete` 不先换。`node:sqlite` 绑定参数时同样换成替换字符，所以也能找到。这一条在 Node 24.14 和 24.22.1 上手动核实过，没有测试。
- 视图检查去掉旧行时，按版本号认，不按 JS 字符串比较键。读回的键曾因为上面两点和传入的键不一样，旧行被算了两次，在上限处覆盖失败。

## 决策

跨模块的决定见 [kb-decisions.md](kb-decisions.md)：

- D6：MVP 的记忆是带版本号的键值存储；长期方向。
- D18 第 4 条、D19：版本号是全库自增 ID，用 `AUTOINCREMENT`，写入 = 删旧行插新行。
- D18 第 20 条：只有一个总上限，视图永远是全部内容。
- [D22](kb-decisions.md#d22-换段阈值用量估算和记忆上限)：第 4 步定下的上限、换段阈值和用量估算。

模块内的决定：

| 决定 | 原因 |
|---|---|
| 上限在实现里检查 | 只有实现渲染视图、知道总量。工具层检查要复制视图格式 |
| 失败是结构化的 `{ over, bytes }`，不带原因文字 | 给模型看的文字只在工具层写一处 |
| 契约写进接口 | 换段阈值依赖视图有上界。换实现时不能丢 |
| 视图上限量渲染后的文本 | 模型看到的就是这份文本，转义也占 token |
| 键和值都写成 JSON 字符串 | 一行一个键，键不需要字符规则 |
| 按键的 UTF-8 字节序排列 | 确定，不依赖区域设置 |
| 先查键和值，再查版本，最后查视图 | 见[检查顺序](#set-的检查顺序) |
| 按 `BLOB` 读，`set` 先 `toWellFormed()` | 存进去的和读出来的、量的和存的，都是同一份文本 |

放弃的：

- 在工具层检查上限、`Memory` 返回自由文本的原因：理由见上表前两行。
- 设计稿原来的视图格式 `key: value`，不转义：键或值里的换行和冒号加空格会让一行看起来像两个键。

## 认知模型

记忆是一张表里按 `ns` 分开的键值对。每行有一个全库唯一、永不复用的版本号。

- 版本号就是行的身份。读到版本 v，写入时带上 v。v 还在，说明从读到现在没有人写过这个键。
- 视图是这个 `ns` 全部行的确定渲染，大小有上界。
- `set` 通过版本检查后，读这个 `ns` 的全部行。视图有上界，所以读取量也有上界。

判断一次修改是否越界：

- 不经过 `Memory` 接口读写记忆：越界。
- 新的写入路径绕过 `set` 的检查：越界，契约会破。
- 在工具层或纯函数层里另算一份视图大小：越界。
- 用 `UPDATE` 改原行，版本号不变：越界，冲突检测失效。
- 截断视图，或者只放一部分键：越界。视图永远是全部内容。
- `Memory` 的实现里 `await` 或开事务：越界（[kb-store 的坑点](kb-store.md#坑点)）。

## 投影与命令

- 记忆不进 `observe` 的投影。`self` 不显示记忆统计（设计稿的 [MVP 不做](../docs/design/mvp.md#mvp-不做)）。
- 记忆不加 CLI 命令。
- Agent 用 `memory_get`、`memory_set`、`memory_delete` 访问记忆（[kb-store](kb-store.md#记忆工具)）。
- Agent 在系统提示词里看到开段时的视图（[kb-kernel](kb-kernel.md#函数)）。

## 入口

| 文件 | 内容 |
|---|---|
| `src/memory/kv.ts` | `sqliteMemory`：`render`、按 `BLOB` 读、`set` 的检查 |
| `src/kernel/types.ts` | `Memory`、`Versioned`，契约的注释 |
| `src/kernel/tools.ts` | 三个上限常量；`memory_set` 的描述引用它们 |
| `src/kernel/derive.ts` | `utf8Bytes` |
| `src/store/instore.ts` | 记忆工具：把 `Memory` 的结果翻译成文字（[kb-store](kb-store.md#记忆工具)） |
| `test/memory/kv.test.ts` | 真库上的实现，见下 |
| `test/kernel/context.test.ts` | `memory_set` 的描述引用三个上限，三个常量的值 |
| `test/store/fixtures.ts` | `fakeMemory`：不检查上限，视图格式不是真的 |

`test/memory/kv.test.ts` 覆盖：

- 键、值、视图各自超出上限：确切的文字和 `{ over, bytes }`；库不变；版本号不前进。
- 边界：128 字节的键、4096 字节的值可以写；视图正好 16384 字节可以写，16385 字节拒绝。
- 在上限处用同样长的值覆盖可以写。键里有 U+0000 或孤立的代理项时也一样。
- U+0000 原样存取；孤立的代理项按替换字符存。
- 视图的格式和排序；`memory_get` 给原值。
- 检查顺序。
- 第 4 步的验收：两个进程写同一个键，后写的得到冲突和最新值，重试后成功；删掉再重建持有最大版本号的键，拿旧版本号写入失败。

只跑记忆测试：`node --test "test/memory/*.test.ts"`。完成门槛见 AGENTS.md。

## 坑点

- **假记忆库不是真的。** `fakeMemory` 不检查上限，视图格式也不是真实的。测试不要断言它的视图文本。上限和格式只在 `kv.test.ts` 里用真库测。
- **读 `TEXT` 列会丢掉 U+0000 之后的内容。** 新加的查询也要用 `CAST(… AS BLOB)` 读。验证：`kv.test.ts` 的 U+0000 用例。
- **不要按 JS 字符串比较键。** 找旧行用版本号。验证：`kv.test.ts` 在上限处覆盖含 U+0000 和孤立代理项的键。
- **`view()` 和视图检查必须用同一个 `render()`。** 两份格式会让契约悄悄失效。
- **上限只在写入时检查。** 改小常量后，已有的库可能超出。这时 `view` 照常给全部内容，契约被打破；`set` 只接受让视图回到上限以内的写入；`delete` 总能执行。
- **改大视图上限要看换段阈值。** 视图是新段固定开销的一部分。64K 窗口留给预设提示词的空间只有几 KB（[kb-kernel](kb-kernel.md#换段阈值)）。
- **`JSON.stringify` 不转义 U+2028、U+2029、U+0085。** 按 `"\n"` 拆行仍然不会错。

## 关联模块

- [kb-store.md](kb-store.md)：`memory` 表；处理输入的事务；记忆工具的参数、结果和文字。
- [kb-kernel.md](kb-kernel.md)：视图进系统提示词；开段时的快照；换段阈值。
- [kb-service.md](kb-service.md)：服务启动时建 `sqliteMemory`。
- [kb-decisions.md](kb-decisions.md)：D6、D18、D19、D22。
