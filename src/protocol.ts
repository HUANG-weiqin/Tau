// CLI 和服务之间唯一的线协议（见 .knowledge/kb-service.md）。每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭。
import type { Projection } from "./kernel/observe.ts";
import type { Ended, Message } from "./kernel/types.ts";

export const PIPE = "\\\\.\\pipe\\tau";

export type Request =
  | { op: "start"; preset: string; text: string }
  | { op: "send"; process: string; text: string }
  | { op: "stop"; process: string }
  | { op: "ps" }
  /** 读一段的消息，从段内序号 from 起。段默认是当前段，from 默认是 0。 */
  | { op: "history"; process: string; segment?: number; from?: number }
  /** 订阅变化，直到客户端断开。不带 process 时订阅全部进程。 */
  | { op: "watch"; process?: string };

export type Reply =
  /** 命令写进库的事务提交之后才发。 */
  | { type: "receipt"; process: string }
  /** 流式文本，只是预览。n 是产生它的副作用编号，客户端用它丢掉过时的文本。 */
  | { type: "text"; process: string; n: number; delta: string }
  /** 进程回到 idle 后，从库里取出的最终回复和结束原因。 */
  | { type: "final"; reply: string; ended: Ended | null }
  | { type: "ps"; processes: Projection[] }
  | { type: "message"; segment: number; seq: number; message: Message }
  /** history 读完：这一段的段号和消息条数。没收到它就断开，是没读完。 */
  | { type: "end"; segment: number; messages: number }
  /** watch 的快照和增量：进程此刻的 self 部分。 */
  | { type: "update"; self: Projection["self"] }
  | { type: "error"; message: string };
