# 工具

`updated: 2026-11-15`

## 这个模块是干什么的

本模块是四个库外工具的实现：`read`、`write`、`edit`（`src/tools/files.ts`）和 `bash`（`src/tools/bash.ts`）。每个工具是一个异步函数：收到参数和工作目录，返回 `{ text, isError }`。

它负责：

- 解析路径，处理文件的编码和换行。
- 运行 bash 命令：找 shell、超时、中止、结束进程、限制输出。
- 把失败写成结果文本，不抛出。

它不负责：

- 工具描述：名称、参数、哪些预设有。那是 [kb-kernel](kb-kernel.md#工具描述)。
- 参数校验和按名字分派。那是执行器（[kb-executor](kb-executor.md#运行工具actionsts)）。
- 结果的统一裁剪。那是 `decide`（[kb-kernel](kb-kernel.md#决策)）。
- 库内工具 `memory_*` 和 `self`。见 [kb-store](kb-store.md#投影与命令)。
- 权限和沙箱。没有（[D7](kb-decisions.md#d7-第一版不做沙箱)）。

本页接管[设计稿第 10 节](../docs/design/mvp.md#10-工具)里 `read`、`write`、`edit`、`bash` 的细节和路径规则。

## 架构

### 接口

| 函数 | 参数（`?` 为可选） | 收中止信号 |
|---|---|---|
| `read(args, workdir)` | `path`、`offset?`、`limit?` | 否 |
| `write(args, workdir)` | `path`、`content` | 否 |
| `edit(args, workdir)` | `path`、`old`、`new`、`replaceAll?` | 否 |
| `bash(args, workdir, signal)` | `command`、`timeout?` | 是 |

- 都返回 `Promise<ToolResultContent>`，失败写成结果。
- 一个例外：`bash` 的命令含 NUL 字符时，`spawn` 同步抛出，promise 被拒绝。执行器把它变成 `工具执行失败：<信息>`（[kb-executor](kb-executor.md#失败怎样变成结果)）。
- `workdir` 是预设快照的工作目录，一定是绝对路径。
- 工具不读库，不写库，不知道进程。唯一的模块状态是 `bash.ts` 缓存的 shell 路径。

### 参数从哪来

执行器先用 pi-ai 的 `validateToolArguments` 校验，再调用工具（[kb-executor](kb-executor.md#运行工具actionsts)）。所以工具收到的参数类型都对，必填的都在，没有多余字段。校验会改写一些值：

- 可选参数是 `null` 时被删掉，等于省略。
- 必填的字符串是 `null` 时变成 `""`。数字和布尔值变成字符串。
- `"5"` 变成 `5`，`"true"` 变成 `true`。小数和非数字的字符串当整数时校验失败。
- 不校验取值范围。`offset`、`limit`、`timeout` 的范围由工具自己检查。

### 路径

- 用 `path.resolve(workdir, args.path)`。绝对路径原样用，相对路径按工作目录解析，`..` 照常生效。
- 不限制路径（[D14](kb-decisions.md#d14-yagni-审查移出-mvp-的-20-项)）。有 bash 就能绕过任何限制。
- 结果里写的是解析后的绝对路径。

### 编码和换行

- `read` 和 `edit` 只接受能无损往返的 UTF-8：按 UTF-8 解码，再编码回去，字节必须完全相同。否则拒绝，文件不动。
- 所以含中文的 GBK、带 BOM 的 UTF-16、含非法字节的文件都被拒绝。
- 只检查字节，不猜编码。不带 BOM、内容全是 ASCII 的 UTF-16 恰好是合法 UTF-8（每隔一个字节是 NUL），会被当成文本。
- UTF-8 BOM 解码成 U+FEFF，留在第 1 行开头。`edit` 写回时原样保留。
- `read` 去掉每行末尾的一个 `\r`。模型看到的行不带 `\r`。
- `write` 把 `content` 按 UTF-8 原样写出，不加 BOM，不改换行。

### `read`

1. 路径是目录就拒绝。
2. 读整个文件，检查编码。
3. 按 `\n` 分行。文件以 `\n` 结尾时，不多出一个空行。
4. 空文件回 `文件为空`，不算错误。
5. `offset` 默认 1，`limit` 默认读到末尾。任一小于 1 算错误。`offset` 超过行数时回总行数，不算错误。
6. 每行写成 `<行号，右对齐 6 位>\t<行>`，用 `\n` 连接，末尾没有换行。
7. 整段输出经 `clip` 截到 `MESSAGE_MAX_BYTES`，保留头尾（[kb-kernel](kb-kernel.md#常量)）。

- 没有自己的大小上限（[D19](kb-decisions.md#d19-第四轮审查fable-52-复审-d18-之后的文档)）。整个文件读进内存。
- 单行不截断。一行很长时，同样由 `clip` 保留整段输出的头尾。

### `write`

- 先递归建好父目录，再整体覆盖。
- 不是原子写：直接截断原文件再写，不经临时文件改名。

### `edit`

1. `old` 为空就拒绝。
2. 读文件，检查编码。
3. 用 `split(old)` 数出现次数。0 次失败。多于 1 次且没有 `replaceAll` 时失败。
4. 用 `join(new)` 写回。`new` 按字面插入，`$&`、`$1` 没有特殊含义。`replaceAll` 替换所有不重叠的出现。

文件含 `\r\n`、且 `old` 不含 `\r` 时，按 CRLF 文件处理：

- 原文找不到时，把 `old` 的 `\n` 换成 `\r\n`，再找一次。
- `new` 里前面不是 `\r` 的 `\n` 都换成 `\r\n`。原文第一次就找到时也换。
- 文件只要含一个 `\r\n` 就算 CRLF 文件，包括混合换行的文件。
- `old` 含 `\r` 时，原样匹配，原样写入。

### `bash`

#### 找 shell

- 只用 Git for Windows 的 `<根>\bin\bash.exe`。
- 在 `PATH` 里找含 `git.exe` 的目录 d，依次试 d、d 的上一级、上两级下的 `bin\bash.exe`。`git.exe` 可能在 `<根>\cmd`、`<根>\bin` 或 `<根>\mingw64\bin`。按 `PATH` 顺序取第一个存在的。
- 不用 System32 或 WindowsApps 里的 `bash.exe`。那是 WSL。
- 结果在服务进程里缓存。找不到也缓存。
- `<根>\bin\bash.exe` 是一个启动器。真正的 shell 是它的 Windows 子进程 `<根>\usr\bin\bash.exe`。`spawn` 拿到的 pid 是启动器的。
- 用 `-c`，不加 `-l`。`bin\bash.exe` 已把 `/mingw64/bin` 和 `/usr/bin` 放进 `PATH`。`-l` 每次多花约 0.8 秒。

#### 包装脚本

```text
spawn(<根>\bin\bash.exe, ["-c", WRAPPER])
  cwd = workdir；stdin 是空设备；stdout、stderr 是管道；不弹窗口
  env = 服务的全部环境变量 + TAU_PGID（pgid 文件路径）+ TAU_COMMAND（命令原文）
WRAPPER = echo $$ > "$TAU_PGID"; export -n TAU_PGID TAU_COMMAND; eval "$TAU_COMMAND"
```

- 命令经环境变量传入，不拼进命令行。反斜杠和引号原样到达 bash。直接用 `-c <命令>` 时，Windows 命令行会把 `\\` 压成 `\`。
- 先写 pgid 文件，再执行命令。`$$` 是 bash 的 msys pid，也是它的进程组号。
- `export -n` 之后，命令启动的子进程看不到这两个变量。命令自己的 shell 里仍能读到。
- bash 的退出码就是命令的退出码。命令里的 `exit N` 结束整个 bash。

`eval` 和直接 `-c` 可见的差别：

- 语法错误的前缀是 `eval: line N:`，不是 `-c: line N:`。
- `$BASH_EXECUTION_STRING` 是包装脚本，不是命令。
- `$TAU_COMMAND` 在命令里可读。

`shopt -s extglob` 只对后面的行生效，同一行里的 extglob 语法仍是语法错误。这一点和直接 `-c` 相同。

#### 超时和中止

- `timeout` 的单位是秒。省略时 120，超过 600 按 600。不是正数时报错，不运行。
- 调用前信号已中止：不运行。
- 超时或中止时结束进程（见“结束进程”）。等结束做完、bash 退出后才返回。结果是错误，已有的输出保留。
- bash 退出后不再理会超时和中止。

#### 输出

- stdout 和 stderr 按到达顺序进同一份输出。
- 内存里只留头尾各 `KEEP_BYTES` = `MESSAGE_MAX_BYTES / 2 - 256` 字节，中间只计数。巨量输出不占内存。
- 有省略时写成 `<头>\n…（中间省略 N 字节）…\n<尾>`，和 `clip` 的说明行同一格式。N 是丢掉的原始字节数。
- 按 UTF-8 解码。输出不为空且不以换行结尾时补一个换行，再接状态行 `[…]`。整段再经 `clip`。

#### 退出之后：排空和后台进程

- bash 退出后，最多再等 `DRAIN_MS` = 200 毫秒的 `close`，然后关掉管道返回。
- 原因：`sleep 100 &` 这样的后台进程继承了输出管道，`close` 要等它们全部结束。
- 正常退出时不结束后台进程。它继续运行，不归本工具管。它之后的输出丢失。msys 程序再写已关的管道时，因 SIGPIPE 退出。
- 原设计稿里的“没有后台任务”，在代码里就是这样：`&` 照常可用，但工具不跟踪，不收集之后的输出，以后也不结束它们。工具描述照实写：命令退出后，留在后台的进程不再归本工具管，它们之后的输出看不到。

#### 结束进程

超时或中止时 `killAll` 只运行一次。每一步失败都忽略：

1. 读 pgid 文件。读到空：bash 还没开始执行命令。
2. 运行 `<根>\usr\bin\ps.exe -l`。它的列是 `PID PPID PGID WINPID …`，行首可能有状态字母。取 PGID 等于 pgid 的行的 WINPID。
3. 对 `spawn` 的 pid 和这些 WINPID 一起运行 `taskkill /F /T`。
4. 再做一次第 2、3 步，不含 `spawn` 的 pid。这一遍结束其间 exec 出来的进程。

- 只靠 `taskkill /T` 不够。bash fork 出的子进程再 exec msys 程序时（如 `sleep 30; true` 里的 `sleep`），中间的 Windows 进程会退出，Windows 的父进程链断开。这些进程仍在 bash 的 msys 进程组里。
- 非交互的 bash 不开作业控制，`&` 启动的进程也在同一个组里。所以超时或中止时它们也被结束。
- 不用 msys 的 `kill -9`。信号发给 exec 到一半的进程会卡约 5 秒，其间别的组员照常运行。
- 会漏掉：用 `setsid` 离开进程组的进程；正好在结束那一刻创建的进程。
- 几个调用同时被结束时，`ps` 偶尔卡约 5 秒。调用晚返回。

#### pgid 文件

- 路径是 `os.tmpdir()\tau-bash-<uuid>.pgid`，每次调用一个。
- 调用返回之前删掉。删除失败也不管。
- 服务在调用中途崩溃时，文件留在临时目录。没有人清理。

### 结果文本

| 工具 | 情况 | 文本 | `isError` |
|---|---|---|---|
| `read` | 成功 | 带行号的行 | 否 |
| `read` | 空文件 | `文件为空：<路径>` | 否 |
| `read` | `offset` 超过行数 | `文件共 N 行，offset M 超出范围：<路径>` | 否 |
| `read` | 是目录 | `是目录，不能读取：<路径>` | 是 |
| `read` | 不是 UTF-8 | `不是 UTF-8 文本：<路径>` | 是 |
| `read` | `offset` 或 `limit` 小于 1 | `offset 和 limit 必须从 1 开始：<路径>` | 是 |
| `read` | 其它失败 | `读取失败：<路径>（<原因>）` | 是 |
| `write` | 成功 | `已写入 N 字节：<路径>`，N 是 UTF-8 字节数 | 否 |
| `write` | 失败 | `写入失败：<路径>（<原因>）` | 是 |
| `edit` | 成功 | `已替换 N 处：<路径>` | 否 |
| `edit` | `old` 为空 | `原文不能为空：<路径>` | 是 |
| `edit` | 不是 UTF-8 | `不是 UTF-8 文本，不能编辑：<路径>` | 是 |
| `edit` | 找不到 | `没找到原文：<路径>` | 是 |
| `edit` | 多处且没有 `replaceAll` | `原文出现 N 次，必须唯一，或改用 replaceAll：<路径>` | 是 |
| `edit` | 其它失败 | `编辑失败：<路径>（<原因>）` | 是 |
| `bash` | 退出 | `<输出>[退出码 N]` | N 不是 0 时 |
| `bash` | 超时 | `<输出>[超时：S 秒后结束了命令启动的进程]` | 是 |
| `bash` | 中止 | `<输出>[已中止，结束了命令启动的进程]` | 是 |
| `bash` | `timeout` 不是正数 | `timeout 必须是正数（秒）：<值>` | 是 |
| `bash` | 调用前已中止 | `已中止，命令没有运行` | 是 |
| `bash` | 找不到 shell | `需要 Git for Windows：PATH 上找不到 git.exe，也就找不到它的 bin\bash.exe` | 是 |
| `bash` | 启动失败 | `无法启动 bash（工作目录 <workdir>）：<信息>` | 是 |

- `<路径>` 是解析后的绝对路径。
- `<原因>`：`ENOENT` 写 `文件不存在`，`EISDIR` 写 `是目录`，其它用错误信息。
- `<输出>` 的写法见上面“输出”。没有输出时只有状态行。退出码为 `null` 时写 `-1`。
- 参数错误、工具不存在的文本由执行器给出（[kb-executor](kb-executor.md#运行工具actionsts)）。

## 决策

| 决定 | 原因 |
|---|---|
| 用 Git for Windows 的 `bin\bash.exe`，经 `PATH` 上的 `git.exe` 找到 | MVP 只支持 Windows；System32 和 WindowsApps 里的 `bash.exe` 是 WSL |
| `-c`，不加 `-l` | 每次省约 0.8 秒；`bin\bash.exe` 已设好 `PATH` |
| 命令经环境变量传入，在固定的包装脚本里 `eval` | 反斜杠原样保留；能先写 pgid 再执行命令 |
| 结束进程：msys 进程组加 `taskkill /F /T`，做两遍 | `taskkill /T` 漏掉 exec 断链的进程；msys 的 `kill -9` 会卡约 5 秒 |
| 正常退出时不结束后台进程，只排空 200 毫秒 | 否则调用要等后台进程结束才返回。工具描述写明后台进程不归它管 |
| 输出在内存里只留头尾 | 巨量输出不占内存；结果本来就要截到上限 |
| `read`、`edit` 拒绝非 UTF-8 文件 | `edit` 曾毁掉 GBK、UTF-16 文件（[D20](kb-decisions.md#d20-实现第-0-到-2-步时定下的事)） |
| `read` 去掉行尾 `\r`，`edit` 按 CRLF 重试并写回 CRLF | 多行 `edit` 在 CRLF 文件上曾永远匹配不到（D20） |
| `edit` 用 `split` 和 `join` | `new` 按字面插入，不受 `replace` 的 `$` 模式影响 |
| `read` 没有自己的大小上限 | 统一用工具结果的字节上限（D19） |
| 不限制路径 | 有 bash 就能绕过，是假边界（D14） |
| 失败写成结果，不抛出 | 模型看到原因能改正；执行器另有兜底（[kb-executor](kb-executor.md#失败怎样变成结果)） |

## 认知模型

- 一个工具 = 一个异步函数：参数加工作目录，变成一段文本和一个错误标记。
- 文件工具和模型的约定：`read` 给出的行，去掉行号和 `\t`，可以原样作为 `edit` 的 `old`。BOM 和 CRLF 的处理都是为了守住这一条。
- bash 的约定：
  - 调用返回时，bash 已经退出。
  - 超时或中止时，它的进程组和进程树已经尽力结束。
  - 正常退出时，后台进程照常运行。
- 一次修改越界的信号：
  - 工具里多了 shell 路径缓存以外的状态。
  - 工具读写库，或构造 `Input`。
  - 工具重试；或者跟踪后台进程，在以后结束它们。
  - 加路径限制、命令过滤这类能被 bash 绕过的边界。
  - 文件工具替模型转换编码。

## 投影与命令

- 工具不进投影，不加命令。
- Agent 能用哪些工具，由预设的 `tools` 决定（[kb-kernel](kb-kernel.md#工具描述)）。
- 有 bash 的进程能直接运行 `tau` 命令（[D9](kb-decisions.md#d9-自省同一份投影)）。

## 入口

| 路径 | 内容 |
|---|---|
| `src/tools/files.ts` | `read`、`write`、`edit` |
| `src/tools/bash.ts` | `bash`：找 shell、包装脚本、输出、`killAll` |
| `src/executor/actions.ts` | 校验参数，按名字调用工具（[kb-executor](kb-executor.md#运行工具actionsts)） |
| `src/kernel/tools.ts` | 给模型看的工具描述（[kb-kernel](kb-kernel.md#工具描述)） |
| `src/kernel/derive.ts` | `clip`、`MESSAGE_MAX_BYTES` |
| `test/tools/files.test.ts` | 文件工具 |
| `test/tools/bash.test.ts` | bash |

- 服务层用真工具的测试（`e2e`、`pairing`、`kill`）见 [kb-service 的服务测试](kb-service.md#服务测试testserver)。
- 命令：`npm test`。bash 的测试要求 `PATH` 上有 Git for Windows。

### 文件工具测试（`test/tools/files.test.ts`）

| 测试 | 证明 |
|---|---|
| `read` | 每行带行号；`offset`、`limit` 选范围；没有结尾换行时行数不变；CRLF 去掉 `\r`；空文件和 `offset` 越界不算错误；不存在、是目录算错误；相对路径按工作目录 |
| `write` | 建好多层目录，原样写出（含 `\r\n`）；覆盖已有文件；按字节计数；相对路径 |
| `edit` | 唯一时替换；找不到或多处时报错且文件不变；`replaceAll` 替换不重叠的出现；`$&`、`$1` 按字面；`old` 为空报错；文件不存在回错误不抛出；空白不归一；相对路径 |
| 编码和换行 | GBK、UTF-16LE 被拒绝且字节不变；BOM 保留；CRLF 文件上多行原文能匹配，写回全是 CRLF；单行原文、`new` 带 `\n` 也写 CRLF；CRLF 下多行原文出现两次仍要求唯一；LF 文件不受影响；约 20 万行的文件截到上限并保留首尾行 |

### bash 测试（`test/tools/bash.test.ts`）

| 测试 | 证明 |
|---|---|
| 基本 | 输出和退出码；`timeout` 超过 600 照常运行；非零退出码是错误；多行命令和 `set -e`；反斜杠和引号原样；子进程看不到 `TAU_` 变量；stderr 收进输出；补换行；在工作目录里运行 |
| 不运行 | `timeout` 不是正数；调用前已中止 |
| 超时 | 1 秒超时及时返回，是错误，pgid 文件已删 |
| 结束孙进程 | 超时和中止各两种孙进程：原生程序（`node`），以及 bash fork 后 exec 的 msys 程序（`sh -c`）。孙进程启动过，却没在 3 秒后写出 `done` |
| 巨量输出 | 约 500 万字节：结果不超上限；首尾标记都在；省略数加保留的字节数等于总数 |
| 后台进程 | `sleep 8 &` 不让调用挂住；pgid 文件已删 |

结束孙进程的测试：孙进程先写 `<名>-started`，3 秒后写 `<名>-done`。中止测试等孙进程启动后才中止。调用返回后再等 3.5 秒，`done` 没出现才算结束了。改 `killAll` 后必须跑这四个测试。

## 坑点

- **msys 路径。** 模型在 bash 里看到 `/e/tau/x`，交给 `read` 会解析成 `E:\e\tau\x`（工作目录所在盘）。结果里有解析后的路径，模型能发现。
- **`null` 参数被改写。** `edit` 的 `new` 为 `null` 时变成 `""`，等于删掉原文。`bash` 的 `command` 为 `null` 时什么都不跑，回 `[退出码 0]`。`path` 为 `null` 时指向工作目录本身。
- **写文件不是原子的。** 服务在 `write` 或 `edit` 写到一半时被杀，文件可能只剩一部分。重启后结果是“被中断”（[kb-executor](kb-executor.md#崩溃窗口)）。中止不影响文件工具，它们照样写完（[kb-executor](kb-executor.md#坑点)）。
- **`write` 不保留原文件的 BOM 和 CRLF。** 它只写模型给的内容。
- **bash 输出只按 UTF-8 解码。** Windows 原生程序按系统代码页输出时，非 ASCII 字符变成替换字符。头尾的切口也可能切开一个多字节字符。
- **bash 继承服务的全部环境变量。** 服务环境里的 API Key，命令都能读到。bash 和服务以同一个用户运行，所以也能读 pi 的凭据文件（[D23](kb-decisions.md#d23-凭据只读复用-pi-的凭据文件)）。这符合“没有沙箱”（D7）。
- **shell 路径缓存了“找不到”。** 服务启动之后才装 Git，要重启服务。
- **结束不了就不返回。** bash 启动之后，调用只在它的 `exit` 或 `close` 之后返回。`ps` 和 `taskkill` 没有超时。它们挂住，或者结束不了 bash 时，调用一直不返回。停止进程只让执行器丢弃结果（[kb-executor](kb-executor.md#控制流)）。
- **服务退出时不结束 bash。** 崩溃时没有人调用 `killAll`；正常退出也不中止动作（[kb-executor](kb-executor.md#崩溃窗口)）。手动核实过：硬杀运行 `bash()` 的 Node 进程后，`usr\bin\bash.exe`、原生孙进程和 msys 孙进程都继续运行到结束，pgid 文件留下。它们之后的输出无处可去。仓库里没有测试覆盖这一点（设计稿[风险](../docs/design/mvp.md#风险)）。
- **测试删工作目录要靠重试。** 结束 bash 的那一刻，正在 fork 或 exec 的 msys 进程会卡住约 5 秒。这期间它的当前目录句柄不允许删除，工作目录删不掉。启动完的 msys 进程不占目录。测试用 `rmSync` 加 `maxRetries` 等它。Node 24.21 之前，`rmSync` 在 Windows 上遇到这种占用不重试，立刻报 `EPERM`。所以 `package.json` 要求 Node 不低于 24.21。
- **`ps -l` 的格式。** Git 升级后列变了，组员就找不到，只剩 `taskkill /T`。原生孙进程在 Windows 父进程链上，照样被结束；两个 msys 孙进程的测试会失败。

## 关联模块

- [kb-kernel.md](kb-kernel.md)：工具描述、`clip` 和字节上限、结果在 `decide` 里的统一裁剪。
- [kb-executor.md](kb-executor.md)：参数校验、按名字分派、中止信号、失败怎样变成结果、崩溃后的“被中断”。
- [kb-store.md](kb-store.md)：库内工具 `memory_*` 和 `self` 的参数和结果。
- [kb-decisions.md](kb-decisions.md)：D7（不做沙箱）、D14（不限制路径）、D19（`read` 没有自己的上限）、D20（编码和 CRLF 的缺陷）、D21（shell 的选择，和原设计稿的差异）。
- [kb-service.md](kb-service.md)：服务层用真工具的测试；服务正常退出。
