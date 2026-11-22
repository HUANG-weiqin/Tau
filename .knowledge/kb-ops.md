# 运维

`updated: 2026-11-21`

本页负责：这台机器上 tau 怎么跑、怎么重启、怎么查库、怎么备份和恢复、怎么清理、出问题时按什么顺序查。不负责原理，细节链到各自的页。

主管预设把本页放进 `context`（[D72](kb-decisions.md#d72-上下文文件开段重读)），所以这里只写“怎么做”和“先问谁”。

## 先理解什么

按顺序读：`AGENTS.md` → [INDEX](INDEX.md) → [总览的认知模型](kb-overview.md#认知模型) → [kb-contract](kb-contract.md)。看完这四样，再按任务查模块页。要判断一个功能放内核还是上层，读[取舍顺序](kb-extending.md#取舍顺序)。

## 运行时

- 服务：仓库根 `./tau serve`（`node src/main.ts serve`）。它监听命名管道 `\\.\pipe\tau`，监听成功才算持锁，同一时间只能有一个。
- 看进程：`./tau ps`；发信：`./tau send <进程> "<信>"`；停一轮：`./tau stop <进程>`。
- 界面桥：`node extras/gui/bridge/main.ts --port 4317`，浏览器开 `http://127.0.0.1:4317/`。桥不拉起服务；服务不在时界面只有历史，写不了。
- 数据：`~/.tau/tau.db` 是库（`user_version` 6，表见 [kb-store](kb-store.md)）；`~/.tau/presets/`、`~/.tau/tools/` 是文件；`~/.tau/auth.json` 是凭据；`~/.tau/extras/` 是上层数据，不进库；其中只有领地 `extras/home/` 由备份脚本拷走（[kb-extras 的领地](kb-extras.md#领地)）。
- 一个进程 = 会话快照 + 信箱 + 状态，消息在库里。换段只加段，不删旧段（`prune` 才删）。

## 改完代码以后

- 改 `src/`（内核、服务）：要重启服务才生效。
- 改 `extras/gui/bridge/` 或它的预设/工具定义读取：重启桥。
- 改 `extras/gui/web/` 的静态文件：刷新浏览器就生效。
- 重启会中断正在跑的一轮：它们以“被中断”结束，进程和信都还在，库外副作用不会重做。重启前先 `./tau ps`，有进程在跑先问用户。
- 重启：界面设置页的“重启”（桥转发 `extras/gui/restart.ps1`），或者手动结束 `node src/main.ts serve` 再起。

## 查库

- 只读：`node:sqlite` 的 `new DatabaseSync(path, { readOnly: true })`，别在服务跑着时写库。
- 表：`processes`（进程记录、`state_json`）、`segment_messages`（每段每条消息）、`mailbox`、`effects`、`memory`、`blobs`（图片）。
- 记忆在 `memory` 表，按 `ns`（预设 ID）分。删进程不删记忆。
- 手改库只在没有服务、并且刚做过备份时做；改完跑一次打开库的完整性检查（`.smoke/rehearse.mjs` 的做法）。改表结构必须带迁移（[D74](kb-decisions.md#d74-迁移的规矩)）。

## 备份与恢复

- 备份：`node extras/backup.ts`。默认写到 `~/.tau/extras/backup/`，留 14 份，文件名按时间排序。每份是库 `tau-<时间>.db`，加领地的拷贝 `tau-<时间>.home/`。参数和退出码见 [kb-extras 的备份](kb-extras.md#备份)。
- 计划任务：本机还没有建（2026-11-22 查过，`tau-backup` 不存在）。命令见 [kb-extras 的备份](kb-extras.md#备份)。
- 演练：`.smoke/rehearse.mjs` 在备份副本上开库，看 `user_version`、`integrity_check`、进程/消息/图片/记忆的行数。
- 恢复：停服务 → 把备份复制成 `~/.tau/tau.db` → 删掉 `tau.db-wal` 和 `tau.db-shm` → 起服务。顺序反了会把旧库和旧 WAL 混在一起。
- 恢复领地：不用停服务。把 `<备份目录>/tau-<时间>.home/<预设 ID>/` 拷回 `~/.tau/extras/home/`。先问用户：拷回会盖掉 Agent 之后写的东西。

## 清理

- 删进程：协议的 `remove`，一次一个，从叶子删起；连带子树，删的是进程和它的全部段，记忆不动。有子进程、有进程在等它回信、信箱里有输入时会被拒绝。
- 删旧段：协议的 `prune`；清没人引用的图片：`sweep`。
- 自动清 7 天前的：bash 输出 `~/.tau/extras/shell/`、历史 `~/.tau/extras/history/`。有 claim 的 log 不清（命令可能还在跑）。
- 别删在跑的进程，也别试图删自己。删之前想清楚要不要先备份。

## 排错顺序

1. `./tau ps` 有没有输出：没有就是服务不在，或者管道名不对（`TAU_PIPE`）。
2. 服务进程在不在（`node src/main.ts serve`），启动目录对不对（仓库根）。
3. 界面打不开：桥在不在（4317），`/api/service` 怎么说。
4. 具体的错：`EPERM`/`EBUSY` 是文件被占（谁占着、进程退干净没有）；模型 4xx 看凭据和模型 ID；工具报“找不到模块”多半是会话快照还指着已删的脚本，换段或重开。
5. 跑完全量测试后列一下 node 进程，杀掉残留（`tau-mcp-grandchild`、`notify.ts`），它们会占住临时目录，让下一次清理报 `EPERM`。

## 先问用户

改真库、删数据（进程、段、记忆）、重启服务（会中断在跑的轮次）、动别人的进程、动 `~/.tau/auth.json`。这五样做完不能撤销，或者会让别人白干。
