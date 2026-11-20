# 图形界面的实现

`updated: 2026-11-18`

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
| `extras/gui/bridge/*.ts` | 其余各部分：`forward.ts` 转发，`static.ts` 静态文件，`presets.ts`（经 `check` 列预设，写、改和删预设文件）、`models.ts`（模型目录和 key 状态）、`git.ts`、`bg.ts`、`tools.ts`（列、装、删工具定义）、`state.ts`、`pick.ts`，`pipe.ts`（一次性的管道请求、管道在不在）、`service.ts`（服务和桥的状态、旧代码的判断、起重启脚本）、`mcp.ts`（MCP 的服务器、工具定义和 relay 状态）、`keys.ts`（填和清 api_key，登出 OAuth，经凭据库 `extras/auth/store.ts` 写，[D69](kb-decisions.md#d69-界面可以填写和清除-api_key)、[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)），`util.ts` 放公用的小函数 |
| `extras/gui/web/index.html` | 页面 |
| `extras/gui/web/lib/*.js` | 页面的纯逻辑。不碰 DOM，不发请求。文件头写 `// @ts-check`，类型用 JSDoc |
| `extras/gui/web/ui/*.js` | 组件 |
| `extras/gui/web/*.js` | 根组件、请求、连接 |
| `extras/gui/web/*.css` | 样式 |
| `extras/gui/start.ps1` | 起服务和桥，打开页面 |
| `extras/gui/restart.ps1` | 重启服务、桥，或者两个都重启 |
| `extras/gui/shortcut.ps1` | 画图标，在桌面放 “tau” 快捷方式（点它跑 `start.ps1`） |
| `extras/gui/cleanenv.ps1` | 干净的环境和起停的小件，上面两个点号引入 |
| `test/extras/gui/*.test.ts` | 测试 |

页面的代码是浏览器直接加载的 `.js`，不转译。桥是 `.ts`，和 `src/` 一样只用可擦除的语法。

### 启动

- 桥：`node extras/gui/bridge/main.ts`。选项：
  - `--port`：默认 4317。只在 `127.0.0.1` 上监听。
  - `--home`：默认 `~/.tau`。测试用临时目录。
  - `--host`：额外认的 `Host` 名字，可以写多次，给 Tailscale 用。
  - 凭据文件默认 `<home>/auth.json`（`~/.tau/auth.json`），路径是 `createBridge` 的选项 `authFile`，没有命令行参数；测试用临时文件。桥用 `extras/auth/store.ts` 读写它，取标题的模型集合也用同一份，所以标题模型是 OAuth 供应商也能刷新令牌。
- 管道：`TAU_PIPE` 有值就用它，否则用 `\\.\pipe\tau`，和 CLI 一样。
- `start.ps1`：管道不在就起服务，端口没人听就起桥，都和终端脱开，日志写进 `~/.tau/extras/gui/`。然后打开页面。不做开机自启。带 `-Popup` 时，出错弹一个对话框，写原因。
- 桌面快捷方式：`shortcut.ps1` 画图标 `~/.tau/extras/gui/tau.ico`（黄底黑字的 τ，和左上角的标志一样），在桌面放 `tau.lnk`。仓库挪了位置就重新运行它。
  - 快捷方式的目标是 `conhost.exe --headless powershell.exe … start.ps1 -Popup`：没有窗口。默认终端是 Windows Terminal 时，`-WindowStyle Hidden` 还是会闪一下，`conhost --headless` 不会。
  - 没有窗口，出错就看不到，所以带 `-Popup`。
- 别从 Claude 桌面版的进程树里起服务和桥：那棵树里读写 `AppData` 都被重定向进 Claude 包自己的目录，Agent 装的东西（`pip --user`、`npm -g`）外面看不到。从桌面快捷方式、自己的终端或者界面的按钮起都没有这个问题。
- 服务和桥都用干净的环境起（`cleanenv.ps1` 的 `Start-Clean`）：环境按注册表的机器和用户变量、`Volatile Environment` 和系统固定的几个重建，清空进程自己的环境再填。服务把自己的环境交给 Agent 的 bash，所以从哪里运行脚本（包括另一个 Agent 的会话）都不会把调用方的变量和令牌带进去。
- `restart.ps1`：`-Service` 只重启服务，`-Bridge` 只重启桥，都不写就两个都重启。按命令行找到正在运行的 node 进程，停掉，用干净的环境再起，等管道或端口起来。服务先于桥重启，桥最后。界面的按钮也是跑它，多带 `-BridgePid`（桥自己的 PID）和 `-BridgeArgs`（桥原来的命令行参数，新桥原样带上）。
- 桥不直接跑 `restart.ps1`：它起一个不 detached 的 `powershell.exe`，这条命令只做 `Start-Process -FilePath 'powershell.exe' -ArgumentList '…' -WindowStyle Hidden`，由孙进程跑脚本（`launchArgv`）。为什么不能自己跑，见[坑点](#坑点)。
- 脚本文件带 UTF-8 BOM：桥用 Windows PowerShell 5.1 跑 `restart.ps1`，没有 BOM 会把中文读成乱码。

### 路径

都在 `--home` 下：

| 路径 | 内容 |
|---|---|
| `presets/` | 预设 |
| `extras/gui/state.json` | 界面数据 |
| `extras/gui/*.log` | `start.ps1` 起的服务和桥的日志 |
| `extras/bg/<进程 ID>-<名字>.log` | 老 `bg_run` 留下的后台命令 log（这个工具已退役，只为看没跑完的老进程还认；[kb-extras](kb-extras.md#后台命令)） |
| `extras/shell/<进程 ID>/*.log` | bash 的输出；旁边有 `.claim` 的是转入后台的，“后台”页也列（D90） |

### GET 路由

| 路径 | 送什么 |
|---|---|
| `/` | `extras/gui/web/index.html` |
| `/web/<路径>` | `extras/gui/web/` 下的文件 |
| `/vendor/<包>/<路径>` | `extras/node_modules/<包>/` 下的文件。包只认 `preact`、`htm`、`@fontsource-variable/archivo`、`@fontsource-variable/jetbrains-mono`、`@fontsource-variable/noto-sans-sc`、`marked`、`dompurify` |

- 路径解析以后不许出对应的目录。找不到回 404。
- 缓存头：`/web/` 和 `/` 是 `Cache-Control: no-cache`，浏览器每次都校验，改了代码不用强制刷新；`/vendor/` 是 `public, max-age=86400`。
- `Content-Type` 按扩展名定。
- `index.html` 里的 import map 是内联脚本。桥启动时算出它的 SHA-256，写进 `Content-Security-Policy` 的 `script-src`。其余见 [kb-extras 的检查](kb-extras.md#http-桥要做的检查)。

### POST 接口

请求的正文是 JSON 对象。出错回 4xx 或 5xx，正文 `{ "error": "<中文原因>" }`。

正文上限：`/api/tau` 是 32 MiB，因为图片是 base64；其余是 1 MiB。

| 路径 | 请求 | 回 |
|---|---|---|
| `/api/tau` | 一条协议请求 | 管道回的每一行原样分块写回，管道关闭就结束。浏览器断开，桥就断开管道。连不上管道回 503。`reconfigure` 和 `backup` 也是协议请求，原样转发，不要新路由 |
| `/api/presets` | `{}` | `{ presets }`，见下。服务不在回 503 |
| `/api/presets/create` | `{ id, workdir, model, tools, thinking?, handoff?, options?, context?, prompt }` | `{ ok: true }`。文件已经存在回 409，不覆盖 |
| `/api/presets/update` | `{ id, model?, thinking?, tools?, handoff?, options?, context?, prompt?, agentsMd? }` | `{ ok: true, preset }`，`preset` 是改完 `check` 读到的样子。见下。`agentsMd` 只接受 `false`（去掉旧的拼接块） |
| `/api/agents-md` | `{ workdir }` | `{ exists, bytes? }`。工作目录要是存在的绝对路径，否则 400。表单靠它决定“用项目的 AGENTS.md”勾选可不可用、默认勾不勾 |
| `/api/models` | `{}` | `{ providers, auth }`，见下 |
| `/api/presets/delete` | `{ id }` | `{ ok: true }`。ID 的检查和新建一样；没有这个文件回 404。只删 `presets/<ID>.md`，记忆库不动。桥不查这个预设还有没有进程，由页面拦：连着服务、这次连上以后收到过进程表，才让删 |
| `/api/git` | `{ workdir, what, file? }` | 见下 |
| `/api/bg` | `{ processes }` | `{ logs }`，见下 |
| `/api/tools` | `{}` | `{ installed, library }`，见下 |
| `/api/tools/install` | `{ name, replace? }` | `{ ok: true, status }`。`name` 必须是工具库里的；同名文件已有且内容不同，没有 `replace` 回 409，不覆盖；内容一样直接成功。写 `<home>/tools/<name>.json`，先写临时文件再改名 |
| `/api/tools/remove` | `{ name }` | `{ ok: true }`。有预设的 `tools:` 一行用到它回 409，错误里写是哪些预设；没有这个文件回 404 |
| `/api/mcp/servers` | `{ workdir }` | `{ file, servers }`，见下“MCP 页” |
| `/api/mcp/tools` | `{ workdir, server }` | `{ instructions, tools, gone, totalBytes }`，见下 |
| `/api/mcp/install` | `{ workdir, server, tools }` | `{ ok: true, installed, bytes }`，见下 |
| `/api/mcp/status` | `{}` | `{ running: false }`，或 relay 的 `{ running: true, pid, instances }` |
| `/api/service` | `{}` | 见下“重启和旧代码” |
| `/api/service/restart` | `{ service?, bridge?, force? }` | 202 `{ ok: true }`，或 409，见下 |
| `/api/state` | `{ set? }` | `{ state }`。`set` 的每个顶层键覆盖进文件，再回整个文件 |
| `/api/pick-folder` | `{}` | `{ path }`，取消时是 `null`。同时只开一个对话框，第二个请求回 409 |

`/api/tau` 只查正文是带字符串 `op` 的对象，其余交给服务校验。

预设：

- 读预设不自己解析：列出 `presets/` 下的每个 `.md`，对每个文件名发一次 `check`（经管道，和 `/api/tau` 同一条管道）。读得出、能不能启动、错误文字都和 `start` 一致（[kb-service 的 `check`](kb-service.md#读记录和干跑inspectcheck)），预设以后加字段（例如 `options`）桥不用改。
- 每个预设回 `{ id, ok: true, workdir, model, tools, memory, prompt, agentsMd, thinking?, handoff?, options?, context? }`。`prompt` 是改预设时要显示的提示词，只有用户写的部分，不含旧的 AGENTS.md 拼接块。`agentsMd` 是旧块的状态：`none` 或 `legacy`，见[上下文文件](#上下文文件)。`context` 是预设里写的上下文文件，原样。`tools` 是内置工具加工具定义的名字，`memory` 是 `tools` 里有没有 `memory`。读不出，或者读得出但此刻起不来（`check` 的 `error` 不是 `null`，例如窗口装不下），回 `{ id, ok: false, error }`，照样列出，`error` 是服务给的原文。
- 保存预设（新建和改）时，`tools` 里点到工具库（`extras/tools/catalog.ts`）里的名字，而 `<home>/tools/<名字>.json` 还没有，桥先装上（`bridge/tools.ts` 的 `installTool`）。已经有的不动，包括用户改过内容的。这样模型一看到预设就有能运行命令的工具，不用先去工具定义页点安装。
- 连不上服务回 503，不当成每个预设都读不出：页面连上以后再读。
- 新建时只写认识的字段，提示词写在第二个 `---` 后面。`thinking`、`handoff`（正整数）、`options`（对象，写成一行 JSON）、`context`（字符串数组，逗号分隔写成一行）有就写，没有不写。ID 只许字母、数字、`.`、`_`、`-`，工作目录必须是存在的绝对路径。模型、工具名只查格式，不查模型目录和工具定义：写出来的文件能不能用，由 `check` 说了算。
- 改预设只换收到的字段，别的行、顺序、换行符、BOM、提示词原样：
  - `thinking`、`handoff`、`options`、`context` 给 `null` 就删掉这一行；`context` 给空数组也一样（新建时空数组就不写这一行）；文件里没有的字段追加到头部末尾；`prompt` 给了才换整个正文。一个字段都没给回 400。
  - ID 和工作目录不能改：body 里的 `workdir` 被忽略。文件没有头部回 400，文件不存在回 404。
  - 写临时文件再改名，写完立刻发 `check`。读不出，或者 `check` 带回启动错误，就把旧文件按原字节改回去，回 422，`error` 是服务的原文；服务不在回 503，也改回去。
  - 一次只改一个预设，排队做。
  - 文件里本来就有的不认识的键照样保留，所以会被 `check` 拒绝，改回去。
- 删除只认 ID，检查和新建一样。桥不查这个预设有没有进程，也不查是不是总管的预设；这两条由页面拦（[设计稿 7.7](../docs/design/gui.md#77-删除)）。

模型目录和 key 状态（`models.ts`）：

- 目录：用 pi-ai 的 `getBuiltinProviders`、`getBuiltinModels`、`builtinProviders`（显示名）和 `getSupportedThinkingLevels`，桥第一次收到请求时算一次。只含有模型的供应商。
- 账号可用清单：目录是包里的全部，回复里的 `models` 再过一遍 provider 自带的 `filterModels`（`accountModels`，每次请求现算，用 `authFile` 里 tau 读得了的条目）。pi-ai 1.5.2 里只有 GitHub Copilot 有：OAuth 条目的 `availableModelIds`（登录和刷新令牌时 pi-ai 从 Copilot 拉的）不在清单里的模型不列；没有这个字段、形状不对、不是 OAuth 都列全部；清单是空数组，那一家 `models` 是 `[]`，供应商还在。其余供应商的目录是静态的：pi-ai 里只有 radius 能在线刷新，桥和服务各有一份目录，只在桥刷新会列出服务不认的模型，所以没做刷新键（[D84](kb-decisions.md#d84-pi-ai-升级版本不再写死)的升级才是更新目录的办法）。桥不用 `Models.getAvailable`：它会丢掉没配 key 的供应商，设置页要靠这些组填 key。服务那边的校验不变，仍按完整目录。
- `providers` 每项：`{ id, name, key, models }`。`models` 每项：`{ id, name, window, image, thinking }`，`thinking` 是支持的级别，已去掉预设不收的 `off`。
- `key` 每次请求现读 `authFile`，只看每个条目的供应商名和 `type`：`key`（`api_key`）、`oauth`（已登录，字段齐全）、`unreadable`（OAuth 缺 `access`、`refresh` 或 `expires`；`api_key` 的 key 不是字符串、`!` 开头或含 `$`；和凭据库 `read` 的检查一致）、`none`。只有 `env` 没有 `key` 的 `api_key` 条目算 `key`（pi-ai 读得了）。key 的值不进回复、日志和错误文字。
- `auth` 是 `{ ok: true }`；文件读不出或不是 JSON 对象时是 `{ ok: false, error }`，`error` 是固定的中文，不带文件内容，这时每家都是 `none`。文件不存在算没配，`ok: true`。

填和清 api_key（`keys.ts`，接口 `keys/set`、`keys/clear`，理由和代价见 [D69](kb-decisions.md#d69-界面可以填写和清除-api_key)）：

- 请求 `{ provider, key }` 和 `{ provider }`；`provider` 必须在模型目录里，否则 400。成功回 `{ ok: true, key: <这一家现在的状态> }`。
- 读、改、写都经凭据库（`extras/auth/store.ts`）的 `modify`、`delete`：持锁，先写 `<authFile>.tmp` 再改名（[D83](kb-decisions.md#d83-tau-自己的凭据文件读写支持-oauth不再用-pi-的)）。凭据库的错误（文件读不出、不是合法 JSON、顶层不是对象、等锁超时、写不了）：409，说明原文加“没有改它”，不覆盖，不带文件内容。
- 只动这一家的条目，别家原样。`set`：这一家是 `oauth` 登录的，409（先登出）；已有 `api_key` 条目时保留它的其它字段，只换 `key`；别的类型或写坏的条目直接换掉。`clear`：删掉这一家的条目，`api_key` 是清掉，`oauth` 就是登出；没有这一条就什么也不做。
- `key` 的检查在 `extras/auth/key.ts`（登录脚本共用）：先 trim；空的、含控制字符（含换行）、超过 4096 字节、`!` 开头、含 `$`：400。key 的值不进返回值、错误文字、日志。
- 重写整个文件会把缩进统一成 2 空格，顶层整数形状的名字按 JS 的规则排到前面。

git：

- 一律 `git --no-optional-locks --literal-pathspecs -c core.fsmonitor=false -C <目录> …`，不经 shell，有超时。文件路径按字面传：`foo[1].txt` 不会匹配 `foo1.txt`。diff 另加 `--no-ext-diff` 和 `--no-textconv`，不跑仓库里配置的外部程序。
- 输出超过缓冲上限时：`diff` 截断并标 `truncated`；`status` 回 500，不解析半截输出。
- 工作目录必须是某个预设的 `workdir`（读法同上，经 `check`），或者界面数据 `folders` 里的文件夹。否则回 403。比较时不分大小写。会话改了工作目录、新目录又没有预设指向也没登记时，它的进程会得到 403：页面照常把它当一个项目，读 git 的地方静默处理，不弹错（项目页铭牌的仓库一栏按读不到的老办法写“不是 git 仓库”，详情栏里写“读不到”和原因；`ui/project.js` 的 `useRepo` 直接调 `api.js`，不经会弹提示的路径，页面上没有 `app.git`）。这条规则不为它放宽。
- `what`：
  - `status`：`{ repo, branch?, files }`。每个文件 `{ path, status, add, del }`，`status` 是 porcelain 的两个字母，`add`、`del` 来自 `diff --numstat HEAD`，拿不到时是 `null`。不是仓库时 `{ repo: false }`。
  - `diff`：`{ text, truncated }`。`file` 是 `status` 给的路径，相对仓库根，所以在仓库根上跑。未跟踪的文件用 `diff --no-index`，其余用 `diff HEAD -- <文件>`，还没有提交时退回 `diff --cached`。超过 256 KB 截断。
  - `log`：`{ commits }`，最近 30 个。每个 `{ hash, short, subject, author, time }`，`time` 是毫秒。
  - `branches`：`{ main, branches }`。主分支是 `main`，没有就 `master`，都没有是 `null`。每个分支 `{ name, current, ahead, behind, merged, add, del }`，和主分支比。

后台命令：

- 列出 `extras/bg/` 下以这些进程 ID 开头的 log，和 `extras/shell/<进程 ID>/` 下旁边有 `.claim` 的 log（bash 转入后台的，名字是任务号）。
- 每个回 `{ process, name, file, size, mtime, tail, exit }`。`file` 是相对 `extras/` 的路径。`tail` 是最后 8 KB。`exit` 取最后一行 `[后台任务 <名字>] 退出码 N` 的 N，没有是 `null`。

工具定义（`bridge/tools.ts`，工具库在 `extras/tools/`，做什么见 [kb-extras 的工具库](kb-extras.md#工具库)）：

- `installed`：`<home>/tools/*.json`，每个 `{ name, description?, params?, timeout?, output?, command?, error?, usedBy }`。`error` 是读不出的原因（不是合法的 JSON、不是对象）；`usedBy` 是 `tools:` 一行里写了它的预设 ID。桥直接读预设文件的头，不经服务，服务不在也能列。
- `library`：`extras/tools/catalog.ts` 的每一项，`{ name, description, params, timeout, output, command, status }`。`status` 是 `none`、`installed`、`differs`：把装在 `tools/` 里的内容和库里生成的定义逐项比较（键排序后），一样才是 `installed`。工具定义格式不许多余字段，没有别的办法认出是库装的。
- 写进文件的 `command` 里是仓库的绝对路径（正斜杠，由桥文件的位置推出）。库的位置含引号、`$` 或反引号时拒绝安装。

重启和旧代码（`bridge/service.ts`）：

- `/api/service` 回 `{ service: { up, startedAt, stale }, bridge: { startedAt, stale }, running, newestSource, newestBridge }`，时间是毫秒。
  - `up`：管道连得上。`running`：`ps` 里阶段不是 `idle` 的个数；服务不在是 `null`。
  - `service.startedAt`：PowerShell 的 `Get-CimInstance` 按命令行（`src/main.ts serve`）找 node 进程的创建时间，结果缓存 30 秒，重启请求会清掉缓存。服务不在时不查。
  - `bridge.startedAt`：桥自己的启动时间（`Date.now() - process.uptime()`），不用查。
  - 旧代码：`service.stale` = `newestSource > service.startedAt`，`newestSource` 是 `src/`、`package.json`、`package-lock.json` 里 `.ts`、`.js`、`.json` 的最新修改时间；`bridge.stale` = `newestBridge > bridge.startedAt`，`newestBridge` 是 `extras/gui/bridge/` 和 `extras/tools/` 的。都跳过 `node_modules` 和点开头的目录。查不到服务的启动时间就不算旧。
  - 局限：只比修改时间，改了又改回去也算旧；`extras/gui/web/` 不算，页面文件每次现读。
- `/api/service/restart`：`service` 和 `bridge` 至少一个是 `true`，否则 400。要重启服务、有进程在跑、没带 `force`：回 409 `{ error, running }`，什么都不做。否则用 detached 的 `powershell.exe` 跑 `restart.ps1`，立刻回 202。只重启桥不动进程，所以不拦。重启桥会把桥自己停掉，页面靠 `conn.js` 的重连回来。
- 测试里 `createBridge` 的 `serviceOps`、`bridgeStartedAt`、`repo` 注入假的，不真的起停进程。

MCP 页（`bridge/mcp.ts`，做法见 [kb-extras 的 MCP 中转](kb-extras.md#mcp-中转)）：桥只列、生成、装定义和看 relay 的状态，不拉起 relay。

- `workdir` 必须是已知的项目目录（预设的工作目录，加界面里登记的文件夹），检查和 `/api/git` 一样，不是就 403。
- `/api/mcp/servers`：`file` 是配置文件路径（`.pi/mcp.json`，没有就 `.mcp.json`，都没有是 `null`）；`servers` 每项 `{ name, command?, description?, timeout?, error? }`，一项写错了只标记那一项。配置文件整体不是合法 JSON 时回 400。
- `/api/mcp/tools`：起一次服务器、列完工具就关掉（不写盘）。每个工具 `{ tool, name, description, bytes, status, skip? }`，`status` 是 `none`、`installed`、`differs`（和刚生成的定义逐项比较）；`gone` 是装着的、命令指向这个服务器的 `call.ts`、但服务器上已经没有的定义名；`totalBytes` 是能装的定义的字节数之和。配置读不出回 400，起不来服务器回 502。
- `/api/mcp/install`：重新列一次、重新生成，只装 `tools` 里选中的（用原工具名），不信客户端送来的定义。先写临时文件再改名。同名文件已存在、又不是这个服务器生成的 MCP 定义：一个都不写，回 409 并列出名字。服务器上没有的工具、装不了的工具回 400。
- `/api/mcp/status`：连 relay 的管道（`TAU_MCP_PIPE` 有值就用它，再默认 `\\.\pipe\tau-mcp`）发 `status`。连不上回 `{ running: false }`，不拉起 relay。
- 删定义不另做接口，用 `/api/tools/remove`（被预设用到时会拒绝）。
- `/api/tools` 的 `installed` 多一个可选字段 `mcp: { server, tool }`：命令指向 `extras/mcp/call.ts` 时才有（`bridge/tools.ts` 用 `gen.ts` 的 `parseCommand` 认）。库里的和手写的没有这个字段。预设表、工具定义弹窗和工具标签靠它把同一个服务器的定义合成一个。
- 测试：`test/extras/gui/mcp.test.ts`。

界面（`ui/mcp.js`，是工具定义弹窗的第三节“03 MCP”）。一个服务器是一个整体：要么装，要么不装，不挑单个工具：

- 项目：一个 `<select>`，选项是 `app.projects`，默认聚焦的那个。换项目就重读 `/api/mcp/servers`。
- 服务器：每个一张 `.td-row` 卡，写名字、命令、说明、超时；写错的项是 `bad` 卡，写错误原文，不给“列出工具”。已装过的卡多一个“已装 n 个”标签，n 是 `props.installed` 里 `mcp.server` 等于这个名字的定义个数，不用起服务器。
- 列工具：卡上的按钮，等的时候写“正在列…”，期间别的按钮都不可用。
- 工具清单：`.mcp-row`，只读，没有勾选框。定义名、原名（不同时才有）、状态 tag（未装、已装、和现在的不同）、字节数。跳过的写原因。
- 大小条：能装的定义（`installable`，没有 `skip` 的）的字节数对着 64 KiB；超了整条变警示橙，写“这个服务器一个预设放不下”，但不拦安装。
- 安装的永远是能装的全部：`installable(tools)` 的原工具名（`tool`）发给 `/api/mcp/install`。按钮写“安装”（这个服务器还没装）或“更新”（已装，且有 `differs` 或 `none` 的，或服务器上已经没有某些已装的定义）；全都已装、一样、也没有多余的旧定义时不给按钮，写“已是最新”。409 的错误原文写在检查条里。
- 装成功后把 `gone` 里没被预设用到的定义逐个 `/api/tools/remove` 删掉；被 `usedBy` 用到的留着，note 里写明是哪些预设。没有单独的“服务器上已经没有的”一块了。
- 卸载：卡上有已装的定义时给“卸载”，行里先确认，再逐个删这个服务器的定义。其中任何一个 `usedBy` 非空就不给卸载，写是哪些预设。
- 服务器的说明（`instructions`）：折在工具清单上面，点开看全文（`.mcp-instr-t`），带“复制”（`navigator.clipboard`，不是安全上下文时没有）。写一句：工具描述里不带它，要模型知道就贴进预设的提示词。
- 中转：`/api/mcp/status` 的一行。没在跑写“第一次调用时自动起来”；在跑写几个实例，每个的进程、服务器、`idleText(idleMs)`、在跑的调用数。打开弹窗读一次，每次列工具、装、卸载以后读一次，**不轮询**；旁边一个“刷新”。
- 01 已装的定义（`ui/tools.js`）：MCP 生成的定义按服务器一行（`groupByServer`），写名字、`MCP` 标签、几个工具、几个预设在用（`usedBy` 取并集），点“工具名”展开看全部定义名，默认折着。删除是整个服务器一起删，行里先确认；任何一个定义 `usedBy` 非空就不给删。不是 MCP 的一行一个，照旧。
- 预设表（`ui/presetform.js`）：MCP 生成的定义不逐个开关，也没有小组头。一个服务器一个开关按钮（`withGroup`）：文字 `服务器名 · n 个工具`，只写了一部分时写 `服务器名 · k/n`；`aria-pressed` 为真当且仅当 n 个全在；点一下没全开就补满，全开就全去掉。不是 MCP 的和 `tools/` 下已经没有的原样留在后面一组，那组还是小组头加“全选”“全不选”。
- 工具标签（`ui/inspector.js` 的 `ToolTags`）：项目概况的预设行和聚焦进程的概况用 `foldTools(tools, app.defs)` 折，同一个服务器一个标签 `服务器名 · n`（只勾一部分写 `k/n`），`title` 是全部工具名。`app.defs` 是 `/api/tools` 的 `installed`，整页读一次（`app.reloadDefs`，挂载时读；工具定义弹窗装完、删完再读）；读不到就不折，原样一个一个写。
- 纯逻辑在 `extras/gui/web/lib/mcp.js`（`installable`、`sizeOf`、`foldTools`、`groupByServer`、`withGroup`、`idleText`、`LIMIT`），测试 `test/extras/gui/mcp-lib.test.ts`。

### 上下文文件

[D72](kb-decisions.md#d72-上下文文件开段重读)：项目的上下文由内核在每次开段重读（D58 原来由上层把 AGENTS.md 拼进提示词，已改）。预设写 `context: AGENTS.md`，内核读 `<工作目录>/AGENTS.md`，放进系统提示词（[kb-store](kb-store.md#上下文文件视图)）。界面只认 `AGENTS.md` 这个文件名，不认 CLAUDE.md。

- 新建预设：勾选“用项目的 AGENTS.md”就是在 `context` 里加一项 `AGENTS.md`，不再往提示词里拼块。文件在不在，靠 `/api/agents-md` 判断；在就默认勾上，不在勾选不可用。
- 上下文文件字段（`ui/presetform.js`，预设表和会话表都有）：一行一个路径的列表，最多 8 行，旁边小字“每次换段重读，最多 24 KiB”。勾选是它的快捷：勾上加一行 `AGENTS.md`，取消去掉。
  - 校验分三层：页面（`lib/models.js` 的 `parseContext`）按规格查个数和每项的写法：去空白、跳空行、重复的去掉，最多 8 行，每项最长 260 个字符，不能有逗号和控制字符。桥（`bridge/presets.ts` 的 `contextItems`）收到数组时查同样几条，不合格回 400。两处都只管“写得成预设文件里的一行”。
  - 路径写得对不对（相对路径还是 Windows 绝对路径，`/e/x` 不认），页面和桥都不抄，交给服务：改预设时由写完文件后的 `check` 说了算，改这个会话时由 `reconfigure` 的 `error` 说了算，原文写在检查条里。文件在不在更不查（[设计稿第 2 节](../docs/design/mvp.md#2-预设)）。
- 旧的拼接块：D58 的做法留在提示词里的东西。`bridge/agentsmd.ts` 只保留认出块和去掉块，不再加块；`presets.ts` 调它。
- 块的格式：前后各一行标记，中间是文件的各行（换行统一，去掉末尾的空行）。块前面空一行。

  ```text
  <!-- tau-gui:agents-md begin | 这一段由界面从 AGENTS.md 拼进来，别手改 | <工作目录>\AGENTS.md -->
  …AGENTS.md 的内容…
  <!-- tau-gui:agents-md end -->
  ```

- 起始行以 `<!-- tau-gui:agents-md begin` 开头，后面的说明和路径随便；结束行是固定的整行。有起始没有结束，当没有块：不替用户删不认识的字。
- `update` 的 `agentsMd`：只接受 `false`，去掉块；不传不动，`true` 回 400。给了 `prompt` 但没给 `agentsMd` 时，块留着，只换用户的部分。
- 去块只去掉块前面的那一个空行和块：用户手写的部分，包括末尾的空行，一字不动。
- 列表里的 `agentsMd`：`none` 没有块；`legacy` 有旧块。
- 转成上下文文件有两个入口，效果一样（去掉旧块，`context` 加上 `AGENTS.md`，已有就不重复），生效的时机不同：
  - 项目概况里，有旧块（`legacy`）的预设的行标 `legacy`，旁边一个按钮“转成上下文文件”（`ui/inspector.js` 的 `LegacyMark`）。点一下就直接转：一次 `update`，`agentsMd: false` 加 `context`（`lib/models.js` 的 `convertPatch`），改的是预设文件，不经过表，没有“保存”那一步。已有的会话不变。
  - 预设表和会话表里，提示词框下写“有旧的拼接块”，旁边的“转成上下文文件”是一个开关（`LegacyRow`）：点它，表里的上下文文件加上 `AGENTS.md`，保存时才一起生效：预设表发 `update` 带 `agentsMd: false`，会话表发 `reconfigure` 带去掉块的 `prompt`（`buildSession`）。不点就一直留着，别的保存不会动它。
  - 两个入口都要项目里有 `AGENTS.md`（`lib/models.js` 的 `convertGate`，用 `/api/agents-md` 查预设或表里的工作目录）：没有时旧块可能是内容的最后一份，转完内核读不到它。所以没有、还没查到、目录查不了时，键是灰的，旁边小字写原因（没有时写“项目里没有 AGENTS.md，旧块是最后一份内容，转了就读不到”）；`convertPatch` 也不给补丁，只给原因。会话表里改了工作目录，新目录里没有 `AGENTS.md`，点过的开关也不算（生效的转换取决于现在的目录）。
  - `context` 加上以后这个预设装不下（启动检查不通过），桥照现有逻辑改回旧文件，回 422 和原文。
- 会话快照里的提示词也可能带着旧块（它出生时的预设有）。会话快照不经桥，页面自己拆（`web/lib/agentsmd.js`，和 `bridge/agentsmd.ts` 的规则一致，测试逐例对比）：会话表里的提示词和预设表的规则一样，只编辑用户写的部分，保存时接回旧块。
- 界面不标 AGENTS.md 改过没有，也没有“重新拼”：内核每次开段都重读文件。旧块不再更新，只能转成上下文文件，或者留着。

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
| `theme` | 外观。只在 `night`、`vscode` 时有，亮就是没有这个键（文件里可能写着 `day`，读的时候丢掉） |
| `motion` | 动效开关。只在 `false` 时有，开就是没有这个键（文件里可能写着 `true`，读的时候当开） |

### 页面

- 打开时先读界面数据和预设，再 `ps`，再 `watch`（不带 `process`，带 `messages: true`）。被断开就等一会儿重连，从 `ps` 重来。
- 数据流：
  - 每条 `update` 换掉这个进程的 `self`。追加的消息紧跟着推来（带 `process` 的 `message`），`app.js` 的 `onPushed` 用 `lib/history.js` 的 `applyPushed` 并进被跟着的进程的缓存，用 `createPeeker().push` 并进别的进程的末尾几条。
  - `applyPushed` 只收正好接在缓存末尾后面的一条：已有的丢掉，跳号的丢掉，没读过的段丢掉；换段时先 `noteSelf`，新段从 0 起。
  - `history` 只补缺：缓存比 `self.messages` 少就读。收到 `update` 以后先等 `PUSH_GRACE`（250ms）再决定读不读，推来的消息接得上就一次都不读（`createHistoryReader` 和 `createPeeker` 的 `grace`）。`ps`（首次和重连）、`follow` 切进程不等。
  - 读 `history` 的同时推送也在往同一份缓存里追加：读的每一行都从缓存里取最新的再并，不用手里的旧副本盖掉。
- 命令边跑边写的输出（D88）也在 `Live` 里（`output`，只留最后 20000 字），等工具时接在正在跑的那条调用下面，跑完以工具结果为准；等工具时不清 `Live`，回到空闲才清。
- 流式文本按进程存成 `Live`：`n`、正文、思考、工具调用参数（`lib/stream.js` 的 `appendDelta` 按 `kind` 分开；不认识的 `kind` 丢掉，不当正文）。`n` 变了三样一起清掉重来，进程离开 `awaitingModel` 也清。参数只存最后 2000 字，总字数另记。
- 思考和参数（`ui/messages.js`）：`LiveRow` 在正文上面画思考块 `ThinkLive`，下面画参数块 `ArgsLive`。思考不走 `Typer`，直接追加。一步写完、消息还没读到时，`HeldRow` 用模块里留的思考画收起的样子，10 秒后清掉。正文的吐字衔接不变。
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
- 外观（[设计稿的夜间配色](../docs/design/gui.md#夜间配色)）：`theme` 在界面数据里，`ui/notify.js` 的 `Notifier` 用 `lib/theme.js` 的 `applyTheme` 把它换成 `<html data-theme="night">` 或 `"vscode"`（亮就是没有这个属性）并同步 `theme-color`。设置里的开关改的是同一个键，不读也不写别处，没有第二份。
  - 动效开关（[设计稿第 9 节](../docs/design/gui.md#9-交互和动效)）：`motion` 在界面数据里，同上的 `Notifier` 用 `lib/motion.js` 的 `applyMotion` 换成 `<html data-motion="off">`（开就是没有这个属性）。只看这个键，不看系统的“减少动画”（2026-11-19 用户定）。`css/base.css` 的 `:root[data-motion="off"] *` 停掉所有动画和过渡，脚本这边 `motionOn()` 读到关就直接到位：`ui/typer.js` 吐字定格、`ui/follow.js` 跟随不滑、`ui/common.js` 弹窗收起不等那 160ms。改这几处别再读 `matchMedia("(prefers-reduced-motion: reduce)")`。
  - 样式只靠 `css/base.css` 开头的令牌换色：`:root` 是亮，`:root[data-theme="night"]` 只覆盖令牌，选择器不重写。
  - 台面上的文字和线用 `--tx`、`--tx2`、`--k`（线和纹理写成 `rgb(var(--k) / .2)`），台面和卡片用 `--stage`、`--card`、`--card-me`、`--line-l`。`--ink`、`--ink-2` 永远是墨黑：只压在黄、橙和选中行（`--sel`、`--sel-hi`）上，或做暗块的底。新写的台面样式别用它们。
  - 黄和橙的渐变高光（按钮上沿、悬停）是 `--acc-*`、`--warn-*`，选中行的高光是 `--sel-*`；外沿的投影不变色。
  - VS Code 配色（[设计稿](../docs/design/gui.md#vs-code-配色)）也是令牌加一个 `css/vscode.css`。黄、橙压在上面的字写 `--on-fill`，暗面上写成字的黄、橙写 `--acc-t`、`--warn-t`，不直接写 `--ink`、`--acc`、`--warn`：亮和夜里它们相等，VS Code 里才分开。切角键的面和亮边是 `--key*`。`vscode.css` 只放令牌换不掉的（铭牌的结构、写死的色值、装饰），每条都以 `:root[data-theme="vscode"]` 开头；改铭牌、弹窗顶边这类结构样式时，顺手看一眼它有没有覆盖。
- 进程归到哪个项目、常驻还是临时：看进程记录里的会话快照（`preset`），经 `/api/tau` 转发 `inspect` 读（`lib/derive.js` 的 `seenFromInspect` 取 `workdir`、`tools`、`memory`），存在页面内存里，不写界面数据。
  - 读全部之前页面不就绪；没读到快照的进程是 `unknown`，不归进任何项目。进程被删就丢掉它的快照。
  - 快照不是读一次就算：`reconfigure` 能改它，别的客户端也能改。重读的时机（`app.js` 的 `loadSnaps`、`lib/session.js` 的 `needsInspect`）：
    - `ps` 一到（首次和重连），读一次全部。
    - 窗口回到前台（`focus`），读一次全部：别的客户端可能改过。
    - `update` 里第一次见某个进程，或者它的模型、段号、`self.pending.fields` 变了（换段采用了待换配置，或者有人改了结构性字段），单独读它。
    - 概况页的轮询读到的 `inspect`（每 10 秒，见下）也并进快照（`app.noteInspect`），变了才换。
    - 自己发完 `reconfigure`（`app.reconfigure`），马上重读这个进程，不等推送。正在读的时候又要求重读，这一次读完再读一遍。
  - 已知漏洞：别的客户端只改了调用参数（思考强度、`options`、换段阈值），又不引起上面任何一种变化时，没有推送告诉页面。段尺的刻线（`limits.threshold`）等概况页下一次轮询才更新，最多晚 10 秒；概况页没开着，就等下一次回到前台。
- 段号从 1 开始。临时进程的标题取第 1 段第一条用户消息里第一封信正文的第一个非空行，信头不在正文里。
- 模块：`app.js` 是根组件，组装一个只读的 `app` 对象给各块用（数据、读法和动作，JSDoc 写在文件开头）；`conn.js` 管连接和增量读；`api.js` 发请求；`ui/` 每块一个文件；`css/` 每块一个文件，`styles.css` 只 `@import` 它们。
- 地址栏的 hash 记聚焦的对象和开着的弹窗：`#p=<进程 ID>`、`#proj=<项目键>`、`#dlg=chief|newproc|newpreset|openproj|projects|clean|settings`，记忆页是 `#dlg=memory&ns=<预设 ID>`（没有 `ns` 就不开）。改预设、改这个会话和换模型的弹窗要靠打开时传的预设和进程，不进 hash；删除的确认框也不进 hash，可以用 `&` 连起来。项目键是 `lib/state.js` 的 `pathKey`。
- 改界面数据时先重读文件，在新读到的内容上改，再写回去，几个页面同时开着也不互相覆盖。页面回到前台时和每 30 秒也重读一次。
- 进程在 `ps` 里没了，就从 `titles`、`mine`、`forkedFrom`、`current` 里删掉它的键，文件不会一直长。例外：还在的分叉指着的那个标题留着（`lib/state.js` 的 `prunePatch`）。
- 删进程：`ui/remove.js` 的确认框贴着点的按钮或行，状态不在 `app` 里，也不进 hash。确认框列出整棵子树，从叶子删起（`lib/remove.js` 的 `removePlan`、`skippedFor`）；子树里有在跑的就不让删；被服务拒绝的，只跳过它的祖先；框中途关掉就停在删完手上这个。删之前，子树里的临时进程和被分叉指着的进程，标题先缓存（`ui/titlecache.js`，清理旧进程共用）。`app.remove` 和 `app.deletePreset` 不弹提示，被拒绝时原因写在确认框里。收到 `removed` 时，删的是聚焦的进程就聚焦它的项目。
- 模型选择：`lib/models.js` 放纯逻辑（窗口的写法、思考级别取最近一档、搜索、供应商排序、最近用过、默认模型、表单变成请求）；`ui/modelpicker.js` 是选择器和思考强度的按钮，共用；目录和 key 状态存在页面内存里（`app.models`），打开新预设、改预设、改这个会话、换模型、设置时重读。
- 建预设：`ui/presetform.js` 是“新预设”、“改预设”和“改这个会话”共用的表。新建时给 `PresetFields` 传 `compact`：预设 ID、显示名（`idExtra`）、模型、提示词之外的字段折进“更多设置”，收起时的一行摘要是 `lib/models.js` 的 `moreSummary`，里面哪个字段填错（`create()` 不 ok）就自动展开。项目里还没有预设时，预设 ID 没填就取文件夹名（`suggestId`）。显示名写进 `names`，不写预设文件。新模型预填：先取调用方给的（新预设取项目里已有预设的），再取设置里的默认，再取最近用过的，最后是第一家配了 key 的第一个模型；不写死哪个模型。建完读一遍，起不来就弹出原因。从“新进程”弹窗进“新预设”时，建好以后回到“新进程”，选中新建的预设。
- 打开项目和新进程只做一件事（[设计稿 7.2、7.3](../docs/design/gui.md#72-新进程)）：`ui/openproj.js` 只记文件夹（`addFolder`、`pinFolder`），不建预设，不碰预设表；项目里没有预设也没有进程时，主区的成员表换成空状态（`ui/project.js`，一句话加“新建预设”）。`ui/newproc.js` 是一行预设按钮加一个信框，默认选中的预设是 `lib/derive.js` 的 `defaultPreset`（指定的 > 项目里最近有动静的进程的预设 > 第一个，每次渲染重算，用户点过才存）；项目里没有预设时只有一句话和“新建预设”，建好以后回到它。预设列表是弹窗打开以后才读到的，所以信框出现时由 `useEffect` 补焦点。
- 改预设：`ui/editpreset.js`，只发和现在不同的字段（`buildUpdate`）。服务回 422 或 503 时，错误原文写在检查条里，弹窗不关。`app.updatePreset` 不弹提示，由弹窗写。改的是预设文件，管以后新出生的会话；已有会话不变。入口是团队行、没有进程的预设行的右键菜单，和项目概况里每个预设的“改预设”，聚焦进程的概况页不放它。
- 改这个会话（[设计稿 7.15](../docs/design/gui.md#715-改这个会话)）：用 `ui/presetform.js` 的表，初值取自 `inspect` 的会话快照（有 `next` 时取 `next`，服务以它为底改），不读预设文件。弹窗顶上写“只改这个会话，不改预设文件”。保存发 `reconfigure`，只发和初值不同的字段，去掉的发 `null`。
  - 发请求用 `api.js` 的 `tauCommand`。它要认回执 `{ type: "reconfigured", process, pending }`，和 `receipt`、`swept` 一样当作成功。服务回 `error` 时，原文写在检查条里，弹窗不关；出错什么都没改，页面不回滚。
  - 字段旁标生效时间：思考强度、`options`、换段阈值“下一次调用生效”；提示词、工具、模型、工作目录、上下文文件“换段时生效”。
  - 工具名只比集合：顺序变了不算改（`lib/session.js` 的 `sameSet`），不会发 `tools`。工作目录不分大小写和斜杠方向地比。
  - 保存键旁的勾“保存后马上换段”：要这次发的 `fields` 里有结构性字段（模型、提示词、工具、工作目录、上下文文件）才出现，只改调用参数时不出现。勾上，在 `reconfigure` 之后发一封换段信（走铭牌上“换段”的那条路，`app.handoff`）。灰掉的条件是换段信发不出去（`canHandoff`）：进程在跑，或者段里还没有助手的回复。后一种情形用不着换段，条件都满足时服务会直接采用结构性字段；段太大放不进新快照时存成待换配置（回执的 `pending` 为 `true`），要等有了助手回复、换过段才生效。勾上以后又变得不可用，就当没勾。换段信没发出去时，配置已经改了，错误原文写在检查条里。
  - 提示词只编辑用户自己写的部分，旧的拼接块（`tau-gui:agents-md` 标记）原样留着，保存时接回去，规则同预设表。
  - 工具区的按钮“重读工具定义”：把这个会话已存的工具列表（`inspect` 读到的快照里内置工具加工具定义的名字，`lib/session.js` 的 `reloadFields`）原样当作 `tools` 发一次，服务重读工具定义文件，内容变了就成为待换配置。不发表里的：表里还没保存的工具勾选不算，不然没点保存也会被存成待换配置。
  - 保存或重读失败的原文写在检查条里，连着出错时表的样子（`shownErr`）：表一动就清掉，不再占着检查条，盖住新的填写错误。
- 待换段条：概况页顶上（`ui/inspector.js` 的 `PendingBar`）。数据只有 `update.self.pending`（`watch` 的 `update` 只带 `self`，有它才出现，字段取 `pending.fields`），写“待换段：模型、提示词……”，不读 `inspect` 的 `process.next`；待换的内容在“改这个会话”里看，那个弹窗的初值取 `next`。两个键：“现在换段”走 `app.handoff`，可用条件同铭牌上的“换段”；“取消”发 `reconfigure` 带 `revert: true`。
- 换模型：`ui/switchmodel.js`。第一种换法先 `app.updatePreset`，再 `app.fork(id, undefined, preset)`；第二种直接带另一个预设分叉。`fork` 带 `preset` 时，新进程属于那个预设，带记忆的成为它的当前进程。进程 ID 会变；不想换 ID 用“改这个会话”，旧模型出故障时它换不了模型，用这里。
- 工具定义页：`ui/tools.js`，入口在设置里，hash 是 `#dlg=tools`。已装的在上，工具库在下；删和覆盖在行里确认。预设表（`ui/presetform.js`）打开时读 `/api/tools`，把已装的定义列成第二组工具开关。
- 记忆页：`ui/memory.js`，数据走 `/api/tau` 转发 `memory`、`memory_write`（`api.js` 的 `memoryRead`、`memoryWrite`），桥不用改。纯逻辑在 `lib/memory.js`：排序、折叠、编辑状态（值和摘要）、读写回复（`interpretWrite`）、冲突（`afterConflict`，带别处的摘要）。值只能是字符串；键、值、摘要的字节上限由服务查，页面不抄。保存的 `set` 总是带 `brief`，不用服务的缺省（D81）。
  - 写冲突时服务回的 `current`（别处现在的值和版本号，或键已被删的 `null`）就是新的 `base`：用户写的字留着，别处的值列在文本框下，再按保存才覆盖。删除冲突不重试，只重读。
  - 一次只开一个编辑；编辑开着时其它行的“改”“删”不可用。
  - 页面不显示给模型看的视图，只显示库里的键值。
- 设置：`ui/settings.js`。外观（主题、动效）、默认模型、默认思考强度、完成通知改一项记一项。清理的天数不在这里，只在清理弹窗里改（`cleanDays` 还是同一个键）。供应商一行（`ProviderRow`）右边是填、换、清的动作，哪些可用由 `lib/models.js` 的 `keyActions` 定（`auth.json` 读不出时都没有；OAuth 登录的只有“登出”，没有填 key）；填 key 的密码框（`KeyEdit`）输入只留在组件里，收起就丢，保存成功后 `app.reloadModels()`；清掉（OAuth 登录的叫登出）点两次，失焦还原。设置页的说明里写着终端登录的命令。接口 `api.js` 的 `setKey`、`clearKey`。
- 界面数据写失败以后 30 秒内不再自动写（清理旧键），不会反复重试。
- 信的来历读段里消息的 `tau`（`lib/messages.js` 的 `parseUser`），不解析文字：
  - 一封信的发送者、跳数、`replyTo`（写信时它在等回信）、回信的结束原因来自 `tau.letters`；正文是消息文本里 `at` 指的那段。
  - 上一轮的说明来自 `tau.after`，换段后的第一条来自 `tau.handoff`（说明和带过来的信用 `at` 切），被中断和未执行的工具结果来自 `tau.filled`，一轮的开头看 `tau.after` 和 `tau.handoff`。
  - 没有 `tau` 的旧消息按普通用户消息显示，整段文字一封信。文字被截过的消息没有 `at`，整段文字当一封信，发送者取第一封。
  - 后台任务的完成通知（`bash` 转入后台以后跑完寄的信，老的 `bg_run` 也一样）在 `tau` 里也是用户的信，界面靠正文开头的 `[后台任务 <名字>] ` 认出来，显示“后台任务 · 名字”，不显示“你”（`bgName`）。前缀由 `src/tools/notify.ts` 写，字符和空格要和它一致。消息流、这一轮的开头、详情栏的信箱都这样标。
  - 还认的固定文字是 `HANDOFF_HEADER`、`CARRY_HEADER`（只用来从新段第一条里切出交接说明）和上面那个后台任务前缀。别的不解析。
- “换段”：`app.handoff` 用 `send` 带 `handoff: true` 寄 `HANDOFF_LETTER`（一封说明没有别的事要做的信）。段里已有助手消息才生效（`lib/messages.js` 的 `canHandoff`，[kb-kernel 的换段信](kb-kernel.md#换段信)）；进程在跑、或者段里还没有助手消息时按钮禁用。
- 详情栏的数据（`lib/derive.js`，用 `inspect` 的原样记录和 `limits`，加 `update` 里的 `self`，不读别的）：
  - 段尺的刻线：`limits.threshold`（按会话快照算，存在 `Frozen.threshold`。`reconfigure` 能改 `handoff`，所以每次读 `inspect` 都更新，不是建好后读一次）。位置是 `threshold / context.window`，已用到阈值的 `NEAR_RATIO`（0.9）以上变警告色（`rulerOf`）。`context.window` 和已用来自 `update` 的 `self.context`。
  - 待换配置：`update.self.pending` 说有没有、差在哪些字段；`process.next` 是待换的完整快照（读法见“待换段条”）。
  - 排队的信：`process.phase.turn.queued`。只有在跑的阶段才有。信本身没有时间，所以不显示时间（`mailOf`）。
  - 等它回信的：它这一轮的 `turn.replyTo`，加排队的信里的 `replyTo`。它在等的：别的在跑的进程，`turn.replyTo` 或排队的信的 `replyTo` 是它。推不出来的不写。
  - 概况页开着时每 10 秒读一次全部 `inspect`，阶段、排队数、消息数变了马上再读。
- 图片：`lib/image.js` 放常量和纯函数（`fitSize`、`isFit`、`attempts`、`room`），`prepare` 里是 canvas，只在浏览器跑。`ui/attach.js` 是贴、拖、选文件共用的钩子和小件，写信框和总管输入框都用。模型不收图片：`Frozen.input`（`process.preset.input`）里没有 `image`（`refusesImages`）；总管还没有进程时看模型目录的 `image`。
- 只跟最近看过的几个进程读全部历史。别的进程只读当前段最后一条消息，拿到最后动静的时间。

## 测试

| 文件 | 测什么 |
|---|---|
| `test/extras/gui/bridge.test.ts` | 每条检查的反例；GET 不出目录；转发对着测试服务（临时目录、测试管道、faux 模型），含 `watch` 分块推送和浏览器断开；预设经 `check` 读（带 `options` 的读得出、读不出和装不下的错误文字和 `start` 一字不差、服务不在回 503）、新建不覆盖和删除；`inspect` 转发读到会话快照；换段信真的换段、信带进新段；`reconfigure` 经桥转发，回执 `reconfigured` 原样返回；git 带 `--no-optional-locks`、工作目录不对时拒绝；界面数据改名写入；模型目录和 pi-ai 一致、key 状态四种（含已登录）且值不进回复；填 key 遇 OAuth 拒绝，清掉就是登出，不认识的条目可换可删、auth.json 坏了或不存在、改了不用重启；改预设只换收到的字段（顺序、CRLF、BOM、正文原样，`null` 删行）、读不出或起不来改回旧文件、服务不在改回去、请求不合法；新建带 `handoff`、`options`、`context`，`context` 给 `null` 删行 |
| `test/extras/tools/tools.test.ts` | 工具库：`peek`、`wait` 的脚本在真的服务和 Git Bash 里跑（peek 的输出；wait 等到结束、超时、停止）；桥的列、装、改过后拒绝覆盖、更新、预设用到时拒删；库里全部的定义装好以后内核 `check` 读得出。历史检索的两个脚本和 `web_search` 不在这里，见 [kb-extras 的工具库](kb-extras.md#工具库) |
| `test/extras/gui/service.test.ts` | 旧代码的判断（修改时间对比、服务不在、缓存和作废）；重启接口（有进程在跑回 409 且不动、`force`、只重启桥、参数不对）用假的 runner 和假的 `ps`，另有生成的重启命令行和真跑一次 powershell 的“父进程退出后孙进程还在”；`/web/` 的缓存头；只读凭据库；界面数据的字段和进程被清掉后的清理；助手文字第一行去标记 |
| `test/extras/gui/agentsmd.test.ts` | 上下文文件和旧的拼接块：认出和去掉旧块（CRLF、BOM、手写的末尾空行字节不变）、给了 prompt 块留着、没有结束标记当没有块；接口：`/api/agents-md`、新建勾选写 `context: AGENTS.md` 而不拼块、CLAUDE.md 不认、列表里 `agentsMd` 只有 `none` 和 `legacy`、`agentsMd: false` 去块、`true` 回 400、转成上下文文件（去块加 `context`，已有不重复）、`context` 加上以后装不下窗口改回旧文件 |
| `test/extras/gui/memory.test.ts` | 记忆页的纯逻辑（字节序排序、折叠、编辑状态、写回复的判读、冲突后字和版本的处理、摘要）；经桥对着真的服务：新键带摘要、改值不丢摘要、兄弟先写造成的冲突不覆盖、删、已删键的冲突、超限（含摘要超限） |
| `test/extras/gui/image.test.ts` | 图片常量和 `src/` 的真常量一致；缩放尺寸、原样发的条件、压缩尝试的顺序、张数；快照多带的输入类型和阈值、不收图片的判断；段尺比例和九成警告；排队的信、谁在等谁、后台任务的通知标成后台任务 |
| `test/extras/gui/lib.test.ts` | 纯逻辑：信的来历读 `tau`（发送者、跳数、回信、`after`、换段、`filled`，旧消息、被截过的消息）、后台任务的通知认前缀（名字的字符、空格、不是进程的信不认）、`canHandoff`、进程按会话快照归类、增量读跨换段、重连后不丢不重、标题、当前进程、筛选计数、全部停止和清理的顺序、删进程的拒绝条件、`prunePatch`；模型选择（窗口的写法、思考级别取最近一档、搜索、供应商排序、最近用过、默认模型、key 提示）、预设表变成请求（只发变了的字段）、会话表变成 `reconfigure` 的 `fields`（只发变了的，去掉的发 `null`）、重读工具定义发已存的工具列表、保存失败的原文表一动就不显示、转成上下文文件要项目里有 `AGENTS.md`（`convertGate`、`convertPatch`）、待换段条的字段名、换模型的补丁、界面数据的新键、快照多带的几项；流式文本按 `kind` 分开、watch 推来的消息并进缓存（重复、跳号、换段）、末尾几条的推送并进；吐字的节奏（平稳的小块、成批到、收尾追平、一次来一大块）和 `latestSeq`；Markdown（GFM、原始 HTML 转义、链接和图片的过滤、代码块）；通知（谁刚进入待你看、该不该弹、正文、标题）；`notify` 键 |

## 坑点

- **普通的 `git status` 会写 `index.lock`。** 一律带 `--no-optional-locks`（[设计稿第 1 节](../docs/design/gui.md#1-定位)）。
- **宽屏的五块只能排成一行。** 多行的 flex 容器里，一行的高度跟着最高的那一块走。`.shell-body` 一换行，详情栏一长就把主区撑高，写信框被推出屏幕，消息区也滚不到底。所以只在窄于 1180 时才换行。
- **服务的环境变量会进 Agent 的 bash。** 起服务的那个程序的环境原样传下去，所以从干净的终端起（见[启动](#启动)）。
- **连管道不能半关闭。** 见 [kb-service 的坑点](kb-service.md#坑点)。
- **`index.html` 只在桥启动时读一次。** import map 是内联脚本，桥启动时算它的哈希写进 CSP。改了 `index.html` 要重启桥。其余静态文件每次请求现读，带 `no-cache`，浏览器每次校验。
- **重启服务会中断在跑的进程。** 在跑的库外副作用（工具调用）按崩溃处理，报“被中断”，不自动重做。所以界面在有进程在跑时先确认，桥的 `/api/service/restart` 也拦。
- **`detached: true` 起不了 powershell。** Windows 上那样起的 `powershell.exe` 立刻 `exit 0`，命令一行都不执行；`detached` 起 `cmd.exe` 也一样。不 detached 的子进程又会被桥的死带走。所以重启走 `Start-Process` 这一层：桥起 powershell，powershell 起孙进程。桥被杀时孙进程已经在跑——`restart.ps1` 把停桥放在最后，中间隔着重启服务的几秒。验证重启成功看 node 进程的 PID 和创建时间，别看回执：`/api/service/restart` 的 202 只说明脚本被起了。

## 关联模块

- [kb-extras.md](kb-extras.md)：上层的通用规则，桥的检查。
- [kb-service.md](kb-service.md)：线协议、历史和订阅。
- [界面设计稿](../docs/design/gui.md)：界面的规则。
