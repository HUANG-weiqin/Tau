// CLI 和服务之间唯一的线协议（见 .knowledge/kb-service.md）。每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭。
import type { Limits } from "./kernel/derive.ts";
import type { Projection } from "./kernel/observe.ts";
import type { Ended, Instant, MemoryFailure, MemoryOp, Message, PresetSnapshot, Process } from "./kernel/types.ts";

export const PIPE = "\\\\.\\pipe\\tau";

export type Request =
  /** `images` 是 base64 字符串，按入口检查（设计稿 5.6）。 */
  | { op: "start"; preset: string; text: string; images?: string[] }
  /** `handoff` 为真：换段信（D64 第 7 组），这封信写进段时，下一次调用的用途是 handoff。 */
  | { op: "send"; process: string; text: string; images?: string[]; handoff?: boolean }
  | { op: "stop"; process: string }
  | { op: "ps" }
  /** 从进程当前段里一条用户消息（段内序号 `before`）前面分叉出新进程；不带 `before` 复制整个当前段。带 `preset` 是换角色：用这个预设的快照和记忆。回执带新进程的 ID。 */
  | { op: "fork"; process: string; before?: number; preset?: string }
  /** 读一段的消息，从段内序号 from 起。段默认是当前段，from 默认是 0。 */
  | { op: "history"; process: string; segment?: number; from?: number }
  /** 读一张图片。`hash` 不带 `blob:` 前缀。 */
  | { op: "blob"; hash: string }
  /** 原样读进程记录。不带 `process` 回全部，按 ID 升序；没有这个进程回 `error`。不开事务，不调 `pump`。 */
  | { op: "inspect"; process?: string }
  /** 干跑预设的读取和启动检查，和 `start` 用同一个读预设的函数。不读库。 */
  | { op: "check"; preset: string }
  /** 读记忆：带 `ns` 回这个 ns 的键，不带回有键的全部 ns。`ns` 要过预设 ID 的检查，不要求预设存在。只读，不开事务。 */
  | { op: "memory"; ns?: string }
  /** 写记忆：`ops` 非空，按顺序在一个事务里执行，第一个失败整批回滚。`set` 的 `expected` 是 null 或正整数，`delete` 的是正整数；没有不带版本号的强写。 */
  | { op: "memory_write"; ops: MemoryOp[] }
  /** 订阅变化，直到客户端断开。不带 process 时订阅全部进程。 */
  | { op: "watch"; process?: string }
  /** 删这个进程段号小于 `before` 的旧段。当前段不删；`before` 大于当前段号回 `error`。回执。 */
  | { op: "prune"; process: string; before: number }
  /** 删一个空闲、没人引用的进程的记录和全部段。拒绝回 `error`。成功时先给订阅推 `removed`，再回执。 */
  | { op: "remove"; process: string }
  /** 清掉没人引用的图片，回 `swept`。 */
  | { op: "sweep" };

export type Reply =
  /** 命令写进库的事务提交之后才发。 */
  | { type: "receipt"; process: string }
  /** 流式文本，只是预览。n 是产生它的副作用编号，客户端用它丢掉过时的文本。 */
  | { type: "text"; process: string; n: number; delta: string }
  /** 进程回到 idle 后，从库里取出的最终回复和结束原因。 */
  | { type: "final"; reply: string; ended: Ended | null }
  | { type: "ps"; processes: Projection[] }
  /** inspect 的每个进程一行：原样的记录，当前段的条数（同一次读取），按它的快照算的限度。 */
  | { type: "process"; process: Process; messages: number; limits: Limits }
  /** inspect 的结束行。没收到它就断开，是没读完。 */
  | { type: "inspected"; count: number; now: Instant }
  /** check 读得出时的回复：`error` 是启动检查的原文，`null` 表示此刻能启动。 */
  | { type: "check"; snapshot: PresetSnapshot; limits: Limits; error: string | null }
  /** memory 带 ns 的回复：按键的 UTF-8 字节序。 */
  | { type: "memory"; ns: string; entries: { key: string; value: string; version: number }[] }
  /** memory 不带 ns 的回复：有键的全部 ns。 */
  | { type: "namespaces"; ns: string[] }
  /** memory_write 成功：每一项的版本，删除是 null。 */
  | { type: "memory_written"; versions: (number | null)[] }
  /** memory_write 被拒绝（正常回复，不是 error）：第一个失败的下标，和 `Memory` 的失败形状。整批已回滚。 */
  | { type: "memory_rejected"; index: number; result: MemoryFailure }
  | { type: "message"; segment: number; seq: number; message: Message }
  /** history 读完：这一段的段号和消息条数。没收到它就断开，是没读完。 */
  | { type: "end"; segment: number; messages: number }
  /** watch 的快照和增量：进程此刻的 self 部分。 */
  /** blob 的回复：类型由魔数现算，data 是 base64。 */
  | { type: "blob"; mimeType: string; data: string }
  | { type: "update"; self: Projection["self"] }
  /** watch 推送：这个进程已删。订阅这个进程的连接随后关闭。 */
  | { type: "removed"; process: string }
  /** sweep 的回复：删掉的图片行数。 */
  | { type: "swept"; blobs: number }
  | { type: "error"; message: string };
