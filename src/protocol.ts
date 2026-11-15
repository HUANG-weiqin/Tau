// CLI 和服务之间唯一的线协议（见 .knowledge/kb-service.md）。每个连接：客户端发一行 JSON 请求，服务回若干行 JSON，然后关闭。
import type { Projection } from "./kernel/observe.ts";
import type { Ended } from "./kernel/types.ts";

export const PIPE = "\\\\.\\pipe\\tau";

export type Request =
  | { op: "start"; preset: string; text: string }
  | { op: "send"; process: string; text: string }
  | { op: "stop"; process: string }
  | { op: "ps" };

export type Reply =
  /** 命令写进库的事务提交之后才发。 */
  | { type: "receipt"; process: string }
  /** 流式文本，只是预览。 */
  | { type: "text"; delta: string }
  /** 进程回到 idle 后，从库里取出的最终回复和结束原因。 */
  | { type: "final"; reply: string; ended: Ended | null }
  | { type: "ps"; processes: Projection[] }
  | { type: "error"; message: string };
