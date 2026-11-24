# 工具

`updated: 2026-11-20`

## 这个模块是干什么的

本模块是库外工具的实现：`read`、`write`、`edit`（`src/tools/files.ts`）、`bash`（`src/tools/bash.ts`）和工具定义（`src/tools/tooldef.ts`）。每个工具是一个异步函数：收到参数和工作目录，返回 `{ content, isError }`，`content` 是内容块：`write`、`edit`、`bash` 只有一个文本块；`read` 读图片和工具定义的 `content` 输出可以有图片块。

它还负责工具定义的格式和读取（`src/presets/tooldefs.ts`，见[工具定义](#工具定义)）。

它负责：

- 解析路径，处理文件的编码和换行。
- 运行 bash 命令：找 shell、先等一会儿没跑完就转后台、输出写文件、跑完寄信、中止时结束进程（D90）。工具定义的运行（`runCommand`）另走一条路：共用找 shell、结束进程和环境变量，超时就结束命令，用管道收输出。
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
- 它走 `runCommand`：用 bash 运行 `command`，工作目录、环境变量（5.3）、中止、结束进程树、输出上限和 bash 工具一样；超时到了就结束进程树，不转后台，输出走管道、不写文件。
- 参数的 JSON 从标准输入给，写完就关。
- 命令不读标准输入就退出时，写入会报 `EPIPE`，要忽略它。标准输入的流上要有错误监听器，否则 Node 会按未捕获异常让服务退出。
- bash 工具不给标准输入，照旧是空设备。
- `output: text`：标准输出和标准错误合在一起是结果，写法和 bash 一样（输出，加 `[退出码 N]`）。退出码不是 0 就是错误。
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

- `runToolDef(def, args, workdir, signal, ctx, accepts)` 在 `src/tools/tooldef.ts`。它调用 `bash.ts` 的 `runCommand({ command, seconds, stdin?, split? }, …)`。bash 工具是同一个文件里的另一个函数（`bash`），两条路径共用 `findShell`、`killAll`、`commandEnv`，不揉成一个带开关的函数。`runCommand` 返回合并的结果，`split` 时另外给出标准输出的原文和“是否被截断”。`args` 是校验之后的参数，`stdin` 是它的 `JSON.stringify`。
- `timeout` 用定义的值（格式已查过 1 到 600 的整数）。
- 标准输出的上限用 bash 同一个常量：内存里头尾各 `KEEP_BYTES`，合起来不到 32 KiB。超过就是“标准输出超过上限，被截断了”。
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
| `bash(args, workdir, signal, ctx)` | `command`、`timeout?`（最多等几秒）；`ctx` 是 `{ process, pipe, onData? }`：进程 ID 和服务实际监听的管道名；另收执行器的催的信号（D104） | 是（只在前台等待期间） |

- `write`、`edit`、`bash` 返回 `Promise<ToolResultContent>`，失败写成结果。`read` 和 `runToolDef(def, args, workdir, signal, ctx, accepts)` 返回 `ToolOutput`：`ToolResultContent` 加可选的 `images`（[运行工具定义](#运行工具定义)、[`read` 读图片](#read-读图片)）。
- 一个例外：工具定义的命令含 NUL 字符时，`spawn` 同步抛出，promise 被拒绝。执行器把它变成 `工具执行失败：<信息>`（[kb-executor](kb-executor.md#失败怎样变成结果)）。`bash` 不抛：同样的 `spawn` 错误写成结果 `无法启动 bash（工作目录 <workdir>）：<信息>`。
- `workdir` 是会话快照的工作目录，一定是绝对路径。
- 工具不读库，不写库。`bash` 从执行器拿到进程 ID 和管道名：交给命令的环境，进程 ID 还用来定输出目录。唯一的模块状态是 `bash.ts` 缓存的 shell 路径。

### 参数从哪来

执行器先用 `fixArgs`（`src/tools/args.ts`）修正，再用 pi-ai 的 `validateToolArguments` 校验，然后调用工具（[kb-executor](kb-executor.md#运行工具actionsts)）。库内工具（`runInStore`）同样先过 `fixArgs`，再用手写的检查（[kb-store](kb-store.md#记忆工具)）。所以工具收到的参数类型都对，必填的都在，没有多余字段。

`fixArgs` 做的事（只动 `null`、标量类型和字符串化的顶层容器）：

- 值为 `null` 的键不在 `required` 里：删掉，等于没填。
- 值为 `null` 的键在 `required` 里：错误结果 `参数 <名字> 是 null，必须给出一个值。` 不会再变成字符串 `"null"` 写进文件。
- 数字和布尔值写成字符串的按 schema 的类型转：`"5"` 转 `5`，`"true"` 转 `true`；字符串写成数字或布尔值，转成字符串；`array` 或 `object` 写成 JSON 字符串时按对应容器类型解析。转不了的留着，由校验报错（小数、非数字的字符串当整数时校验失败）。
- 别的键原样留着：库外工具由校验报错（`additionalProperties` 是 `false`），库内工具先查必填参数，再拒绝多余键（`handoff`、`self` 等无参工具也会拒绝多余键）。
- 不校验取值范围。`offset`、`limit`、`timeout` 的范围由工具自己检查。

### 路径

- 用 `path.resolve(workdir, args.path)`。绝对路径原样用，相对路径按工作目录解析，`..` 照常生效。
- 例外：开头是 `/<一个字母>/` 或恰好是 `/<一个字母>` 的，按 Git Bash 的盘符写法，当 `X:/…`（`/e/tau` 是 `E:\tau`）。不换的话 `path.resolve` 会把它当成当前盘根下的 `\e\tau`，悄悄读写到别处。其它 msys 路径（`/tmp`、`/usr`）不认。
- 例外：`~/…` 和恰好是 `~` 的，`~` 换成家目录（`os.homedir()`，正斜杠写法）。`~user` 不认。`/tmp`、`/home` 照旧按普通路径解析，不换成家目录。
- 三个路径工具走同一个解析函数（`resolvePath`），read、write、edit 都认上面两种写法。bash 工具的描述里写明了这两种写法（二选一，不要混成 `/c/C:/Users/x`），命令从工作目录开始运行、不用先 `cd`（[D106](kb-decisions.md#d106-使用反馈弱模型把盘符路径拼成-ddx)），以及 PowerShell 的命令要用 `powershell -NoProfile -Command` 调用。
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
2. 先看 `stat` 大小：超过 `IMAGE_MAX_BYTES` 时先读前 16 字节查魔数，是图片就直接报 `图片不合格`；否则超过 `READ_MAX_BYTES`（32 MiB）直接拒绝整份读入内存，提示改用 bash。
3. 读整个文件，检查编码。
4. 按 `\n` 分行。文件以 `\n` 结尾时，不多出一个空行。
5. 空文件回 `文件为空`，不算错误。
6. `offset` 默认 1，`limit` 默认读到末尾。任一小于 1 算错误。`offset` 超过行数时回总行数，不算错误。
7. 每行写成 `<行号，右对齐 6 位>\t<行>`，用 `\n` 连接，末尾没有换行。
8. 整段输出经 `clip` 截到 `MESSAGE_MAX_BYTES`，保留头尾（[kb-kernel](kb-kernel.md#常量)）。

- 文本读取受 `READ_MAX_BYTES`（32 MiB）保护，防止超大非文本/构建文件吃满堆内存。
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

bash 工具和工具定义各有一个包装脚本，都由 `bash.ts` 用 `spawn(<根>\bin\bash.exe, ["-c", 包装脚本])` 运行：

```text
bash 工具（BG_WRAPPER）
  cwd = workdir；stdin 是空设备；stdout、stderr 是同一个输出文件的句柄（不走管道）；不弹窗口
  env = 服务的环境变量（去掉 MSYS_NO_PATHCONV）+ TAU_PROCESS（进程 ID）+ TAU_PIPE（管道名）
        + TAU_PGID（pgid 文件路径）+ TAU_COMMAND（命令原文）
        + TAU_CLAIM（claim 文件）+ TAU_JOB（任务号）+ TAU_LOG（输出文件）+ TAU_NODE（node 的路径）+ TAU_NOTIFY（notify.ts 的路径）
  echo $$ > "$TAU_PGID" || exit
  export -n TAU_PGID TAU_COMMAND TAU_CLAIM TAU_JOB TAU_LOG TAU_NODE TAU_NOTIFY
  (eval "$TAU_COMMAND"); c=$?
  LC_ALL=C.UTF-8; set -C
  if ! { : > "$TAU_CLAIM"; } 2>/dev/null && [ -e "$TAU_CLAIM" ]; then
    rm -f "$TAU_PGID"; printf '\n[后台任务 %s] 退出码 %s\n' "$TAU_JOB" $c
    TAU_JOB="$TAU_JOB" TAU_LOG="$TAU_LOG" "$TAU_NODE" "$TAU_NOTIFY" $c
  fi
  exit $c

工具定义（WRAPPER，runCommand）
  stdin 是空设备（工具定义：管道，写入参数的 JSON，写完就关）；stdout、stderr 是管道
  env 同上，只有 TAU_PGID 和 TAU_COMMAND
  echo $$ > "$TAU_PGID" || exit; export -n TAU_PGID TAU_COMMAND; eval "$TAU_COMMAND"
```

- 命令经环境变量传入，不拼进命令行。反斜杠和引号原样到达 bash。直接用 `-c <命令>` 时，Windows 命令行会把 `\\` 压成 `\`。路径同理：`TAU_NODE`、`TAU_NOTIFY` 经环境变量传，不拼进脚本文本。
- 先写 pgid 文件，再执行命令。`$$` 是 bash 的 msys pid，也是它的进程组号。
- 写不进 pgid 文件（例如临时目录不存在）就不执行命令。bash 报错，退出码 1。否则中止时，没人按进程组去找命令启动的 msys 进程。`LANG` 也可能让它写不进（见坑点“临时目录和 `LANG`”）。
- `export -n` 之后，命令启动的子进程看不到这些变量。命令自己的 shell 里仍能读到。
- `TAU_PROCESS` 和 `TAU_PIPE` 是给命令用的：命令里运行 `tau` 时，CLI 读 `TAU_PIPE` 连到这个服务，不连正式管道（[kb-service](kb-service.md#启动脚本和入口)）。它们不导出为 `-n`，子进程也看得到；通知脚本靠它们寄信。服务环境里继承来的同名变量先去掉再设，所以命令看到的一定是这次的值。
- `MSYS_NO_PATHCONV` 去掉：`tau` 脚本为 `exec node` 设了它，会留在服务的环境里；不去掉，bash 的每条命令都不再转换路径（[kb-service 的坑点](kb-service.md#坑点)）。环境变量名在 Windows 上不分大小写，所以按大写比较。
- bash 的退出码就是命令的退出码。
- bash 工具的命令在子 shell 里 `eval`：命令里的 `exit N` 只结束子 shell，收尾照常走；`exec` 也不会让收尾丢掉。工具定义的命令直接 `eval`，`exit N` 结束整个 bash。
- 包装脚本里的中文用 `\x` 转义写（`printf` 输出 UTF-8 字节）：命令行里的非 ASCII 字符经 msys 按 `LANG` 转换，会走样。
- 任务号和输出文件路径经环境变量交给通知脚本（`TAU_JOB=… TAU_LOG=… node …`，前缀赋值只导出给这一条命令），不经命令行参数；退出码是纯数字，走参数。
- 非 UTF-8 的 `LANG`（`zh_CN.GBK`、`ja_JP.SJIS`）加含中文的 home：msys 收到的环境变量和参数是 UTF-8 字节，碰文件和再交给原生程序时却按那个字符集转，路径走样，claim 找不到、信丢了。实测只靠环境变量不够，连 `[ -e "$TAU_CLAIM" ]` 都失败。所以命令跑完、碰这些路径之前，脚本把自己的字符集换成 UTF-8：`LC_ALL=C.UTF-8`（不导出；命令在子 shell 里跑，早已跑完，看到的仍是服务的 `LANG`）。
- 输出文件用 `openSync(log, "w")` 打开，两个标准流共用这一个句柄：msys 写不了只追加（`"a"`）的句柄，`echo` 静默失败。所有写入者共用句柄，位置是共享的，不会互相覆盖。

`eval` 和直接 `-c` 可见的差别：

- 语法错误的前缀是 `eval: line N:`，不是 `-c: line N:`。
- `$BASH_EXECUTION_STRING` 是包装脚本，不是命令。
- `$TAU_COMMAND` 在命令里可读。

`shopt -s extglob` 只对后面的行生效，同一行里的 extglob 语法仍是语法错误。这一点和直接 `-c` 相同。

#### 等待、转后台和中止

- `timeout` 是“最多等多久”，单位秒。省略时 60，超过 600 按 600（不封顶的话，超过 2^31 毫秒的定时器会被 Node 改成 1 毫秒，命令一启动就转后台），0 是不等（立刻转后台）。负数、`NaN`、小数报参数错误，不运行：`timeout 必须是非负整数（秒）：<值>`。**不再因为超时而结束命令。**
- 调用前信号已中止：不运行。
- 命令在 `timeout` 秒内退出：照旧返回输出和退出码（“结果文本”）。
- 到时间还没退出：命令继续在后台运行，不被结束。工具立刻返回，不是错误（“结果文本”）。监听全部摘掉：之后的中止不再管它；对 `spawn` 的子进程 `unref`。
- 前台等待期间被催（[D104](kb-decisions.md#d104-bash-前台等待时有信排队最多再等-1-秒就转后台)）：进程有排队的信（纯函数 `hurried(p)`：阶段是 `awaitingTool` 且 `turn.queued` 不空）时，截止时间取开始时刻加 `timeout` 和催的时刻加 `HURRY_MS` = 1 秒里早的那个。到了截止时间还没退出，抢 claim，和到时间走同一条路；抢输了（命令正好跑完）照常返回。开始时进程就已有排队的信的，从开始时刻起算 1 秒。原来的截止时间更早到的，照到时间转后台，结果里没有“有新的信”那一行。正在结束进程（中止）时不再抢。
- 前台等待期间收到中止：结束进程（见“结束进程”），等结束做完、bash 退出后才返回。结果是错误，已有的输出保留。
- bash 退出后不再理会超时和中止。
- **谁来汇报只有一个赢家。** 输出文件旁边有一个 claim 文件 `<输出文件>.claim`，谁先建成谁赢，两边都是排他创建（`O_EXCL`），只有一个建得成。包装脚本在 `set -C`（noclobber）下 `: > claim`，bash 内建，不起进程，抢输了的错误信息丢掉；内核用 `openSync(claim, "wx")` 加 `closeSync`。用文件不用 `mkdir`：`mkdir` 是一个 msys 进程，每次约 0.1 秒：
  - 内核在到时间时先建成：转后台（先读结果，预览只补到结果读到的位置）。包装脚本在命令结束后建不成，确认文件存在（`[ -e ]`）后，删 pgid 文件，往输出文件追加一行 `\n[后台任务 <任务号>] 退出码 <N>\n`，再运行通知脚本，最后删掉 claim，以命令的退出码退出。
  - 包装脚本先建成（命令正好在这时结束）：脚本什么都不做，直接退出。内核得到 `EEXIST`，什么都不动，继续等 bash 退出，按正常结束返回。内核返回前删掉 claim。
  - 内核建 claim 因别的原因失败：当作脚本先抢到，继续等。
  - 正在结束进程（中止）时，到时间不再抢。
- 服务崩溃：前台那次由执行器报“被中断”（[kb-executor](kb-executor.md#崩溃窗口)）。包装脚本在命令结束后发现 claim 是自己建的，不寄信、不写退出码行。已经转后台的命令不受影响，跑完照常写退出码行、寄信；服务重启后信发给同一个进程 ID，进程还在就收到。

#### 输出文件

- 路径：`<home>\.tau\extras\shell\<进程 ID>\<毫秒时间>-<6 位十六进制随机>.log`，`home` 是 `os.homedir()`。目录不存在就建。文件名里的 6 位随机串是任务号。
- 这是内核唯一写进 `~/.tau/extras/` 的地方。文件不进库、不备份、7 天清理。
- 清理：每次调用顺手删 `shell/` 下 7 天前的文件和空了的进程目录（当前进程的目录不删）。claim 只在同名 log 已经没了才清：log 还在，命令可能还在跑，它的 claim 不能删（删了，脚本在命令结束后就建得成，不寄信）。反过来，**有 claim 的 log 也不清**：已经转后台、还没汇报的命令可能只是安静了 7 天（dev server、watcher），清掉 log，等它结束时就寄不出信了。包装脚本寄完信删掉 claim，之后 log 按 7 天清。每一步失败都忽略。
- stdout 和 stderr 从一开始就接到这个文件，按到达顺序合在一起。不走管道，内存里不存输出。
- 跑完（前台）：输出不超过 `2 * KEEP_BYTES`（`KEEP_BYTES` = `MESSAGE_MAX_BYTES / 2 - 256`）就整个读出来，删文件；超过就只读头尾各 `KEEP_BYTES`，文件留着。
- 实时预览（D88）：设了 `ctx.onData` 时，每 `POLL_MS` = 200 毫秒从上次读到的位置继续读，新增部分交给 `onData`；命令退出或转后台时，先读结果，再把预览补到结果读到的位置，预览和结果一字不差（命令在两次读之间多写的，两边都不要）；转后台以后不再推。每次读（轮询或最后那次）最多 `PUSH_MAX` = 1 MiB，剩下的留给下一次：写得快的命令不能让一次推送占住事件循环。最后那次读不完的部分预览里就没有了，结果以文件为准。

#### 退出之后：后台进程

- bash 退出就返回，不再等输出管道，所以不需要排空。工具定义的 `runCommand` 仍然用管道，仍然在 `exit` 后最多再等 `DRAIN_MS` = 200 毫秒的 `close`，然后关掉管道返回。
- 正常退出时不结束后台进程。`sleep 100 &` 这样的进程继续运行，它之后写的输出照样进输出文件（它继承了文件句柄）；文件如果已经被删，写入仍然成功，没人看得到。
- 工具描述照实写：没跑完的命令转后台，不会被结束，跑完寄信；等的时候来了新的信，最多再等 1 秒就转后台（D104）。

#### 通知脚本

`src/tools/notify.ts` 是 node 入口（`import.meta.main`），只用 node 内置模块，不导入别的文件。包装脚本在命令结束后运行它：`node notify.ts <退出码> [重试间隔毫秒]`，环境变量 `TAU_PROCESS`、`TAU_PIPE`（命令的环境里本来就有）和 `TAU_JOB`（任务号）、`TAU_LOG`（输出文件路径，脚本传过来的是盘符加正斜杠的写法）。

- 读输出文件最后 16 KiB，去掉开头被切开的残字符，取最后 20 行；超过 3000 字（UTF-16 单位）就留最后 3000 个并在前面加 `…`，切口落在代理对（emoji）中间时丢掉开头的半个，信里没有孤立代理项。
- 先去掉最后那一行脚本写的退出码行（只去最后一行，且完整匹配 `^\[后台任务 [0-9a-f]{6}\] 退出码 -?\d+$`），连同它前面脚本加的那个空行：信的第一行已经写了退出码，正文里不重复。别处的、格式不对的都留着。
- 信：`[后台任务 <任务号>] 退出码 <N>\nlog：<Windows 路径>\n<最后几行>`。
- 连命名管道，发一行 `{op:"send", process: TAU_PROCESS, text}`，收到回执就断开。
- 被拒绝（`error` 回复）：不重试，原因写到标准错误。没收到回执就断开了：信寄没寄出不知道，不重试，写到标准错误。只在连不上时重试：每 5 秒一次（第二个参数可改，测试用），最多 720 次，约 1 小时，之后在标准错误写“通知丢了”。
- 标准错误就是输出文件，所以这些说明跟在退出码行后面。

#### 结果文本

- 跑完：`<输出><补一个换行>[<说明行>]<[退出码 N]>`。输出不为空且不以换行结尾时补一个换行，再接状态行 `[退出码 N]`。整段经 `clip`。输出被截断时，头尾之间是 `\n…（中间省略 N 字节）…\n`（`clip` 的说明行同一格式，N 是丢掉的字节数），尾部之后、状态行之前多一行：`输出共 <总字节> 字节，只显示了头尾。完整输出在 <Windows 路径>，用 read 读（可带 offset 和 limit）。`
- 退出码不是 0 是错误。中止是错误，状态行是 `[已中止，结束了命令启动的进程]`。
- 转后台（不是错误）：`<已有输出，同样头尾截断><补一个换行>` 加固定的一段，第一行格式固定，第 2 阶段靠它解析：

```text
[转入后台 <任务号>] 命令还在运行，没有被结束。
输出文件：<Windows 路径>（还在增长，用 read 读，可带 offset 和 limit）
进程组号：<pgid>                                  ← pgid 文件读得到才有这一行
跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。
```

- 因为有信排队而提早转后台时（D104），在固定的一段前面多一行 `有新的信在排队，没等满 timeout 就转了后台。`，其余和到时间转后台一样。多的这一行放在固定的一段之外：`self.bgJobs` 和界面靠这一段原样认出后台任务，它一个字不变。
- 按 UTF-8 解码；头尾的切口可能切开一个多字节字符（见坑点）。

#### 结束进程

中止时（工具定义的 `runCommand` 还有超时时）`killAll` 只运行一次。每一步失败都忽略：

1. 对 `spawn` 的 pid 运行 `taskkill /F /T`。启动器、bash 和还在 Windows 父进程链上的子孙一起结束。
2. 读 pgid 文件。读到空：bash 没开始执行命令，以后也不会了，到此为止。
3. 运行 `<根>\usr\bin\ps.exe -l`。它的列是 `PID PPID PGID WINPID …`，行首可能有状态字母。取 PGID 等于 pgid 的行的 WINPID。
4. 对这些 WINPID 运行 `taskkill /F /T`。
5. 再做一次第 3、4 步。这一遍结束其间 exec 出来的进程。

- 只靠 `taskkill /T` 不够。bash fork 出的子进程再 exec msys 程序时（如 `sleep 30; true` 里的 `sleep`），中间的 Windows 进程会退出，Windows 的父进程链断开。这些进程仍在 bash 的 msys 进程组里。
- 先结束 bash，再读 pgid 文件。这时 bash 已经没了，读到的不会再变。反过来不行：读到空以后、bash 被结束以前，bash 可能写下 pgid、启动命令。它 exec 出来的 msys 进程不在进程树上，又因为读到的是空，没人按进程组去找。bash 刚启动就被中止时，这样漏掉很常见。
- 还在父进程链上的子孙（例如 `node x & sleep 30` 里的 node）在第 1 步就结束了，不等 `ps`。
- 非交互的 bash 不开作业控制，`&` 启动的进程也在同一个组里。所以中止时它们也被结束。
- 不用 msys 的 `kill -9`。信号发给 exec 到一半的进程会卡约 5 秒，其间别的组员照常运行。
- 会漏掉：
  - 用 `setsid` 离开进程组的进程。
  - 正好在结束那一刻创建的进程。bash 刚开始执行命令时被结束，最容易碰上，例如 bash 启动卡了约 5 秒，正好在那时超时或中止。任何顺序的 `taskkill` 和 `ps` 都避不开：
    - 原生进程：`taskkill /T` 先拍下进程树，再从叶子往上结束。拍下以后、创建它的进程被结束以前新建的进程，不在快照里。创建它的 msys 进程随后被结束，它也就不在 `ps` 里了。
    - msys 进程：创建它的进程在 fork 或 exec 途中被结束时，新进程有时卡在 msys 的启动里。它不在 `ps -l` 里。它不运行命令，也不占工作目录。约 5 分钟后它自己退出。实测在调用开始后 20 到 140 毫秒中止，约一成留下这样的 `sh`。
- `ps` 偶尔卡约 5 秒才运行（见坑点“msys 程序同时启动”）。msys 组员晚约 5 秒被结束，调用也晚返回。

#### pgid 文件

- 路径是 `os.tmpdir()\tau-bash-<uuid>.pgid`，每次调用一个。
- 调用返回之前删掉（bash 工具转后台时，由包装脚本在命令结束后删）。删除失败也不管。
- 服务在调用中途崩溃时，文件留在临时目录。没有人清理。
- bash 工具转后台以后，包装脚本在命令结束后删它（先于写退出码行）。

### 结果文本

| 工具 | 情况 | 文本 | `isError` |
|---|---|---|---|
| `read` | 成功 | 带行号的行 | 否 |
| `read` | 空文件 | `文件为空：<路径>` | 否 |
| `read` | `offset` 超过行数 | `文件共 N 行，offset M 超出范围：<路径>` | 否 |
| `read` | 是目录 | `是目录，不能读取：<路径>` | 是 |
| `read` | 不是 UTF-8 | `不是 UTF-8 文本：<路径>。可以用 bash 转码：iconv -f GBK -t UTF-8 原文件 > 新文件。` | 是 |
| `read` | 图片，模型收图片 | 没有文本块，一个图片块（`blob:<hash>`），`images` 带字节 | 否 |
| `read` | 图片，模型不收图片 | `[图片：模型不支持，已省略]` | 否 |
| `read` | 图片不合格 | `图片不合格：<路径>（<原因>）` | 是 |
| `read` | 超出读取保护上限（32 MiB） | `文件有 N 字节（上限 33554432 字节），不能整份读取：<路径>。可以用 bash 配合 wc -l、sed 或 rg 查看。` | 是 |
| `read` | `offset` 或 `limit` 小于 1 | `offset 和 limit 必须从 1 开始：<路径>` | 是 |
| `read` | 其它失败 | `读取失败：<路径>（<原因>）` | 是 |
| `write` | 成功 | `已写入 N 字节：<路径>`，N 是 UTF-8 字节数 | 否 |
| `write` | 失败 | `写入失败：<路径>（<原因>）` | 是 |
| `edit` | 成功 | `已替换 N 处：<路径>` | 否 |
| `edit` | `old` 为空 | `原文不能为空：<路径>` | 是 |
| `edit` | 不是 UTF-8 | `不是 UTF-8 文本，不能编辑：<路径>。可以用 bash 转码：iconv -f GBK -t UTF-8 原文件 > 新文件。` | 是 |
| `edit` | 找不到 | `没找到原文：<路径>。先用 read 看原文：空白、缩进、换行都要逐字一致。` | 是 |
| `edit` | 多处且没有 `replaceAll` | `原文出现 N 次，必须唯一，或改用 replaceAll：<路径>` | 是 |
| `edit` | 其它失败 | `编辑失败：<路径>（<原因>）` | 是 |
| `bash` | 退出 | `<输出>[退出码 N]` | N 不是 0 时 |
| `bash` | 转后台 | `<输出>`加固定的一段，第一行 `[转入后台 <任务号>] 命令还在运行，没有被结束。`（见上面“结果文本”）；因有信排队提早转的，固定的一段前多一行（D104） | 否 |
| `bash` | 中止 | `<输出>[已中止，结束了命令启动的进程]` | 是 |
| `bash` | `timeout` 不是非负整数 | `timeout 必须是非负整数（秒）：<值>` | 是 |
| `bash` | 建不了输出文件 | `无法建输出文件 <路径>：<信息>` | 是 |
| `bash` | 调用前已中止 | `已中止，命令没有运行` | 是 |
| `bash` | 找不到 shell | `需要 Git for Windows：PATH 上找不到 git.exe，也就找不到它的 bin\bash.exe` | 是 |
| `bash` | 启动失败 | `无法启动 bash（工作目录 <workdir>）：<信息>` | 是 |

- `<路径>` 是解析后的绝对路径。
- `<原因>`：`ENOENT` 写 `文件不存在`，`EISDIR` 写 `是目录`，其它用错误信息。
- `<输出>` 的写法见上面“输出文件”和“结果文本”。没有输出时只有状态行。退出码为 `null` 时写 `-1`。
- 参数错误、工具不存在的文本由执行器给出（[kb-executor](kb-executor.md#运行工具actionsts)）。

## 决策

| 决定 | 原因 |
|---|---|
| 用 Git for Windows 的 `bin\bash.exe`，经 `PATH` 上的 `git.exe` 找到 | MVP 只支持 Windows；System32 和 WindowsApps 里的 `bash.exe` 是 WSL |
| `-c`，不加 `-l` | 每次省约 0.8 秒；`bin\bash.exe` 已设好 `PATH` |
| 命令经环境变量传入，在固定的包装脚本里 `eval` | 反斜杠原样保留；能先写 pgid 再执行命令 |
| 结束进程：先 `taskkill /F /T` bash 的进程树，再读 pgid，按 msys 进程组 `taskkill /F /T` 两遍 | `taskkill /T` 漏掉 exec 断链的进程；先读 pgid 会漏掉 bash 在结束途中启动的组员；msys 的 `kill -9` 会卡约 5 秒 |
| 正常退出时不结束后台进程 | bash 退出就返回；输出在文件里，后台进程继续写也不拖住调用。工具定义的管道路径只排空 200 毫秒 |
| bash 先等、没跑完转后台，输出写文件，跑完寄信（D90） | agent 天天要跑长命令；以前超时就杀，上层的 `shell` 和它二选一，选错出过事（这两个工具现已退役） |
| 汇报的赢家靠排他创建 claim 文件 | 命令正好在到时间时结束，只能有一边汇报：要么前台正常返回，要么转后台寄一封信 |
| bash 的输出直接写文件，不走管道 | 转后台以后管道会关；文件让命令一直写下去，也让预览和 `read` 读得到 |
| 工具定义的输出在内存里只留头尾 | 巨量输出不占内存；结果本来就要截到上限 |
| `read`、`edit` 拒绝非 UTF-8 文件 | `edit` 曾毁掉 GBK、UTF-16 文件（[D20](kb-decisions.md#d20-实现第-0-到-2-步时定下的事)） |
| `read` 去掉行尾 `\r`，`edit` 按 CRLF 重试并写回 CRLF | 多行 `edit` 在 CRLF 文件上曾永远匹配不到（D20） |
| `edit` 用 `split` 和 `join` | `new` 按字面插入，不受 `replace` 的 `$` 模式影响 |
| `read` 限制整份读取上限 `READ_MAX_BYTES`（32 MiB） | 防止误读几百 MB 构建产物或库文件把堆内存吃满；单次输出仍用 `clip` 截到 `MESSAGE_MAX_BYTES` |
| 不限制路径 | 有 bash 就能绕过，是假边界（D14） |
| 失败写成结果，不抛出 | 模型看到原因能改正；执行器另有兜底（[kb-executor](kb-executor.md#失败怎样变成结果)） |

## 认知模型

- 一个工具 = 一个异步函数：参数加工作目录，变成内容块和一个错误标记。`write`、`edit`、`bash` 的内容块只有一段文本；`read` 读到图片文件时返回图片块（[D76](kb-decisions.md#d76-read-读图片)）；工具定义是 bash 加标准输入，`content` 输出还可以带图片。
- 文件工具和模型的约定：`read` 给出的行，去掉行号和 `\t`，可以原样作为 `edit` 的 `old`。BOM 和 CRLF 的处理都是为了守住这一条。
- bash 的约定：
  - 调用返回时，bash 已经退出，或者命令已经转后台（结果里写明）。
  - 前台等待期间中止时，它的进程组和进程树已经尽力结束。转后台以后中止不管它。
  - 到时间没跑完不结束命令：转后台，跑完寄一封信。
  - 正常退出时，后台进程照常运行。
- 一次修改越界的信号：
  - 工具里多了 shell 路径缓存以外的状态。
  - 工具读写库，或构造 `Input`。
  - 工具重试；或者跟踪后台进程，在以后结束它们。转后台的命令只靠 claim 和通知脚本汇报，内核不再看它。
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
| `src/tools/args.ts` | `fixArgs`：库内和库外工具共用的参数修正（`null`、标量类型） |
| `src/tools/bash.ts` | `bash`（先等、转后台、输出文件）、`runCommand`（工具定义用）：找 shell、包装脚本、输出、`killAll` |
| `src/tools/notify.ts` | 通知脚本：转后台的命令跑完后寄信 |
| `src/tools/tooldef.ts` | `runToolDef`：运行工具定义，解析 `content` 输出 |
| `src/executor/actions.ts` | 校验参数，按名字调用工具（[kb-executor](kb-executor.md#运行工具actionsts)） |
| `src/kernel/tools.ts` | 给模型看的工具描述（[kb-kernel](kb-kernel.md#工具描述)） |
| `src/kernel/derive.ts` | `clip`、`MESSAGE_MAX_BYTES` |
| `test/tools/files.test.ts` | 文件工具，含 msys 盘符和 `~` 的家目录展开 |
| `test/tools/args.test.ts` | `fixArgs` |
| `test/tools/bash.test.ts` | bash |
| `test/tools/tooldef.test.ts` | 运行工具定义，用假命令 |

- 服务层用真工具的测试（`e2e`、`pairing`、`kill`）见 [kb-service 的服务测试](kb-service.md#服务测试testserver)。
- 命令：`npm test`。bash 的测试要求 `PATH` 上有 Git for Windows。

### 文件工具测试（`test/tools/files.test.ts`）

| 测试 | 证明 |
|---|---|
| 路径 | `~/x` 和 `~` 展开成家目录，read、write、edit 都一样；`/tmp`、`/home`、`~user` 照旧按普通路径；msys 盘符见 `test/tools/files.test.ts` 的 `describe("msys drive paths")` |
| `read` | 每行带行号；`offset`、`limit` 选范围；没有结尾换行时行数不变；CRLF 去掉 `\r`；空文件和 `offset` 越界不算错误；不存在、是目录算错误；相对路径按工作目录 |
| `read` 读图片 | png 读成图片块且 `images` 带原字节；模型不收图片时只有占位行、不存；超大、超尺寸报错（收不收图片都报）；看魔数不看扩展名（`x.txt` 里的 png 是图片，`x.png` 里的文本是文本）；非图片的二进制仍报“不是 UTF-8 文本” |
| `write` | 建好多层目录，原样写出（含 `\r\n`）；覆盖已有文件；按字节计数；相对路径 |
| `edit` | 唯一时替换；找不到（错误里指向 `read` 逐字对照）或多处时报错且文件不变；`replaceAll` 替换不重叠的出现；`$&`、`$1` 按字面；`old` 为空报错；文件不存在回错误不抛出；空白不归一；相对路径 |
| 编码和换行 | GBK、UTF-16LE 被拒绝且字节不变、错误里带转码的命令；BOM 保留；CRLF 文件上多行原文能匹配，写回全是 CRLF；单行原文、`new` 带 `\n` 也写 CRLF；CRLF 下多行原文出现两次仍要求唯一；LF 文件不受影响；约 20 万行的文件截到上限并保留首尾行 |

### bash 测试（`test/tools/bash.test.ts`）

测试把 home 指到临时目录（`USERPROFILE`），输出文件写在那里；一个假的 tau 服务（命名管道）收通知脚本寄来的 `send`、回回执。

| 测试 | 证明 |
|---|---|
| 基本 | 输出和退出码；`timeout` 3000000（超过定时器上限）封顶到 600，`sleep 3` 等到跑完得 `[退出码 0]`；命令含 NUL 字符：结果是错误，不抛；非零退出码是错误；命令里的 `exit N` 退出码照旧；多行命令和 `set -e`；反斜杠和引号原样；命令只看得到 `TAU_PROCESS`、`TAU_PIPE` 两个 `TAU_` 变量（传命令用的和 claim、任务号这些都看不到；服务继承来的同名值被换掉）；服务的环境带 `MSYS_NO_PATHCONV` 时，命令看不到它，msys 路径照常转换；stderr 收进输出；补换行；在工作目录里运行。快命令跑完，输出文件和 claim 都没留下，也没有信 |
| 不运行 | `timeout` 是负数、`NaN`、小数；调用前已中止；pgid 文件写不进 |
| 转后台 | `timeout` 1、命令 `sleep 4`：远早于 4 秒返回，不是错误；第一行格式；输出文件在 `<home>\.tau\extras\shell\<进程 ID>\` 里；命令之后真的跑完，输出文件里有退出码行，信寄到了（头两行格式、`TAU_PROCESS` 对）；pgid 文件已删；信到了以后 claim 也删了，log 留着。退出码 5 的命令：信和退出码行都写 5。`timeout` 0 立刻转后台 |
| 催（D104） | 用 `ctx.hurry` 信号。等的时候被催：约 1 秒转后台，说明一行在固定的一段前面，完成信照常寄到。一开始就催过、命令快：两种结果都认（照常返回没有说明、不寄信；或者启动卡住超过 1 秒转了后台，有说明）；一开始就催过、命令慢（`sleep 3`）：约 1 秒转后台，有说明。`timeout` 0：立刻转后台，没有说明。原来的截止时间更早（`timeout` 1，催在 0.5 秒）：没有说明。正在结束进程时被催：照旧是中止的结果，进程被结束 |
| claim 竞态 | 20 次命令的时长跨过 `timeout`（`sleep` 0.40 到 0.97 秒）：每次要么正常返回、没有信，要么转后台、恰好一封信；信的任务号集合等于转后台的集合；正常返回的没留文件。这台机器上约一半一半 |
| 中止 | 原生和 msys 两种孙进程：探针启动过，后来断开。中止时刻从 0 到 240 毫秒，每 20 毫秒一次，盖住 bash 的启动期（约 0.1 秒），msys 版的探针一个都没留下。转后台以后中止不结束命令：探针一直连着，命令跑完，信里退出码是 0 |
| 输出 | 约 500 万字节：结果不超上限；首尾标记都在；省略数加保留的字节数等于总数；说明里的路径指向完整的文件。刚好 `2 * KEEP_BYTES`：整个回、删文件；多一个字节：头尾加路径、文件留着。转后台时已有的输出同样截头尾 |
| 清理 | 8 天前的文件被删；有 claim 的 log 不清（转后台、还没汇报，可能只是安静），claim 在同名 log 还在时也不清；没有 log 的旧 claim 删；文件删光的进程目录被删；新文件和当前进程的目录不动 |
| 预览 | 转后台前最后只补到结果读到的位置：命令每 60 毫秒左右写一行，预览收到的和结果里已有的输出一字不差（4 个并发；先等信到再断言，失败也不留还在跑的命令）；每次读最多 1 MiB（20 MiB 输出，在 `setImmediate` 之前交出去的字节数不超过 2 MiB：轮询和退出的回调可能落在同一轮事件循环） |
| LANG | `LANG=zh_CN.GBK`、home 含“家”：信照样寄到，log 路径原样 |
| 没有残留 | 文件末尾：本文件开始以后起的 `notify.ts` 进程都已退出（按创建时间找） |
| 后台进程 | `sleep 30 &` 不让调用挂住：调用远早于 30 秒返回；pgid 文件已删 |
| 通知脚本 | 服务没起时每隔一会儿重试，起来后寄出（只取最后 20 行；头和路径格式）；最后几行超过 3000 字时从中间截，尾部切开多字节字符时去掉残字，边界落在 emoji 中间时没有孤立代理项；最后一行完整匹配的退出码行被去掉，别处的、格式不对的留着；没收到回执就断开：不重试；被拒绝：不重试，原因在标准错误里 |

结束孙进程的测试用 node 探针当孙进程。测试把 `probe.cjs` 写进工作目录。探针连上测试的命名管道，报上名字，然后一直运行，只有被结束或连接被关掉才断开。连上就是启动了，断开就是进程没了。两件事都由操作系统通知，不靠等几秒再看：

- 中止测试等探针连上才中止。这时 bash 已经启动完，在等它。
- 结束得慢不算错。没被结束的探针一直连着，测试到 30 秒失败。
- 启动途中中止的测试只用 msys 版：那一刻创建的原生进程本来就可能漏掉（见“结束进程”）。漏掉的 `sh` 在一两百毫秒内启动探针，测试最后等 1 秒再看。旧的顺序（先读 pgid 再结束 bash）几乎每次都漏掉几个。
- 那一刻 exec 到一半、卡在启动里的 `sh` 不启动探针，这个测试看不见（见“结束进程”）。
- 启动途中中止的测试限 90 秒。`killAll` 没结束启动器时，调用永远不返回，测试就挂住。
- 转后台的测试都等信到了才结束：命令和通知脚本跑完，才能删临时目录。

改 `killAll` 后必须跑这里的中止测试和启动途中中止，以及 `test/tools/tooldef.test.ts` 的超时和中止（工具定义的超时仍然结束进程）。

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
- **`null` 参数。** 可选的 `null` 当没填；必填的 `null` 是错误结果（`参数 <名字> 是 null，必须给出一个值。`），不会变成字符串 `"null"` 写进文件。旧版会转成 `"null"`：`edit` 的 `new` 为 `null` 时等于写入 `null`，`write` 的 `content` 为 `null` 时写入 `null`。
- **写文件不是原子的。** 服务在 `write` 或 `edit` 写到一半时被杀，文件可能只剩一部分。重启后结果是“被中断”（[kb-executor](kb-executor.md#崩溃窗口)）。中止不影响文件工具，它们照样写完（[kb-executor](kb-executor.md#坑点)）。
- **`write` 不保留原文件的 BOM 和 CRLF。** 它只写模型给的内容。
- **bash 输出只按 UTF-8 解码。** Windows 原生程序按系统代码页输出时，非 ASCII 字符变成替换字符。头尾的切口也可能切开一个多字节字符。
- **临时目录和 `LANG`。** msys 按 `LANG` 的字符集把 pgid 文件路径转成 Windows 路径。`LANG` 不设或是 UTF-8 时没问题。临时目录路径有非 ASCII 字符、`LANG` 又是别的字符集时，会出两种错，都实测过：
  - `zh_CN.GBK`：pgid 文件写不进。每条命令都不运行，结果是 bash 的报错和 `[退出码 1]`。
  - `ja_JP.SJIS`：文件写到乱码路径上，在临时目录的上一级。命令照常运行，但 pgid 读到空，超时或中止时不按进程组找。那个文件也没人删。
- **bash 继承服务的全部环境变量，`MSYS_NO_PATHCONV` 除外。** 服务环境里的 API Key，命令都能读到。bash 和服务以同一个用户运行，所以也能读 tau 的凭据文件 `~/.tau/auth.json`（[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。这符合“没有沙箱”（D7）。
- **shell 路径缓存了“找不到”。** 服务启动之后才装 Git，要重启服务。
- **结束不了就不返回。** bash 启动之后，前台调用只在它的 `exit`（工具定义是 `exit` 加排空，或 `close`）之后返回；到时间转后台的调用除外。`ps` 和 `taskkill` 没有超时。它们挂住，或者结束不了 bash 时，调用一直不返回。停止进程只让执行器丢弃结果（[kb-executor](kb-executor.md#控制流)）。
- **包装脚本在抢 claim 之前被外部杀掉。** 命令里 `kill $$`、对它的进程组 `taskkill`、机器重启：这个任务永远没有完成信，输出文件里也没有退出码行，pgid 文件不会被删（和服务崩溃时前台那次留下的一样，在临时目录里）。
- **服务在 claim 之后、结果入库之前崩溃。** 内核已经抢到 claim、正要返回转后台的结果，服务就崩了：模型先看到“被中断”，命令跑完以后又收到这个任务的完成信。无害。
- **服务在前台等待期间崩溃。** 重启后模型只看到“被中断”，不知道输出文件在哪（结果没来得及返回路径）。命令跑完不寄信。以后项：工具开始前就把路径告诉模型。
- **服务退出时不结束 bash。** 崩溃时没有人调用 `killAll`；正常退出也不中止动作（[kb-executor](kb-executor.md#崩溃窗口)）。硬杀运行 `bash()` 的 Node 进程后，`usr\bin\bash.exe`、原生孙进程和 msys 孙进程都继续运行到结束，pgid 文件留下。输出本来就在文件里，不丢；前台那次调用重启后报“被中断”（命令之后跑完，包装脚本发现 claim 是自己抢到的，不寄信，也不写退出码行）。已经转后台的命令不受影响：跑完写退出码行，通知脚本连不上服务就每 5 秒重试，约 1 小时；服务停机更久，信丢了，退出码行还在输出文件里。机器重启后，后台命令没了，没有退出码行也没有信。仓库里没有测试覆盖硬杀（设计稿[风险](../docs/design/mvp.md#风险)）。
- **`ps -l` 的格式。** Git 升级后列变了，组员就找不到，只剩 `taskkill /T`。原生孙进程在 Windows 父进程链上，照样被结束；msys 版的孙进程测试会失败。
- **msys 程序同时启动。** 两个 msys 程序（bash、`ps`、`sh`……）几乎同时启动时，其中一个偶尔要过约 5 秒才开始运行。单个启动、又没被打断时，没见过。在 Git for Windows 2.49（msys 运行时 3.5.7）上实测过两个 bash 同时启动。影响：
  - 等待的时间从 `spawn` 算起，包括 bash 的启动。卡住时命令少跑约 5 秒。`timeout` 不到 5 秒的命令，可能一行都没跑就转后台了（工具定义的超时是结束进程，同理）。
  - `killAll` 的 `ps` 卡住时怎样，见“结束进程”。
  - 测试不能假设 bash 几秒内一定启动，也不能把调用的时长卡在几秒内（见上面的 bash 测试）。
- **测试删工作目录要靠重试。** 结束 bash 的那一刻，正在 fork 或 exec 的 msys 进程会卡住约 5 秒。这期间它的当前目录句柄不允许删除，工作目录删不掉。启动完的 msys 进程不占目录。“结束进程”里卡约 5 分钟的 `sh` 也不占目录。测试用 `rmSync` 加 `maxRetries` 等它。Node 24.21 之前，`rmSync` 在 Windows 上遇到这种占用不重试，立刻报 `EPERM`。所以 `package.json` 要求 Node 不低于 24.21。

## 关联模块

- [kb-kernel.md](kb-kernel.md)：工具描述、`clip` 和字节上限、结果在 `decide` 里的统一裁剪。
- [kb-executor.md](kb-executor.md)：参数校验、按名字分派、中止信号、失败怎样变成结果、崩溃后的“被中断”。
- [kb-store.md](kb-store.md)：库内工具 `memory_*`、`self`、`handoff`、`post`、`spawn` 和 `stop_process` 的参数和结果。
- [kb-decisions.md](kb-decisions.md)：D7（不做沙箱）、D14（不限制路径）、D19（统一输出上限）、D20（编码和 CRLF 的缺陷）、D21（shell 的选择，和原设计稿的差异）。
- [kb-service.md](kb-service.md)：服务层用真工具的测试；服务正常退出。
