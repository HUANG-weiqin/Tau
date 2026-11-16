// CLI 和服务之间唯一的线协议（见 .knowledge/kb-service.md）。每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭。
import type { Projection } from "./kernel/observe.ts";
import type { Ended, Message } from "./kernel/types.ts";

export const PIPE = "\\\\.\\pipe\\tau";

export type Request =
  /** `images` 是 base64 字符串，按入口检查（设计稿 5.6）。 */
  | { op: "start"; preset: string; text: string; images?: string[] }
  | { op: "send"; process: string; text: string; images?: string[] }
  | { op: "stop"; process: string }
  | { op: "ps" }
  /** 从进程当前段里一条用户消息（段内序号 `before`）前面分叉出新进程；不带 `before` 复制整个当前段。回执带新进程的 ID。 */
  | { op: "fork"; process: string; before?: number }
  /** 读一段的消息，从段内序号 from 起。段默认是当前段，from 默认是 0。 */
  | { op: "history"; process: string; segment?: number; from?: number }
  /** 读一张图片。`hash` 不带 `blob:` 前缀。 */
  | { op: "blob"; hash: string }
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
  /** blob 的回复：类型由魔数现算，data 是 base64。 */
  | { type: "blob"; mimeType: string; data: string }
  | { type: "update"; self: Projection["self"] }
  | { type: "error"; message: string };
