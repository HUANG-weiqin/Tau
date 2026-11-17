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
| `extras/package.json` | 上层的依赖，精确锁定（[D63](kb-decisions.md#d63-上层的依赖随便加)） |
| `extras/gui/bridge/main.ts` | 桥的入口，Node 直接运行 |
| `extras/gui/bridge/*.ts` | 桥的各部分：检查和路由、转发、预设、git、后台命令、界面数据、选文件夹 |
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
- 管道：`TAU_PIPE` 有值就用它，否则用 `\\.\pipe\tau`，和 CLI 一样。
- `start.ps1`：管道不在就起服务，端口没人听就起桥，都和终端脱开，日志写进 `~/.tau/extras/gui/`。然后打开页面。不做开机自启。

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
| `/vendor/<包>/<路径>` | `extras/node_modules/<包>/` 下的文件。包只认 `preact`、`htm`、`@fontsource-variable/archivo`、`@fontsource-variable/jetbrains-mono`、`@fontsource-variable/noto-sans-sc` |

- 路径解析以后不许出对应的目录。找不到回 404。
- `Content-Type` 按扩展名定。
- `index.html` 里的 import map 是内联脚本。桥启动时算出它的 SHA-256，写进 `Content-Security-Policy` 的 `script-src`。其余见 [kb-extras 的检查](kb-extras.md#http-桥要做的检查)。

### POST 接口

请求的正文是 JSON 对象。出错回 4xx 或 5xx，正文 `{ "error": "<中文原因>" }`。

| 路径 | 请求 | 回 |
|---|---|---|
| `/api/tau` | 一条协议请求 | 管道回的每一行原样分块写回，管道关闭就结束。浏览器断开，桥就断开管道。连不上管道回 503 |
| `/api/presets` | `{}` | `{ presets }`，见下 |
| `/api/presets/create` | `{ id, workdir, model, tools, thinking?, prompt }` | `{ ok: true }`。文件已经存在回 409，不覆盖 |
| `/api/git` | `{ workdir, what, file? }` | 见下 |
| `/api/bg` | `{ processes }` | `{ logs }`，见下 |
| `/api/state` | `{ set? }` | `{ state }`。`set` 的每个顶层键覆盖进文件，再回整个文件 |
| `/api/pick-folder` | `{}` | `{ path }`，取消时是 `null` |

`/api/tau` 只查正文是带字符串 `op` 的对象，其余交给服务校验。

预设：

- 解析照内核的读取规则（[设计稿第 2 节](../docs/design/mvp.md#2-预设)）：两行 `---` 之间是 `键: 值`，认 `workdir`、`model`、`tools`、`thinking`、`handoff`。不查模型目录。
- 每个预设回 `{ id, ok: true, workdir, model, tools, memory, thinking?, handoff? }`。`memory` 是 `tools` 里有没有 `memory`。读不懂的回 `{ id, ok: false, error }`，照样列出。
- 新建时只写认识的字段，提示词写在第二个 `---` 后面。ID 只许字母、数字、`.`、`_`、`-`，工作目录必须是存在的绝对路径。

git：

- 一律 `git --no-optional-locks -C <工作目录> …`，不经 shell，有超时。
- 工作目录必须是某个预设的 `workdir`，或者界面数据 `folders` 里的文件夹。否则回 403。比较时不分大小写。
- `what`：
  - `status`：`{ repo, branch?, files }`。每个文件 `{ path, status, add, del }`，`status` 是 porcelain 的两个字母，`add`、`del` 来自 `diff --numstat HEAD`，拿不到时是 `null`。不是仓库时 `{ repo: false }`。
  - `diff`：`{ text, truncated }`。已跟踪的文件用 `diff HEAD -- <文件>`，未跟踪的用 `diff --no-index`。超过 256 KB 截断。
  - `log`：`{ commits }`，最近 30 个。每个 `{ hash, short, subject, author, time }`。
  - `branches`：`{ main, branches }`。主分支是 `main`，没有就 `master`，都没有是 `null`。每个分支 `{ name, current, ahead, behind, merged, add, del }`，和主分支比。

后台命令：

- 列出 `extras/bg/` 下以这些进程 ID 开头的 log。
- 每个回 `{ process, name, size, mtime, tail, exit }`。`tail` 是最后 8 KB。`exit` 取最后一行 `[后台任务 <名字>] 退出码 N` 的 N，没有是 `null`。

### 界面数据

`~/.tau/extras/gui/state.json`。桥只查它是 JSON 对象，有大小上限。写的时候先写临时文件再改名。键由页面定：

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
| `seen` | 进程 ID → 第一次见到时的预设：`{ workdir, tools, memory }` |
| `collapsed` | 折叠状态 |
| `cleanDays` | 清理的天数，默认 7 |

### 页面

- 打开时先读界面数据和预设，再 `ps`，再 `watch`（不带 `process`）。被断开就等一会儿重连，从 `ps` 重来。
- 每条 `update` 换掉这个进程的 `self`。聚焦的进程段号或条数变了，就按设计稿第 10 节增量读 `history`。
- `text` 按进程存，`n` 变了就清掉重来。进程离开 `awaitingModel`，就清掉它的流式文本。
- 进程归到哪个项目、常驻还是临时：先看 `seen`，没有就用当前的预设文件，并记进 `seen`。
- 段号从 1 开始。临时进程的标题取第 1 段第一条用户消息的第一行；第一行是信头 `（来自…）` 时取第二行。

## 测试

| 文件 | 测什么 |
|---|---|
| `test/extras/gui/bridge.test.ts` | 每条检查的反例；GET 不出目录；转发对着测试服务（临时目录、测试管道、faux 模型），含 `watch` 分块推送和浏览器断开；预设的解析和新建不覆盖；git 带 `--no-optional-locks`、工作目录不对时拒绝；界面数据改名写入 |
| `test/extras/gui/lib.test.ts` | 纯逻辑：增量读跨换段、重连后不丢不重、标题、当前进程、筛选计数、全部停止和清理的顺序 |

## 坑点

- **普通的 `git status` 会写 `index.lock`。** 一律带 `--no-optional-locks`（[设计稿第 1 节](../docs/design/gui.md#1-定位)）。
- **连管道不能半关闭。** 见 [kb-service 的坑点](kb-service.md#坑点)。
- **import map 是内联脚本。** 改了 `index.html` 的 import map，桥要重启才能算出新的哈希。

## 关联模块

- [kb-extras.md](kb-extras.md)：上层的通用规则，桥的检查。
- [kb-service.md](kb-service.md)：线协议、历史和订阅。
- [界面设计稿](../docs/design/gui.md)：界面的规则。
