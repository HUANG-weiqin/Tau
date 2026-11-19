# 工具

`updated: 2026-11-18`

## 这个模块是干什么的

本模块是库外工具的实现：`read`、`write`、`edit`（`src/tools/files.ts`）、`bash`（`src/tools/bash.ts`）和工具定义（`src/tools/tooldef.ts`）。每个工具是一个异步函数：收到参数和工作目录，返回 `{ content, isError }`，`content` 是内容块：`write`、`edit`、`bash` 只有一个文本块；`read` 读图片和工具定义的 `content` 输出可以有图片块。

它还负责工具定义的格式和读取（`src/presets/tooldefs.ts`，见[工具定义](#工具定义)）。

它负责：

- 解析路径，处理文件的编码和换行。
- 运行 bash 命令：找 shell、超时、中止、结束进程、限制输出。工具定义用同一套（`runCommand`）。
- 把失败写成结果文本，不抛出。

它不负责：

- 工具描述：名称、参数、哪些预设有。那是 [kb-kernel](kb-kernel.md#工具描述)。
- 参数校验和按名字分派。那是执行器（[kb-executor](kb-executor.md#运行工具actionsts)）。
- 结果的统一裁剪。那是 `decide`（[kb-kernel](kb-kernel.md#决策)）。
- 库内工具 `memory_*`、`self`、`handoff`、`post`、`spawn` 和 `stop_process`。见 [kb-store](kb-store.md#投影与命令)。
- 权限和沙箱。没有（[D7](kb-decisions.md#d7-第一版不做沙箱)）。

本页接管[设计稿第 10 节](../docs/design/mvp.md#10-工具)里 `read`、`write`、`edit`、`bash` 的细节和路径规则。

## 工具定义

“工具定义”专指 `~/.tau/tools/<name>.json`。请求里给模型看的叫“工具描述”（[kb-kernel](kb-kernel.md#工具描述)）。上层加工具只走它。格式、读取和大小上限是契约。运行规则见[运行工具定义](#运行工具定义)。

```json
{
  "description": "……",
  "parameters": { "type": "object", "properties": { }, "additionalProperties": false },
  "command": "node E:/tau/extras/notes/notes.mjs write",
  "timeout": 120,
  "output": "text"
}
```

| 字段 | 必填 | 规则 |
|---|---|---|
| 文件名 | — | 名字匹配 `^[A-Za-z0-9_-]{1,64}$`，按目录项精确匹配（大小写、8.3 短名都不行），和预设一样。开头的 BOM 忽略 |
| `description` | 是 | 字符串，空串可以 |
| `parameters` | 是 | 对象，`type` 是 `object`。只查顶层：顶层不是 `object` 时，有的 provider 会拒绝每一次请求。内层不查，pi-ai 也不查，原样转发：内层写错时，进程第一次调用模型就失败（出路见 [kb-contract 的风险表](kb-contract.md#风险表)） |
| `command` | 是 | 字符串 |
| `timeout` | 否 | 1 到 600 的整数，单位秒，默认 120 |
| `output` | 否 | `text` 或 `content`，默认 `text` |

- 别的字段、不是 JSON 对象、不是合法的 JSON，都报错。
- 名字不能和内置工具、工具组重名。名字表由 `toolsFor` 算出，不另写一份：`read`、`write`、`edit`、`bash`、`self`、`handoff`、`post`、`spawn`、`stop_process`、`memory_get`、`memory_set`、`memory_edit`、`memory_delete`，加 `memory`、`agents`。
- 大小上限，按 UTF-8 字节：一个定义的 `JSON.stringify({ description, parameters })` 不超过 `TOOL_DEF_MAX_BYTES`（16 KiB）；一个预设用到的全部定义，各自 `JSON.stringify(ToolDef)` 相加（含 `name`、`command` 和默认值）不超过 `TOOL_DEFS_MAX_BYTES`（64 KiB）。原因：定义存在 `state_json` 里，每条输入整行重写，`self` 和 `ps` 也要解析它；定义还占每次请求的上下文，启动检查要算上它（[kb-kernel](kb-kernel.md#启动检查和交接以后的检查)）。
- 函数：`loadToolDef(dir, name)` 读一个，`loadToolDefs(dir, names)` 按顺序读一组并查总大小，`toolsDir()` 是 `~/.tau/tools`。读不出一律抛错，错误信息是原因。
- 读取在 `loadPreset` 里：预设 `tools` 里不是内置工具和工具组的名字，都按工具定义读，读出的 `ToolDef` 存进会话快照的 `toolDefs`（[D43](kb-decisions.md#d43-第-7-步前一半工具定义的格式读取和冻结)）。之后不再读文件：改了定义文件，新出生的会话才用新的；已经在跑的会话要 `reconfigure` 带结构性字段（重新保存一次工具列表，手动刷新），在开段采用新快照时才变（[D71](kb-decisions.md#d71-会话配置reconfigure会话快照可改)）。读不出：`start` 回 `error`，`spawn` 是错误结果 `预设 <preset> 读不出：<原因>`，都什么都不建。
- 工具定义目录由服务传进来（`ServeOptions.toolsDir`，`main.ts` 用 `~/.tau/tools/`，测试用临时目录），目录不存在不要紧，只有预设用到定义时才读。
- 测试：运行见[工具定义测试](#工具定义测试testtoolstooldeftestts)。格式和读取：`test/presets/tooldefs.test.ts`（格式的每条规则、名字、重名、两个上限）、`test/presets/load.test.ts`（预设读定义）、`test/store/tooldefs.test.ts`（`start` 和 `spawn` 读进快照、读不出）、`test/store/launch.test.ts`（启动检查算上定义）、`test/server/protocol.test.ts`（`start` 回 `error`）。

### 运行工具定义

整节是契约（[kb-contract](kb-contract.md#契约清单)）。

- 参数先按 schema 校验（pi-ai 的 `validateToolArguments`），和内置工具一样。

运行：

- 工具定义都是库外工具，由执行器运行。
- 它走 bash 的整套机制：用 bash 运行 `command`，工作目录、超时、中止、结束进程树、输出上限、环境变量（5.3）都一样。
- 参数的 JSON 从标准输入给，写完就关。
- 命令不读标准输入就退出时，写入会报 `EPIPE`，要忽略它。标准输入的流上要有错误监听器，否则 Node 会按未捕获异常让服务退出。
- bash 工具不给标准输入，照旧是空设备。
- `output: text`：和 bash 一样。标准输出和标准错误合在一起是结果。退出码不是 0 就是错误。
- `output: content`：
  - 标准输出和标准错误分开收。
  - 退出码不是 0：结果是错误，文字和 `text` 时一样。
  - 退出码是 0：丢掉标准错误。标准输出必须是一个 JSON 数组，每项是 `{ "type": "text", "text": … }`、`{ "type": "image", "path": … }` 或 `{ "type": "call", "name": 字符串, "arguments"?: 对象 }`（见下面的“声明库内动作”）。
  - 先解析 JSON，按这个顺序检查：每一项的格式，`call` 的个数（不超过 `CALLS_PER_RESULT`，8），图片的张数（不超过 `IMAGES_PER_MESSAGE`）；再读图片文件。读之前先看大小，超过 `IMAGE_MAX_BYTES` 就不读。
  - `path` 只认 Windows 的绝对路径：盘符开头或 UNC。msys 的 `/tmp/x.png` 不认，和预设的 `workdir` 一样。
  - 文本项按顺序用换行连起来，成为结果的文本块。图片按[入口检查](kb-service.md#图片)检查，存进 `blobs`。
  - 不合法时，结果是错误：`content 输出不合法：<说明>`。不合法包括：标准输出超过上限被截断、不是合法 JSON、不是数组、项的格式不对、图片超过张数、`path` 不是 Windows 的绝对路径、文件读不出、图片不合格（5.6）、`call` 项的 `name` 不是字符串或 `arguments` 不是对象（包括数组和 `null`）、`call` 超过个数。
  - 声明库内动作（[D64](kb-decisions.md#d64-内核的自由度给上层事实对称的控制和可组合的动作)）：
    - `call` 项不进内容块。按顺序收进结果的 `calls`（`{ name, arguments }` 的数组）；`arguments` 省略时是 `{}`。没有 `call` 时，结果里没有 `calls` 这个键。
    - 格式不对、超过个数，整份输出不合法，不留任何声明。退出码不是 0、超时、中止、输出被截断时，也没有声明。`output: text` 的工具定义不解释 `call` 项。
    - `runToolDef` 只解析，不执行：`calls` 随结果交给执行器，原样放进结果的输入（[kb-executor](kb-executor.md#运行工具actionsts)），由 `handleNext` 在处理这条结果的事务里执行（[kb-store 的声明的库内动作](kb-store.md#声明的库内动作)）。
    - 工具里要寄信、建进程、停进程，用声明，不在命令里跑 `tau send`、`tau start`、`tau stop`：那样不原子，崩溃后重做会重复，`start` 建的进程也没有父进程。
- MCP 不进内核：上层的中转进程为每个 MCP 工具生成工具定义（[kb-extras](kb-extras.md#pi-web-的功能在-v2-上的做法)）。

事务和崩溃：和 bash 一样。被中断就报“被中断”，不重做。带图的 `content` 结果，图片在执行器上报结果的事务里插入 `blobs`（[kb-executor](kb-executor.md#失败怎样变成结果)、[kb-store 的图片](kb-store.md#图片)）。

实现和选定的细节（[D44](kb-decisions.md#d44-第-7-步后一半运行工具定义)）：

- `runToolDef(def, args, workdir, signal, ctx, accepts)` 在 `src/tools/tooldef.ts`。它调用 `bash.ts` 的 `runCommand({ command, seconds, stdin?, split? }, …)`，bash 工具调用的是同一个函数，所以超时、中止、结束进程树、输出上限、环境变量只有一份代码。`runCommand` 返回合并的结果，`split` 时另外给出标准输出的原文和“是否被截断”。`args` 是校验之后的参数，`stdin` 是它的 `JSON.stringify`。
- `timeout` 用定义的值（格式已查过 1 到 600 的整数）。
- 标准输出的上限就是 bash 的输出上限：内存里头尾各 `KEEP_BYTES`，合起来不到 32 KiB。超过就是“标准输出超过上限，被截断了”。
- 格式检查按顺序：先是数组，再逐项（`type` 是 `text` 且有字符串 `text`，或 `type` 是 `image` 且有字符串 `path`），再数图片，再查每个 `path`，最后读文件。项里多出的字段不管。
- 读文件：先 `stat`，不是文件或超过 `IMAGE_MAX_BYTES` 就不读；再 `readFile`；最后整批交给 `checkImages`（和协议同一个函数，张数、base64、大小、类型、尺寸）。说明里的“第 N 张”是图片的序号，不是数组的下标。读不出的写“图片文件读不出：<path>（<原因>）”。
- 结果：文本项用换行连成一个文本块，没有文本项就没有文本块；图片按顺序跟在后面，`data` 是 `blob:<hash>`，`mimeType` 是魔数算出的类型；字节放在返回值的 `images`，由执行器存。空数组是合法的，结果没有内容块。同一张图片出现两次是两个引用，一行 `blobs`。
- 进程的模型不收图片（快照的 `input` 不含 `image`）：检查照做，不合格仍是错误；合格时不存图片，每张图在原位置换成 `[图片：模型不支持，已省略]` 一行，和文本项一起用换行连成一个文本块。所以这种进程的段里永远没有图片，和信一样（[kb-store 的图片](kb-store.md#图片)）。
- `path` 可以用 `/` 或 `\` 分隔；`C:x.png`（盘符相对）、`\x.png`、`/e/x.png` 都不认。

## 架构

### 接口

| 函数 | 参数（`?` 为可选） | 收中止信号 |
|---|---|---|
| `read(args, workdir, accepts)` | `path`、`offset?`、`limit?`；`accepts`：进程的模型收图片（执行器传，和 `runToolDef` 的同名参数一个意思） | 否 |
| `write(args, workdir)` | `path`、`content` | 否 |
| `edit(args, workdir)` | `path`、`old`、`new`、`replaceAll?` | 否 |
| `bash(args, workdir, signal, ctx)` | `command`、`timeout?`；`ctx` 是 `{ process, pipe }`：进程 ID 和服务实际监听的管道名 | 是 |

- `write`、`edit`、`bash` 返回 `Promise<ToolResultContent>`，失败写成结果。`read` 和 `runToolDef(def, args, workdir, signal, ctx, accepts)` 返回 `ToolOutput`：`ToolResultContent` 加可选的 `images`（[运行工具定义](#运行工具定义)、[`read` 读图片](#read-读图片)）。
- 一个例外：`bash` 的命令含 NUL 字符时，`spawn` 同步抛出，promise 被拒绝。执行器把它变成 `工具执行失败：<信息>`（[kb-executor](kb-executor.md#失败怎样变成结果)）。
- `workdir` 是会话快照的工作目录，一定是绝对路径。
- 工具不读库，不写库。`bash` 只从执行器拿到进程 ID 和管道名，交给命令的环境，不用它们做别的。唯一的模块状态是 `bash.ts` 缓存的 shell 路径。

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

#### `read` 读图片

第 2 步读完文件后，先按魔数判断是不是图片（`imageType`，和协议、工具定义是同一个函数）。不是图片，照上面的 1 到 7 步，一点不变。是图片，就不走第 3 步以后（[D76](kb-decisions.md#d76-read-读图片)）：

1. 整个文件交给 `checkImages`（大小、类型、尺寸，和协议、工具定义同一个函数）。不合格是错误：`图片不合格：<路径>（<原因>）`。不缩放。
2. 进程的模型不收图片（`accepts` 为 false）：检查照做，合格时不存，结果是一行 `[图片：模型不支持，已省略]`（`IMAGE_UNSUPPORTED`），不算错误，没有 `images`。
3. 收图片：结果是一个图片块，`data` 是 `blob:<hash>`，`mimeType` 是魔数算出的类型；字节放在返回值的 `images`，由执行器存（和工具定义的 `content` 输出一样，[事务和崩溃](#运行工具定义)）。结果里没有文本块，路径模型自己知道。

- 看扩展名没有用：叫 `x.txt` 的 png 当图片读，叫 `x.png` 的文本当文本读。
- `offset`、`limit` 对图片不起作用，不检查。
- 图片块的写法只有一份：`tooldef.ts` 导出的 `imageBlock`，`read` 和工具定义共用。

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
  cwd = workdir；stdin 是空设备（工具定义：管道，写入参数的 JSON，写完就关）；stdout、stderr 是管道；不弹窗口
  env = 服务的环境变量（去掉 MSYS_NO_PATHCONV）+ TAU_PROCESS（进程 ID）+ TAU_PIPE（管道名）
        + TAU_PGID（pgid 文件路径）+ TAU_COMMAND（命令原文）
WRAPPER = echo $$ > "$TAU_PGID" || exit; export -n TAU_PGID TAU_COMMAND; eval "$TAU_COMMAND"
```

- 命令经环境变量传入，不拼进命令行。反斜杠和引号原样到达 bash。直接用 `-c <命令>` 时，Windows 命令行会把 `\\` 压成 `\`。
- 先写 pgid 文件，再执行命令。`$$` 是 bash 的 msys pid，也是它的进程组号。
- 写不进 pgid 文件（例如临时目录不存在）就不执行命令。bash 报错，退出码 1。否则超时或中止时，没人按进程组去找命令启动的 msys 进程。`LANG` 也可能让它写不进（见坑点“临时目录和 `LANG`”）。
- `export -n` 之后，命令启动的子进程看不到 `TAU_PGID` 和 `TAU_COMMAND`。命令自己的 shell 里仍能读到。
- `TAU_PROCESS` 和 `TAU_PIPE` 是给命令用的：命令里运行 `tau` 时，CLI 读 `TAU_PIPE` 连到这个服务，不连正式管道（[kb-service](kb-service.md#启动脚本和入口)）。它们不导出为 `-n`，子进程也看得到。服务环境里继承来的同名变量先去掉再设，所以命令看到的一定是这次的值。
- `MSYS_NO_PATHCONV` 去掉：`tau` 脚本为 `exec node` 设了它，会留在服务的环境里；不去掉，bash 的每条命令都不再转换路径（[kb-service 的坑点](kb-service.md#坑点)）。环境变量名在 Windows 上不分大小写，所以按大写比较。
- bash 的退出码就是命令的退出码。命令里的 `exit N` 结束整个 bash。

`eval` 和直接 `-c` 可见的差别：

- 语法错误的前缀是 `eval: line N:`，不是 `-c: line N:`。
- `$BASH_EXECUTION_STRING` 是包装脚本，不是命令。
- `$TAU_COMMAND` 在命令里可读。

`shopt -s extglob` 只对后面的行生效，同一行里的 extglob 语法仍是语法错误。这一点和直接 `-c` 相同。

#### 超时和中止

- `timeout` 的单位是秒。省略时 120，超过 600 按 600。不是正数时报错，不运行。
- 长命令别用 bash：超时就是失败，进程被结束，不会转到后台。要转到后台用工具库的 `shell` 或 `bg_run`（[kb-extras 的工具库](kb-extras.md#工具库)）。
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

1. 对 `spawn` 的 pid 运行 `taskkill /F /T`。启动器、bash 和还在 Windows 父进程链上的子孙一起结束。
2. 读 pgid 文件。读到空：bash 没开始执行命令，以后也不会了，到此为止。
3. 运行 `<根>\usr\bin\ps.exe -l`。它的列是 `PID PPID PGID WINPID …`，行首可能有状态字母。取 PGID 等于 pgid 的行的 WINPID。
4. 对这些 WINPID 运行 `taskkill /F /T`。
5. 再做一次第 3、4 步。这一遍结束其间 exec 出来的进程。

- 只靠 `taskkill /T` 不够。bash fork 出的子进程再 exec msys 程序时（如 `sleep 30; true` 里的 `sleep`），中间的 Windows 进程会退出，Windows 的父进程链断开。这些进程仍在 bash 的 msys 进程组里。
- 先结束 bash，再读 pgid 文件。这时 bash 已经没了，读到的不会再变。反过来不行：读到空以后、bash 被结束以前，bash 可能写下 pgid、启动命令。它 exec 出来的 msys 进程不在进程树上，又因为读到的是空，没人按进程组去找。bash 刚启动就被中止时，这样漏掉很常见。
- 还在父进程链上的子孙（例如 `node x & sleep 30` 里的 node）在第 1 步就结束了，不等 `ps`。
- 非交互的 bash 不开作业控制，`&` 启动的进程也在同一个组里。所以超时或中止时它们也被结束。
- 不用 msys 的 `kill -9`。信号发给 exec 到一半的进程会卡约 5 秒，其间别的组员照常运行。
- 会漏掉：
  - 用 `setsid` 离开进程组的进程。
  - 正好在结束那一刻创建的进程。bash 刚开始执行命令时被结束，最容易碰上，例如 bash 启动卡了约 5 秒，正好在那时超时或中止。任何顺序的 `taskkill` 和 `ps` 都避不开：
    - 原生进程：`taskkill /T` 先拍下进程树，再从叶子往上结束。拍下以后、创建它的进程被结束以前新建的进程，不在快照里。创建它的 msys 进程随后被结束，它也就不在 `ps` 里了。
    - msys 进程：创建它的进程在 fork 或 exec 途中被结束时，新进程有时卡在 msys 的启动里。它不在 `ps -l` 里。它不运行命令，也不占工作目录。约 5 分钟后它自己退出。实测在调用开始后 20 到 140 毫秒中止，约一成留下这样的 `sh`。
- `ps` 偶尔卡约 5 秒才运行（见坑点“msys 程序同时启动”）。msys 组员晚约 5 秒被结束，调用也晚返回。

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
| `read` | 图片，模型收图片 | 没有文本块，一个图片块（`blob:<hash>`），`images` 带字节 | 否 |
| `read` | 图片，模型不收图片 | `[图片：模型不支持，已省略]` | 否 |
| `read` | 图片不合格 | `图片不合格：<路径>（<原因>）` | 是 |
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
| 结束进程：先 `taskkill /F /T` bash 的进程树，再读 pgid，按 msys 进程组 `taskkill /F /T` 两遍 | `taskkill /T` 漏掉 exec 断链的进程；先读 pgid 会漏掉 bash 在结束途中启动的组员；msys 的 `kill -9` 会卡约 5 秒 |
| 正常退出时不结束后台进程，只排空 200 毫秒 | 否则调用要等后台进程结束才返回。工具描述写明后台进程不归它管 |
| 输出在内存里只留头尾 | 巨量输出不占内存；结果本来就要截到上限 |
| `read`、`edit` 拒绝非 UTF-8 文件 | `edit` 曾毁掉 GBK、UTF-16 文件（[D20](kb-decisions.md#d20-实现第-0-到-2-步时定下的事)） |
| `read` 去掉行尾 `\r`，`edit` 按 CRLF 重试并写回 CRLF | 多行 `edit` 在 CRLF 文件上曾永远匹配不到（D20） |
| `edit` 用 `split` 和 `join` | `new` 按字面插入，不受 `replace` 的 `$` 模式影响 |
| `read` 没有自己的大小上限 | 统一用工具结果的字节上限（D19） |
| 不限制路径 | 有 bash 就能绕过，是假边界（D14） |
| 失败写成结果，不抛出 | 模型看到原因能改正；执行器另有兜底（[kb-executor](kb-executor.md#失败怎样变成结果)） |

## 认知模型

- 一个工具 = 一个异步函数：参数加工作目录，变成内容块和一个错误标记。`write`、`edit`、`bash` 的内容块只有一段文本；`read` 读到图片文件时返回图片块（[D76](kb-decisions.md#d76-read-读图片)）；工具定义是 bash 加标准输入，`content` 输出还可以带图片。
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
| `src/tools/bash.ts` | `bash`、`runCommand`：找 shell、包装脚本、输出、`killAll` |
| `src/tools/tooldef.ts` | `runToolDef`：运行工具定义，解析 `content` 输出 |
| `src/executor/actions.ts` | 校验参数，按名字调用工具（[kb-executor](kb-executor.md#运行工具actionsts)） |
| `src/kernel/tools.ts` | 给模型看的工具描述（[kb-kernel](kb-kernel.md#工具描述)） |
| `src/kernel/derive.ts` | `clip`、`MESSAGE_MAX_BYTES` |
| `test/tools/files.test.ts` | 文件工具 |
| `test/tools/bash.test.ts` | bash |
| `test/tools/tooldef.test.ts` | 运行工具定义，用假命令 |

- 服务层用真工具的测试（`e2e`、`pairing`、`kill`）见 [kb-service 的服务测试](kb-service.md#服务测试testserver)。
- 命令：`npm test`。bash 的测试要求 `PATH` 上有 Git for Windows。

### 文件工具测试（`test/tools/files.test.ts`）

| 测试 | 证明 |
|---|---|
| `read` | 每行带行号；`offset`、`limit` 选范围；没有结尾换行时行数不变；CRLF 去掉 `\r`；空文件和 `offset` 越界不算错误；不存在、是目录算错误；相对路径按工作目录 |
| `read` 读图片 | png 读成图片块且 `images` 带原字节；模型不收图片时只有占位行、不存；超大、超尺寸报错（收不收图片都报）；看魔数不看扩展名（`x.txt` 里的 png 是图片，`x.png` 里的文本是文本）；非图片的二进制仍报“不是 UTF-8 文本” |
| `write` | 建好多层目录，原样写出（含 `\r\n`）；覆盖已有文件；按字节计数；相对路径 |
| `edit` | 唯一时替换；找不到或多处时报错且文件不变；`replaceAll` 替换不重叠的出现；`$&`、`$1` 按字面；`old` 为空报错；文件不存在回错误不抛出；空白不归一；相对路径 |
| 编码和换行 | GBK、UTF-16LE 被拒绝且字节不变；BOM 保留；CRLF 文件上多行原文能匹配，写回全是 CRLF；单行原文、`new` 带 `\n` 也写 CRLF；CRLF 下多行原文出现两次仍要求唯一；LF 文件不受影响；约 20 万行的文件截到上限并保留首尾行 |

### bash 测试（`test/tools/bash.test.ts`）

| 测试 | 证明 |
|---|---|
| 基本 | 输出和退出码；`timeout` 超过 600 照常运行；非零退出码是错误；多行命令和 `set -e`；反斜杠和引号原样；命令只看得到 `TAU_PROCESS`、`TAU_PIPE` 两个 `TAU_` 变量（传命令用的看不到；服务继承来的同名值被换掉）；服务的环境带 `MSYS_NO_PATHCONV` 时，命令看不到它，msys 路径照常转换；stderr 收进输出；补换行；在工作目录里运行 |
| 不运行 | `timeout` 不是正数；调用前已中止；pgid 文件写不进 |
| 超时 | 1 秒超时：远早于 60 秒的命令返回，是错误，pgid 文件已删。bash 启动卡住时没有超时前的输出，所以这里不要求有 `before` |
| 结束孙进程 | 超时和中止各两种孙进程：探针在 Windows 父进程链上（原生），或是 bash fork 后 exec 的 `sh` 的子进程（msys，只有按进程组才找得到）。探针启动过，后来断开。原生的超时测试还查超时前的输出保留，探针在第 8 到 15 秒之间断开 |
| 启动途中中止 | 中止时刻从 0 到 240 毫秒，每 20 毫秒一次，盖住 bash 的启动期（约 0.1 秒）。msys 版的探针一个都没留下 |
| 巨量输出 | 约 500 万字节：结果不超上限；首尾标记都在；省略数加保留的字节数等于总数 |
| 后台进程 | `sleep 30 &` 不让调用挂住：调用远早于 30 秒返回；pgid 文件已删 |

结束孙进程的测试用 node 探针当孙进程。测试把 `probe.cjs` 写进工作目录。探针连上测试的命名管道，报上名字，然后一直运行，只有被结束或连接被关掉才断开。连上就是启动了，断开就是进程没了。两件事都由操作系统通知，不靠等几秒再看：

- 中止测试等探针连上才中止。这时 bash 已经启动完，在等它。
- 超时设 8 秒，留出 bash 启动卡住的约 5 秒（见坑点“msys 程序同时启动”）。探针没在超时前连上，测试报“孙进程应该已经启动过”。
- 结束得慢不算错。没被结束的探针一直连着，测试到 30 秒失败。
- 例外是原生的超时测试。原生探针在 `killAll` 第 1 步的 `taskkill` 里结束，不等 `ps`，所以它断开的时刻就是超时的时刻。测试要求它在第 8 到 15 秒之间断开。计时器慢一倍时，测试失败。上限留了余量：审查时见过 `taskkill` 偶尔晚约 5 秒才动手。
- 启动途中中止的测试只用 msys 版：那一刻创建的原生进程本来就可能漏掉（见“结束进程”）。漏掉的 `sh` 在一两百毫秒内启动探针，测试最后等 1 秒再看。旧的顺序（先读 pgid 再结束 bash）几乎每次都漏掉几个。
- 那一刻 exec 到一半、卡在启动里的 `sh` 不启动探针，这个测试看不见（见“结束进程”）。
- 启动途中中止的测试限 90 秒。`killAll` 没结束启动器时，调用永远不返回，测试就挂住。

改 `killAll` 后必须跑这五个测试。

### 工具定义测试（`test/tools/tooldef.test.ts`）

命令都是假的：`cat`、`echo`、`sleep`、读一个测试写好的 JSON 文件；图片是只有文件头的假图片（`test/images.ts`）。

| 测试 | 证明 |
|---|---|
| 标准输入 | 参数的 JSON 从标准输入来，`cat` 读到结尾才退出；bash 工具仍是空设备 |
| 命令不读标准输入 | 400 万字节的参数，命令 `echo` 立刻退出：写入的 `EPIPE` 被忽略，测试进程没有退出（拿掉错误监听器，这个测试就失败） |
| 退出码、环境、超时、中止、输出上限 | 和 bash 一样：非零是错误且 stderr 合在输出里；`TAU_PROCESS`、`TAU_PIPE` 在，`MSYS_NO_PATHCONV` 不在；定义的 `timeout`；调用前和运行中中止；巨量输出只留头尾 |
| `content` 输出 | 文本项连成一个文本块，退出码 0 时丢掉 stderr；退出码不是 0 时和 `text` 的结果完全一样；超时的结果；空数组 |
| `content` 里的 `call` | 按顺序收进 `calls`、`arguments` 省略为 `{}`、只有 `call` 时内容为空、不收图片的模型照样有 `calls`；8 个合法 9 个不合法；`name` 不是字符串、`arguments` 是数组、`null`、字符串都整份不合法；检查顺序（格式、个数、图片张数）；退出码不是 0、超时、截断时没有声明；`text` 输出不解释 `call` |
| `content` 不合法 | 每一种：被截断、不是 JSON、空输出、不是数组、项不是对象、`type` 不认识和字段缺失或类型不对、图片超过张数（文件不存在也是这个原因：不读文件）、`path` 不是 Windows 的绝对路径（相对、msys、盘符相对、单斜杠）、文件不存在、是目录、UNC 路径读不出、超过 `IMAGE_MAX_BYTES`（不读）、类型不认识、尺寸超限、第二张不合格时说明里的序号、不收图片的模型同样检查 |
| 图片 | 引用、类型、字节在 `images` 里；只有图片没有文本块；同一张出现两次；`path` 用正斜杠；不收图片的模型在原位置换成说明，没有 `images` |

服务层：`test/server/protocol.test.ts` 的两个测试用真服务和真 bash 跑工具定义（参数走标准输入；图片进 `blobs`、模型收到 base64、库里是引用；不收图片的模型不存图片）。执行器层：`test/store/toolimages.test.ts` 和 `test/store/crash.test.ts` 的带图工具结果（[kb-executor](kb-executor.md#执行器测试teststoreexecutortestts)）。

## 坑点

- **msys 路径。** 模型在 bash 里看到 `/e/tau/x`，交给 `read` 会解析成 `E:\e\tau\x`（工作目录所在盘）。结果里有解析后的路径，模型能发现。
- **`null` 参数被改写。** `edit` 的 `new` 为 `null` 时变成 `""`，等于删掉原文。`bash` 的 `command` 为 `null` 时什么都不跑，回 `[退出码 0]`。`path` 为 `null` 时指向工作目录本身。
- **写文件不是原子的。** 服务在 `write` 或 `edit` 写到一半时被杀，文件可能只剩一部分。重启后结果是“被中断”（[kb-executor](kb-executor.md#崩溃窗口)）。中止不影响文件工具，它们照样写完（[kb-executor](kb-executor.md#坑点)）。
- **`write` 不保留原文件的 BOM 和 CRLF。** 它只写模型给的内容。
- **bash 输出只按 UTF-8 解码。** Windows 原生程序按系统代码页输出时，非 ASCII 字符变成替换字符。头尾的切口也可能切开一个多字节字符。
- **临时目录和 `LANG`。** msys 按 `LANG` 的字符集把 pgid 文件路径转成 Windows 路径。`LANG` 不设或是 UTF-8 时没问题。临时目录路径有非 ASCII 字符、`LANG` 又是别的字符集时，会出两种错，都实测过：
  - `zh_CN.GBK`：pgid 文件写不进。每条命令都不运行，结果是 bash 的报错和 `[退出码 1]`。
  - `ja_JP.SJIS`：文件写到乱码路径上，在临时目录的上一级。命令照常运行，但 pgid 读到空，超时或中止时不按进程组找。那个文件也没人删。
- **bash 继承服务的全部环境变量，`MSYS_NO_PATHCONV` 除外。** 服务环境里的 API Key，命令都能读到。bash 和服务以同一个用户运行，所以也能读 tau 的凭据文件 `~/.tau/auth.json`（[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。这符合“没有沙箱”（D7）。
- **shell 路径缓存了“找不到”。** 服务启动之后才装 Git，要重启服务。
- **结束不了就不返回。** bash 启动之后，调用只在它的 `exit` 或 `close` 之后返回。`ps` 和 `taskkill` 没有超时。它们挂住，或者结束不了 bash 时，调用一直不返回。停止进程只让执行器丢弃结果（[kb-executor](kb-executor.md#控制流)）。
- **服务退出时不结束 bash。** 崩溃时没有人调用 `killAll`；正常退出也不中止动作（[kb-executor](kb-executor.md#崩溃窗口)）。手动核实过：硬杀运行 `bash()` 的 Node 进程后，`usr\bin\bash.exe`、原生孙进程和 msys 孙进程都继续运行到结束，pgid 文件留下。它们之后的输出无处可去。仓库里没有测试覆盖这一点（设计稿[风险](../docs/design/mvp.md#风险)）。
- **`ps -l` 的格式。** Git 升级后列变了，组员就找不到，只剩 `taskkill /T`。原生孙进程在 Windows 父进程链上，照样被结束；msys 版的孙进程测试会失败。
- **msys 程序同时启动。** 两个 msys 程序（bash、`ps`、`sh`……）几乎同时启动时，其中一个偶尔要过约 5 秒才开始运行。单个启动、又没被打断时，没见过。在 Git for Windows 2.49（msys 运行时 3.5.7）上实测过两个 bash 同时启动。影响：
  - 超时从 `spawn` 算起，包括 bash 的启动。卡住时命令少跑约 5 秒。超时不到 5 秒的命令，可能一行都没跑就被结束。
  - `killAll` 的 `ps` 卡住时怎样，见“结束进程”。
  - 测试不能假设 bash 几秒内一定启动，也不能把调用的时长卡在几秒内（见上面的 bash 测试）。
- **测试删工作目录要靠重试。** 结束 bash 的那一刻，正在 fork 或 exec 的 msys 进程会卡住约 5 秒。这期间它的当前目录句柄不允许删除，工作目录删不掉。启动完的 msys 进程不占目录。“结束进程”里卡约 5 分钟的 `sh` 也不占目录。测试用 `rmSync` 加 `maxRetries` 等它。Node 24.21 之前，`rmSync` 在 Windows 上遇到这种占用不重试，立刻报 `EPERM`。所以 `package.json` 要求 Node 不低于 24.21。

## 关联模块

- [kb-kernel.md](kb-kernel.md)：工具描述、`clip` 和字节上限、结果在 `decide` 里的统一裁剪。
- [kb-executor.md](kb-executor.md)：参数校验、按名字分派、中止信号、失败怎样变成结果、崩溃后的“被中断”。
- [kb-store.md](kb-store.md)：库内工具 `memory_*`、`self`、`handoff`、`post`、`spawn` 和 `stop_process` 的参数和结果。
- [kb-decisions.md](kb-decisions.md)：D7（不做沙箱）、D14（不限制路径）、D19（`read` 没有自己的上限）、D20（编码和 CRLF 的缺陷）、D21（shell 的选择，和原设计稿的差异）。
- [kb-service.md](kb-service.md)：服务层用真工具的测试；服务正常退出。
