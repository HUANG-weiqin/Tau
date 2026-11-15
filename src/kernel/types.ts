// 内核的全部类型。外部类型只能 import type（见 .knowledge/kb-kernel.md）。
import type { AssistantMessage, Context, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage };

/** 工作段里只有这三种消息。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ProcessId = string;
/** 毫秒时间戳。 */
export type Instant = number;

export type PresetTool = "read" | "write" | "edit" | "bash" | "memory";

/** 启动时冻结的预设。 */
export interface PresetSnapshot {
  id: string;
  workdir: string;
  /** `<provider>/<model-id>` */
  model: string;
  tools: PresetTool[];
  prompt: string;
  contextWindow: number;
}

export interface Process {
  id: ProcessId;
  preset: PresetSnapshot;
  createdAt: Instant;
  segment: { seq: number; memoryView: string };
  /** 最后发出的副作用编号，从 0 开始。进程在等的副作用就是这个编号。 */
  lastEffect: number;
  phase: Phase;
}

export interface Turn {
  steps: number;
  queued: string[];
}

export type Purpose = "turn" | "handoff";

export type Phase =
  | { tag: "idle"; ended?: Ended }
  | { tag: "awaitingModel"; turn: Turn; purpose: Purpose }
  | { tag: "awaitingTool"; turn: Turn };

export type Ended = "done" | "stepLimit" | "stopped" | { error: string };

export interface ToolResultContent {
  text: string;
  isError: boolean;
}

export type Input =
  | { kind: "userMessage"; text: string }
  | { kind: "modelResult"; n: number; outcome: { status: "ok"; message: AssistantMessage } | { status: "interrupted" } }
  | { kind: "toolResult"; n: number; outcome: { status: "ok"; content: ToolResultContent } | { status: "interrupted" } }
  | { kind: "stop" };

export interface Env {
  now: Instant;
  /** 这个进程的记忆库现在的视图；没有记忆库时为空。 */
  memoryView: string;
}

export type Effect =
  | { kind: "callModel"; n: number; purpose: Purpose }
  | { kind: "runTool"; n: number; call: ToolCall };

export type ModelRequest = Context;

export interface Versioned {
  value: string;
  version: number;
}

/** 记忆接口（设计稿第 8.1 节）。全部同步，在事务里执行。view(ns) 的 UTF-8 字节数永远不超过 MEMORY_VIEW_MAX_BYTES；set 拒绝会超出的写入。 */
export interface Memory {
  view(ns: string): string;
  get(ns: string, key: string): Versioned | null;
  /** `expected: null` 表示这个键现在必须不存在。按键、值、版本、视图的顺序检查；`bytes` 是超出的那一项的字节数。 */
  set(
    ns: string,
    key: string,
    value: string,
    expected: number | null,
  ): { ok: true; version: number } | { ok: false; current: Versioned | null } | { ok: false; over: "key" | "value" | "view"; bytes: number };
  delete(ns: string, key: string, expected: number): { ok: true } | { ok: false; current: Versioned | null };
}

export function unreachable(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
