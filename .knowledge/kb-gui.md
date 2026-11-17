# 图形界面的实现

`updated: 2026-11-17`

## 这个模块是干什么的

图形界面（调度台）是上层建筑，代码在 `extras/gui/`。

本页负责：

- 界面的代码放在哪里，怎么启动。
- HTTP 桥的路由和接口。
- 界面数据文件的键。
- 页面的模块划分和数据流。
- 测试放在哪里，测什么。

本页不负责：

- 界面长什么样、每块数据从哪来：[界面设计稿](../docs/design/gui.md)。
- 桥要做的检查：[kb-extras](kb-extras.md#http-桥要做的检查)。
- 线协议：[kb-service](kb-service.md#线协议srcprotocolts)。
- 按什么顺序做：[界面执行清单](../docs/plan/gui-checklist.md)。

## 架构

### 文件

| 路径 | 内容 |
|---|---|
| `extras/package.json` | 上层的依赖，精确锁定（[D63](kb-decisions.md#d63-上层的依赖随便加)）。`@earendil-works/pi-ai` 和根目录同一个版本，桥只用它的公开函数读模型目录 |
| `extras/gui/bridge/main.ts` | 桥的入口，Node 直接运行 |
| `extras/gui/bridge/server.ts` | `createBridge`：检查和路由。测试用它在进程里起桥，可以换掉 git 和选文件夹 |
| `extras/gui/bridge/*.ts` | 其余各部分：`forward.ts` 转发，`static.ts` 静态文件，`presets.ts`（经 `check` 列预设，写、改和删预设文件）、`models.ts`（模型目录和 key 状态）、`git.ts`、`bg.ts`、`tools.ts`（列、装、删工具定义）、`state.ts`、`pick.ts`，`util.ts` 放公用的小函数 |
| `extras/gui/web/index.html` | 页面 |
| `extras/gui/web/lib/*.js` | 页面的纯逻辑。不碰 DOM，不发请求。文件头写 `// @ts-check`，类型用 JSDoc |
| `extras/gui/web/ui/*.js` | 组件 |
| `extras/gui/web/*.js` | 根组件、请求、连接 |
| `extras/gui/web/*.css` | 样式 |
| `extras/gui/start.ps1` | 起服务和桥，打开页面 |
| `test/extras/gui/*.test.ts` | 测试 |

页面的代码是浏览器直接加载的 `.js`，不转译。桥是 `.ts`，和 `src/` 一样只用可擦除的语法。

### 启动

- 桥：`node extras/gui/bridge/main.ts`。选项：
  - `--port`：默认 4317。只在 `127.0.0.1` 上监听。
  - `--home`：默认 `~/.tau`。测试用临时目录。
  - `--host`：额外认的 `Host` 名字，可以写多次，给 Tailscale 用。
  - 凭据文件 `~/.pi/agent/auth.json` 的路径是 `createBridge` 的选项 `authFile`，没有命令行参数；测试用临时文件。
- 管道：`TAU_PIPE` 有值就用它，否则用 `\\.\pipe\tau`，和 CLI 一样。
- `start.ps1`：管道不在就起服务，端口没人听就起桥，都和终端脱开，日志写进 `~/.tau/extras/gui/`。然后打开页面。不做开机自启。
- 从自己的终端运行 `start.ps1`。服务把自己的环境变量交给 Agent 的 bash，在别的程序（例如另一个 Agent 的会话）里起，会把那个程序的变量和令牌带进去。

### 路径

都在 `--home` 下：

| 路径 | 内容 |
|---|---|
| `presets/` | 预设 |
| `extras/gui/state.json` | 界面数据 |
| `extras/gui/*.log` | `start.ps1` 起的服务和桥的日志 |
| `extras/bg/<进程 ID>-<名字>.log` | 后台命令的 log（[配方](kb-extras.md#后台命令和完成通知的配方)） |

### GET 路由

| 路径 | 送什么 |
|---|---|
| `/` | `extras/gui/web/index.html` |
| `/web/<路径>` | `extras/gui/web/` 下的文件 |
| `/vendor/<包>/<路径>` | `extras/node_modules/<包>/` 下的文件。包只认 `preact`、`htm`、`@fontsource-variable/archivo`、`@fontsource-variable/jetbrains-mono`、`@fontsource-variable/noto-sans-sc`、`marked`、`dompurify` |

- 路径解析以后不许出对应的目录。找不到回 404。
- `Content-Type` 按扩展名定。
- `index.html` 里的 import map 是内联脚本。桥启动时算出它的 SHA-256，写进 `Content-Security-Policy` 的 `script-src`。其余见 [kb-extras 的检查](kb-extras.md#http-桥要做的检查)。

### POST 接口

请求的正文是 JSON 对象。出错回 4xx 或 5xx，正文 `{ "error": "<中文原因>" }`。

正文上限：`/api/tau` 是 32 MiB，因为图片是 base64；其余是 1 MiB。

| 路径 | 请求 | 回 |
|---|---|---|
| `/api/tau` | 一条协议请求 | 管道回的每一行原样分块写回，管道关闭就结束。浏览器断开，桥就断开管道。连不上管道回 503 |
| `/api/presets` | `{}` | `{ presets }`，见下。服务不在回 503 |
| `/api/presets/create` | `{ id, workdir, model, tools, thinking?, handoff?, options?, prompt, agentsMd? }` | `{ ok: true }`。文件已经存在回 409，不覆盖 |
| `/api/presets/update` | `{ id, model?, thinking?, tools?, handoff?, options?, prompt?, agentsMd? }` | `{ ok: true, preset }`，`preset` 是改完 `check` 读到的样子。见下 |
| `/api/agents-md` | `{ workdir }` | `{ exists, bytes? }`。工作目录要是存在的绝对路径，否则 400。表单靠它决定默认勾不勾 |
| `/api/models` | `{}` | `{ providers, auth }`，见下 |
| `/api/presets/delete` | `{ id }` | `{ ok: true }`。ID 的检查和新建一样；没有这个文件回 404。只删 `presets/<ID>.md`，记忆库不动。桥不查这个预设还有没有进程，由页面拦：连着服务、这次连上以后收到过进程表，才让删 |
| `/api/git` | `{ workdir, what, file? }` | 见下 |
| `/api/bg` | `{ processes }` | `{ logs }`，见下 |
| `/api/tools` | `{}` | `{ installed, library }`，见下 |
| `/api/tools/install` | `{ name, replace? }` | `{ ok: true, status }`。`name` 必须是工具库里的；同名文件已有且内容不同，没有 `replace` 回 409，不覆盖；内容一样直接成功。写 `<home>/tools/<name>.json`，先写临时文件再改名 |
| `/api/tools/remove` | `{ name }` | `{ ok: true }`。有预设的 `tools:` 一行用到它回 409，错误里写是哪些预设；没有这个文件回 404 |
| `/api/state` | `{ set? }` | `{ state }`。`set` 的每个顶层键覆盖进文件，再回整个文件 |
| `/api/pick-folder` | `{}` | `{ path }`，取消时是 `null`。同时只开一个对话框，第二个请求回 409 |

`/api/tau` 只查正文是带字符串 `op` 的对象，其余交给服务校验。

预设：

- 读预设不自己解析：列出 `presets/` 下的每个 `.md`，对每个文件名发一次 `check`（经管道，和 `/api/tau` 同一条管道）。读得出、能不能启动、错误文字都和 `start` 一致（[kb-service 的 `check`](kb-service.md#读记录和干跑inspectcheck)），预设以后加字段（例如 `options`）桥不用改。
- 每个预设回 `{ id, ok: true, workdir, model, tools, memory, prompt, agentsMd, thinking?, handoff?, options? }`。`prompt` 是改预设时要显示的提示词，只有用户写的部分，不含拼进来的 AGENTS.md 块。`agentsMd` 是块的状态，见[拼 AGENTS.md](#拼-agentsmd)。`tools` 是内置工具加工具定义的名字，`memory` 是 `tools` 里有没有 `memory`。读不出，或者读得出但此刻起不来（`check` 的 `error` 不是 `null`，例如窗口装不下），回 `{ id, ok: false, error }`，照样列出，`error` 是服务给的原文。
- 连不上服务回 503，不当成每个预设都读不出：页面连上以后再读。
- 新建时只写认识的字段，提示词写在第二个 `---` 后面。`thinking`、`handoff`（正整数）、`options`（对象，写成一行 JSON）有就写，没有不写。ID 只许字母、数字、`.`、`_`、`-`，工作目录必须是存在的绝对路径。模型、工具名只查格式，不查模型目录和工具定义：写出来的文件能不能用，由 `check` 说了算。
- 改预设只换收到的字段，别的行、顺序、换行符、BOM、提示词原样：
  - `thinking`、`handoff`、`options` 给 `null` 就删掉这一行；文件里没有的字段追加到头部末尾；`prompt` 给了才换整个正文。一个字段都没给回 400。
  - ID 和工作目录不能改：body 里的 `workdir` 被忽略。文件没有头部回 400，文件不存在回 404。
  - 写临时文件再改名，写完立刻发 `check`。读不出，或者 `check` 带回启动错误，就把旧文件按原字节改回去，回 422，`error` 是服务的原文；服务不在回 503，也改回去。
  - 一次只改一个预设，排队做。
  - 文件里本来就有的不认识的键照样保留，所以会被 `check` 拒绝，改回去。
- 删除只认 ID，检查和新建一样。桥不查这个预设有没有进程，也不查是不是总管的预设；这两条由页面拦（[设计稿 7.7](../docs/design/gui.md#77-删除)）。

模型目录和 key 状态（`models.ts`）：

- 目录：用 pi-ai 的 `getBuiltinProviders`、`getBuiltinModels`、`builtinProviders`（显示名）和 `getSupportedThinkingLevels`，桥第一次收到请求时算一次。只含有模型的供应商。
- `providers` 每项：`{ id, name, key, models }`。`models` 每项：`{ id, name, window, image, thinking }`，`thinking` 是支持的级别，已去掉预设不收的 `off`。
- `key` 每次请求现读 `authFile`，只看每个条目的供应商名和 `type`：`key`（`api_key`）、`oauth`（tau 不支持，当作没配）、`unreadable`（`api_key` 但 key 不是字符串、`!` 开头或含 `$`，和 `src/server/credentials.ts` 的规则一致）、`none`。key 的值不进回复、日志和错误文字。
- `auth` 是 `{ ok: true }`；文件读不出或不是 JSON 对象时是 `{ ok: false, error }`，`error` 是固定的中文，不带文件内容，这时每家都是 `none`。文件不存在算没配，`ok: true`。

git：

- 一律 `git --no-optional-locks -c core.fsmonitor=false -C <目录> …`，不经 shell，有超时。diff 另加 `--no-ext-diff` 和 `--no-textconv`，不跑仓库里配置的外部程序。
- 输出超过缓冲上限时：`diff` 截断并标 `truncated`；`status` 回 500，不解析半截输出。
- 工作目录必须是某个预设的 `workdir`（读法同上，经 `check`），或者界面数据 `folders` 里的文件夹。否则回 403。比较时不分大小写。
- `what`：
  - `status`：`{ repo, branch?, files }`。每个文件 `{ path, status, add, del }`，`status` 是 porcelain 的两个字母，`add`、`del` 来自 `diff --numstat HEAD`，拿不到时是 `null`。不是仓库时 `{ repo: false }`。
  - `diff`：`{ text, truncated }`。`file` 是 `status` 给的路径，相对仓库根，所以在仓库根上跑。未跟踪的文件用 `diff --no-index`，其余用 `diff HEAD -- <文件>`，还没有提交时退回 `diff --cached`。超过 256 KB 截断。
  - `log`：`{ commits }`，最近 30 个。每个 `{ hash, short, subject, author, time }`，`time` 是毫秒。
  - `branches`：`{ main, branches }`。主分支是 `main`，没有就 `master`，都没有是 `null`。每个分支 `{ name, current, ahead, behind, merged, add, del }`，和主分支比。

后台命令：

- 列出 `extras/bg/` 下以这些进程 ID 开头的 log。
- 每个回 `{ process, name, size, mtime, tail, exit }`。`tail` 是最后 8 KB。`exit` 取最后一行 `[后台任务 <名字>] 退出码 N` 的 N，没有是 `null`。

工具定义（`bridge/tools.ts`，工具库在 `extras/tools/`，做什么见 [kb-extras 的工具库](kb-extras.md#工具库)）：

- `installed`：`<home>/tools/*.json`，每个 `{ name, description?, params?, timeout?, output?, command?, error?, usedBy }`。`error` 是读不出的原因（不是合法的 JSON、不是对象）；`usedBy` 是 `tools:` 一行里写了它的预设 ID。桥直接读预设文件的头，不经服务，服务不在也能列。
- `library`：`extras/tools/catalog.ts` 的每一项，`{ name, description, params, timeout, output, command, status }`。`status` 是 `none`、`installed`、`differs`：把装在 `tools/` 里的内容和库里生成的定义逐项比较（键排序后），一样才是 `installed`。工具定义格式不许多余字段，没有别的办法认出是库装的。
- 写进文件的 `command` 里是仓库的绝对路径（正斜杠，由桥文件的位置推出）。库的位置含引号、`$` 或反引号时拒绝安装。

### 拼 AGENTS.md

D58：项目的上下文由上层拼。界面把 `<工作目录>/AGENTS.md` 拼进预设提示词的末尾，只认这个文件名，不认 CLAUDE.md。代码在 `bridge/agentsmd.ts`，`presets.ts` 调它。

- 块的格式：前后各一行标记，中间是文件的各行（换行统一，去掉末尾的空行）。块前面空一行。

  ```text
  <!-- tau-gui:agents-md begin | 这一段由界面从 AGENTS.md 拼进来，别手改 | <工作目录>\AGENTS.md -->
  …AGENTS.md 的内容…
  <!-- tau-gui:agents-md end -->
  ```

- 起始行以 `<!-- tau-gui:agents-md begin` 开头，后面的说明和路径随便；结束行是固定的整行。有起始没有结束，当没有块：不替用户删不认识的字。文件里有以 `<!-- tau-gui:agents-md` 开头的行、或者文件是空的，拒绝拼（400）。
- `create`、`update` 的 `agentsMd`：`true` 现读文件，没有文件回 400，什么都不写；`false` 去掉块；不传不动。给了 `prompt` 但没给 `agentsMd` 时，块留着，只换用户的部分。每次保存都重新读文件，所以拼进去的总是最新的。
- 加块只在用户写的字后面接一个空行和块，去块只去掉那一个空行和块：用户手写的部分，包括末尾的空行，一字不动。块已经在时，换块在原处。
- `update` 从预设文件头部的 `workdir` 找文件。拼完超过窗口，`check` 报错，照现有逻辑改回旧文件，回 422 和原文。内核没有提示词的字节上限，只有窗口装不装得下。
- 列表里的 `agentsMd`：`none` 没有块；`fresh` 块和文件现在一致；`stale` 文件改过了；`missing` 有块但文件没了。
- 页面：`ui/presetform.js` 的勾选（`AgentsMdField`）。新建时文件在就默认勾上（靠 `/api/agents-md`）。改预设时，勾选和现在的块不一样才发 `agentsMd`；块过期了，选了“保存时重新拼”也发。项目概况里 `stale` 的预设行有“重新拼”，只发 `agentsMd: true`；窗口回到前台时重读预设，所以在编辑器里改了 AGENTS.md 会冒出标记。

### 界面数据

`~/.tau/extras/gui/state.json`。桥只查它是 JSON 对象，上限 1 MiB。写的时候先写临时文件再改名，多个写入排队做。文件坏了回 500，不覆盖。键由页面定：

| 键 | 内容 |
|---|---|
| `chief` | 总管的预设 ID |
| `names` | 预设 ID → 显示名 |
| `current` | 预设 ID → 当前进程 ID |
| `folders` | 打开过的项目文件夹 |
| `pinned` | 钉住的项目文件夹，按顺序 |
| `short` | 项目文件夹 → 简称 |
| `mine` | 界面建的进程 ID |
| `forkedFrom` | 界面分叉出的进程 ID → 源进程 ID |
| `titles` | 进程 ID → 标题 |
| `collapsed` | 折叠状态 |
| `cleanDays` | 清理的天数，默认 7 |
| `recentModels` | 最近用过的模型（`<供应商>/<模型 ID>`），最新在前，最多 6 个 |
| `defaultModel` | 设置里的默认模型。空字符串或没有就是没设 |
| `defaultThinking` | 设置里的默认思考强度。空字符串或没有就是不思考 |
| `notify` | 完成通知开关。只在 `true` 时有，关就是没有这个键 |

### 页面

- 打开时先读界面数据和预设，再 `ps`，再 `watch`（不带 `process`）。被断开就等一会儿重连，从 `ps` 重来。
- 每条 `update` 换掉这个进程的 `self`。聚焦的进程段号或条数变了，就按设计稿第 10 节增量读 `history`。
- `text` 按进程存，`n` 变了就清掉重来。进程离开 `awaitingModel`，就清掉它的流式文本。
- 吐字（设计稿第 5.1 节）：
  - `ui/typer.js` 的 `Typer` 自己管 `.atext` 里的 DOM，Preact 不给它子节点。匀速的节奏是 `lib/pace.js` 的纯函数。所有 `Typer` 共用一个 rAF，没有在动的就停。
  - 衔接按序号：等模型时正在写的字，将来是当前段第 `self.messages` 条消息。记录的键是“进程、段、序号”（`slotKey`）。正在写的行、写完后留住的行（`HeldRow`）、最后读到的消息行，依次接手同一条记录，字接着出，不重来。
  - 写完那一刻有空档：`update` 离开等模型时流式文本就清掉了，最终回复要等 `history` 回来。历史还没读到那条消息时，`pending` 给出要留住的记录，最多留 3 秒。
  - 消息行的 key 带进程 ID。`Stream` 切进程时复用，不带的话同序号的消息行会复用旧实例。
  - 助手消息块（`.abox`、总管的 `.ch-bot`）设了 `overflow-anchor: none`。不然浏览器会拿字下面的工作条当滚动锚点，字一长就把页面一行一行往上挪。
- 跟着末尾走（设计稿第 9 节的留白进纸）：`ui/follow.js` 的 `Follower`。
  - 内容底部的内边距由它设，是台面高的四成。
  - 只认用户自己的操作。它自己写的 `scrollTop` 记在 `lastSet`，引起的 scroll 事件不算。
  - 滚动容器带 `tabindex="0"`：点正文以后焦点落在它上面，键盘翻页的事件才到得了它。
- Markdown（设计稿第 5.1 节）：`lib/markdown.js` 是纯函数，`marked` 出 HTML；`ui/mdview.js` 用 `dompurify` 净化再放进页面，复制按钮靠事件委托。import map 里 `marked`、`dompurify` 指向 `/vendor/`。
  - 原始 HTML、图片、非 http/https/mailto 的链接在 `marked` 的渲染器里就处理掉，净化是第二道。净化的白名单是 `PURIFY_CONFIG`，不设 `ALLOWED_URI_REGEXP`：它也会拦掉 `type`、`rel` 这些属性值。协议由钩子用 `safeHref` 再查。
  - `AssistantRow` 和总管弹窗的 `Said` 用它：`caught`（吐字追平，或本来就没有记录）为真才渲染 Markdown，之前仍是 `Typer`，吐字衔接不变。总管的 `.ch-bot` 是暗面，`markdown.css` 里单独一段覆盖配色。
- 通知、标题、图标：`ui/notify.js` 的 `Notifier` 不画东西，每次渲染读两类：`app.attention`（`derive.js` 的 `attention`，不含要 git 才知道的“未合并”，定义不改，总管弹窗也在用）和根进程的“新结果”。判断都在 `lib/notify.js`：`watchAttention` 和上一次的集合比较，首次只记下；`trackResults` 比较上一次各进程忙不忙，根进程从忙变闲就是新结果，用户在前台聚焦它时清掉；`unseenCount` 给标题和图标去重计数；`shouldNotify`；`notifyText`。新结果只存在 `ui/notify.js` 的模块变量里。
  - 等 `app.ready` 和 `app.procsReady` 才开始比较，所以刚打开时已经在待你看的不通知。
  - favicon 是 canvas 画的 data: URL。CSP 的 `img-src` 本来就有 `data:`，没有改 CSP。
  - 开关在设置里，点击时调 `Notification.requestPermission()`：浏览器只认用户操作里的申请。
- 进程归到哪个项目、常驻还是临时：看进程记录里冻结的预设快照，经 `/api/tau` 转发 `inspect` 读（`lib/derive.js` 的 `seenFromInspect` 取 `workdir`、`tools`、`memory`），存在页面内存里，不写界面数据。
  - 连上以后 `ps` 一到，读一次全部；之后 `update` 里出现没读过的进程，再单独读它。进程被删就丢掉它的快照。
  - 读全部之前页面不就绪；没读到快照的进程是 `unknown`，不归进任何项目。
- 段号从 1 开始。临时进程的标题取第 1 段第一条用户消息里第一封信正文的第一个非空行，信头不在正文里。
- 模块：`app.js` 是根组件，组装一个只读的 `app` 对象给各块用（数据、读法和动作，JSDoc 写在文件开头）；`conn.js` 管连接和增量读；`api.js` 发请求；`ui/` 每块一个文件；`css/` 每块一个文件，`styles.css` 只 `@import` 它们。
- 地址栏的 hash 记聚焦的对象和开着的弹窗：`#p=<进程 ID>`、`#proj=<项目键>`、`#dlg=chief|newproc|newpreset|openproj|projects|clean|settings`，记忆页是 `#dlg=memory&ns=<预设 ID>`（没有 `ns` 就不开）。改预设和换模型的弹窗要靠打开时传的预设和进程，不进 hash；删除的确认框也不进 hash，可以用 `&` 连起来。项目键是 `lib/state.js` 的 `pathKey`。
- 改界面数据时先重读文件，在新读到的内容上改，再写回去，几个页面同时开着也不互相覆盖。页面回到前台时和每 30 秒也重读一次。
- 进程在 `ps` 里没了，就从 `titles`、`mine`、`forkedFrom`、`current` 里删掉它的键，文件不会一直长。例外：还在的分叉指着的那个标题留着（`lib/state.js` 的 `prunePatch`）。
- 删进程：`ui/remove.js` 的确认框贴着点的按钮或行，状态不在 `app` 里，也不进 hash。确认框列出整棵子树，从叶子删起（`lib/remove.js` 的 `removePlan`、`skippedFor`）；子树里有在跑的就不让删；被服务拒绝的，只跳过它的祖先；框中途关掉就停在删完手上这个。删之前，子树里的临时进程和被分叉指着的进程，标题先缓存（`ui/titlecache.js`，清理旧进程共用）。`app.remove` 和 `app.deletePreset` 不弹提示，被拒绝时原因写在确认框里。收到 `removed` 时，删的是聚焦的进程就聚焦它的项目。
- 模型选择：`lib/models.js` 放纯逻辑（窗口的写法、思考级别取最近一档、搜索、供应商排序、最近用过、默认模型、表单变成请求）；`ui/modelpicker.js` 是选择器和思考强度的按钮，共用；目录和 key 状态存在页面内存里（`app.models`），打开建预设、打开项目、改预设、换模型、设置时重读。
- 建预设：`ui/presetform.js` 是“打开项目”、“新预设”和“改预设”共用的表。显示名写进 `names`，不写预设文件。新模型预填：先取调用方给的（新预设取项目里已有预设的），再取设置里的默认，再取最近用过的，最后是第一家配了 key 的第一个模型；不写死哪个模型。建完读一遍，起不来就弹出原因。从“新进程”弹窗进“新预设”时，建好以后回到“新进程”，选中新建的预设。
- 改预设：`ui/editpreset.js`，只发和现在不同的字段（`buildUpdate`）。服务回 422 或 503 时，错误原文写在检查条里，弹窗不关。`app.updatePreset` 不弹提示，由弹窗写。
- 换模型：`ui/switchmodel.js`。第一种换法先 `app.updatePreset`，再 `app.fork(id, undefined, preset)`；第二种直接带另一个预设分叉。`fork` 带 `preset` 时，新进程属于那个预设，带记忆的成为它的当前进程。
- 工具定义页：`ui/tools.js`，入口在设置里，hash 是 `#dlg=tools`。已装的在上，工具库在下；删和覆盖在行里确认。预设表（`ui/presetform.js`）打开时读 `/api/tools`，把已装的定义列成第二组工具开关。
- 记忆页：`ui/memory.js`，数据走 `/api/tau` 转发 `memory`、`memory_write`（`api.js` 的 `memoryRead`、`memoryWrite`），桥不用改。纯逻辑在 `lib/memory.js`：排序、折叠、编辑状态、读写回复（`interpretWrite`）、冲突（`afterConflict`）。值只能是字符串；键和值的字节上限由服务查，页面不抄。
  - 写冲突时服务回的 `current`（别处现在的值和版本号，或键已被删的 `null`）就是新的 `base`：用户写的字留着，别处的值列在文本框下，再按保存才覆盖。删除冲突不重试，只重读。
  - 一次只开一个编辑；编辑开着时其它行的“改”“删”不可用。
  - 页面不显示给模型看的视图，只显示库里的键值。
- 设置：`ui/settings.js`。默认模型、默认思考强度、清理天数改一项记一项；key 状态只读。
- 界面数据写失败以后 30 秒内不再自动写（清理旧键），不会反复重试。
- 信的来历读段里消息的 `tau`（`lib/messages.js` 的 `parseUser`），不解析文字：
  - 一封信的发送者、跳数、`replyTo`（写信时它在等回信）、回信的结束原因来自 `tau.letters`；正文是消息文本里 `at` 指的那段。
  - 上一轮的说明来自 `tau.after`，换段后的第一条来自 `tau.handoff`（说明和带过来的信用 `at` 切），被中断和未执行的工具结果来自 `tau.filled`，一轮的开头看 `tau.after` 和 `tau.handoff`。
  - 没有 `tau` 的旧消息按普通用户消息显示，整段文字一封信。文字被截过的消息没有 `at`，整段文字当一封信，发送者取第一封。
  - 唯一还认的固定文字是 `HANDOFF_HEADER` 和 `CARRY_HEADER`，只用来从新段第一条里切出交接说明。
- “换段”：`app.handoff` 用 `send` 带 `handoff: true` 寄 `HANDOFF_LETTER`（一封说明没有别的事要做的信）。段里已有助手消息才生效（`lib/messages.js` 的 `canHandoff`，[kb-kernel 的换段信](kb-kernel.md#换段信)）；进程在跑、或者段里还没有助手消息时按钮禁用。
- 只跟最近看过的几个进程读全部历史。别的进程只读当前段最后一条消息，拿到最后动静的时间。

## 测试

| 文件 | 测什么 |
|---|---|
| `test/extras/gui/bridge.test.ts` | 每条检查的反例；GET 不出目录；转发对着测试服务（临时目录、测试管道、faux 模型），含 `watch` 分块推送和浏览器断开；预设经 `check` 读（带 `options` 的读得出、读不出和装不下的错误文字和 `start` 一字不差、服务不在回 503）、新建不覆盖和删除；`inspect` 转发读到冻结的快照；换段信真的换段、信带进新段；git 带 `--no-optional-locks`、工作目录不对时拒绝；界面数据改名写入；模型目录和 pi-ai 一致、key 状态四种且值不进回复、auth.json 坏了或不存在、改了不用重启；改预设只换收到的字段（顺序、CRLF、BOM、正文原样，`null` 删行）、读不出或起不来改回旧文件、服务不在改回去、请求不合法；新建带 `handoff`、`options` |
| `test/extras/tools/tools.test.ts` | 工具库：四个脚本在真的服务和 Git Bash 里跑（截断和存文件、退出码、超时结束整个进程组、7 天清理；后台立刻返回、跑完寄信、同名拒绝；peek 的输出；wait 等到结束、超时、停止）；桥的列、装、改过后拒绝覆盖、更新、预设用到时拒删；装好的定义内核 `check` 读得出 |
| `test/extras/gui/agentsmd.test.ts` | 拼 AGENTS.md：加块和去块互逆（CRLF、BOM、手写的末尾空行字节不变）、换块在原处、给了 prompt 块留着、没有结束标记当没有块；接口：`/api/agents-md`、新建拼上或不拼或没有文件拒绝、CLAUDE.md 不认、改预设的不传不动、过期、重新拼、文件没了拒绝且旧文件不变、去掉、拼完装不下窗口改回旧文件、文件里有标记行或为空拒绝 |
| `test/extras/gui/memory.test.ts` | 记忆页的纯逻辑（字节序排序、折叠、编辑状态、写回复的判读、冲突后字和版本的处理）；经桥对着真的服务：新键、改、兄弟先写造成的冲突不覆盖、删、已删键的冲突、超限 |
| `test/extras/gui/lib.test.ts` | 纯逻辑：信的来历读 `tau`（发送者、跳数、回信、`after`、换段、`filled`，旧消息、被截过的消息）、`canHandoff`、进程按冻结的快照归类、增量读跨换段、重连后不丢不重、标题、当前进程、筛选计数、全部停止和清理的顺序、删进程的拒绝条件、`prunePatch`；模型选择（窗口的写法、思考级别取最近一档、搜索、供应商排序、最近用过、默认模型、key 提示）、预设表变成请求（只发变了的字段）、换模型的补丁、界面数据的新键、快照多带的几项；吐字的节奏（平稳的小块、成批到、收尾追平、一次来一大块）和 `latestSeq`；Markdown（GFM、原始 HTML 转义、链接和图片的过滤、代码块）；通知（谁刚进入待你看、该不该弹、正文、标题）；`notify` 键 |

## 坑点

- **普通的 `git status` 会写 `index.lock`。** 一律带 `--no-optional-locks`（[设计稿第 1 节](../docs/design/gui.md#1-定位)）。
- **宽屏的五块只能排成一行。** 多行的 flex 容器里，一行的高度跟着最高的那一块走。`.shell-body` 一换行，详情栏一长就把主区撑高，写信框被推出屏幕，消息区也滚不到底。所以只在窄于 1180 时才换行。
- **服务的环境变量会进 Agent 的 bash。** 起服务的那个程序的环境原样传下去，所以从干净的终端起（见[启动](#启动)）。
- **连管道不能半关闭。** 见 [kb-service 的坑点](kb-service.md#坑点)。
- **`index.html` 只在桥启动时读一次。** import map 是内联脚本，桥启动时算它的哈希写进 CSP。改了 `index.html` 要重启桥。其余静态文件每次请求现读。

## 关联模块

- [kb-extras.md](kb-extras.md)：上层的通用规则，桥的检查。
- [kb-service.md](kb-service.md)：线协议、历史和订阅。
- [界面设计稿](../docs/design/gui.md)：界面的规则。
