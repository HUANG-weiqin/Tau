# 总览

`updated: 2026-11-15`

## 这个模块是干什么的

tau 是本机常驻的个人 Agent harness，目标是连续运行很多年。

tau 负责：

- 进程的生命周期：启动、并行、停止、换段。
- 信箱和事务：所有输入怎样排队，状态怎样提交。
- 记忆：Agent 的长期知识。
- 投影：用户和 Agent 看到的同一份状态视图。

tau 不负责：

- Git、编辑器、终端能完整做到的事：diff、历史、回滚、文件浏览、交互式 shell。
- 设计稿里 [MVP 不做](../docs/design/mvp.md#mvp-不做) 的一切。

用词、必须遵守的规则和准入规则在 [AGENTS.md](../AGENTS.md)。三种 Agent 怎样写成预设，见[设计稿第 2 节](../docs/design/mvp.md#2-预设)。

## 架构

### 运行循环

```text
输入（用户消息 / 副作用结果 / 停止）
        ↓
   信箱（SQLite）
        ↓  按到达顺序一次取一条
   decide：纯函数，算出新的进程记录和要追加的消息
        ↓  一条输入一个事务（步骤见 kb-store.md）
   effectOf：纯函数，算出进程在等的副作用
        ↓  库内副作用在事务里执行；库外副作用进待办副作用表
        ↓
   执行器：开始 / 中止 / 上报
        ↓
   副作用结果作为新输入回到信箱

   observe：纯函数，给 CLI 的 tau ps 和 Agent 的 self 工具用
```

### 状态分三层

| 层 | 内容 | 能否持久 | 崩溃后 |
|---|---|---|---|
| 库 | 进程记录、工作段、信箱、待办副作用、记忆 | 能 | 原样恢复 |
| 执行器活状态 | 子进程、模型流、中止开关 | 不能 | 正在运行的库外副作用全部作为“被中断”送回 |
| 观察者 | CLI 连接、流式文本 | 不需要 | 重连后重新拉取投影 |

## 决策

跨模块的决定和理由见 [kb-decisions.md](kb-decisions.md)。

## 认知模型

从零重建 tau 只需要四样东西：

1. 纯函数 `decide` 和 `effectOf`。
2. 一个信箱，加上“一条输入一个事务”。
3. 一个只会开始、中止、上报的执行器。
4. 一个纯函数 `observe`。

## 投影与命令

投影的内容见[设计稿第 9 节](../docs/design/mvp.md#9-自省)，字段见 [kb-kernel.md](kb-kernel.md#投影与命令)。

## 入口

| 路径 | 内容 | 细节 |
|---|---|---|
| `src/main.ts` | `tau serve` 启动服务；其余命令交给 CLI | [kb-service.md](kb-service.md#启动脚本和入口) |
| `src/server/serve.ts` | 把库、执行器和管道装配起来；`pump` 处理信箱、开始副作用 | [kb-service.md](kb-service.md) |
| `src/server/listen.ts` | 在命名管道上监听，监听成功就是单实例锁 | [kb-service.md](kb-service.md) |
| `src/cli/main.ts`、`src/protocol.ts` | 命令行和线协议；CLI 只依赖协议 | [kb-service.md](kb-service.md) |
| `src/kernel/` | 纯函数：`decide`、`effectOf`、`observe`、`buildContext`、派生值、工具描述 | [kb-kernel.md](kb-kernel.md) |
| `src/store/` | 表、处理输入的事务、库内工具 | [kb-store.md](kb-store.md) |
| `src/executor/` | 库外副作用的开始、中止、上报，启动恢复 | [kb-executor.md](kb-executor.md) |
| `src/memory/kv.ts` | `Memory` 接口的 SQLite 实现 | [设计稿第 8 节](../docs/design/mvp.md#8-记忆) |
| `src/tools/` | `read`、`write`、`edit`、`bash` | [kb-tools.md](kb-tools.md) |
| `src/presets/load.ts` | 读预设文件，生成快照 | [设计稿第 2 节](../docs/design/mvp.md#2-预设) |

测试在 `test/`，按模块分目录；执行器的测试在 `test/store/`。命令：`npm test`、`npm run typecheck`、`npm run loc`。完成门槛见 AGENTS.md，当前进度见[执行清单](../docs/plan/mvp-checklist.md)。

## 坑点

这些错误不容易从规则本身看出来：

- 把 Agent 当成运行时对象：并行和记忆归属会乱。Agent 只是预设的 ID。
- 崩溃后猜测外部世界：未知就报告未知，让模型决定下一步。
- 用摘要压缩“修好”长上下文：用换段。
- 加一个“很便宜”的机制：每个都便宜，加起来就不便宜。先问 YAGNI。

## 关联模块

- [kb-kernel.md](kb-kernel.md)、[kb-store.md](kb-store.md)、[kb-executor.md](kb-executor.md)、[kb-tools.md](kb-tools.md)、[kb-service.md](kb-service.md)
- [kb-decisions.md](kb-decisions.md)
- [kb-piweb-lessons.md](kb-piweb-lessons.md)
