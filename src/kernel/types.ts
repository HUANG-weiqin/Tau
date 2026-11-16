// 内核的全部类型。外部类型只能 import type（见 .knowledge/kb-kernel.md）。
import type { AssistantMessage, Context, ImageContent, TextContent, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, UserMessage };

/** 信件和工具结果的内容块。图片的 data 将写成 `blob:<hash>`（设计稿第 5.6 节）；现在还没有代码产生图片。 */
export type Content = TextContent | ImageContent;

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

/** 累计用量：这个进程所有模型调用的 token 之和（设计稿第 5.8 节）。 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Process {
  id: ProcessId;
  preset: PresetSnapshot;
  createdAt: Instant;
  segment: { seq: number; memoryView: string };
  /** 最后发出的副作用编号，从 0 开始。进程在等的副作用就是这个编号。 */
  lastEffect: number;
  phase: Phase;
  /** 建好后不变。CLI 建的进程没有。 */
  parent?: ProcessId;
  usage: Usage;
}

/** 发信的人：用户（人，或者上层程序），或者另一个进程。`reply` 有值表示这是回信。 */
export type Sender = { kind: "user" } | { kind: "process"; id: ProcessId; preset: string; reply?: { ended: Ended } };

/** 信箱里的一封信。`hops` 是它被进程之间的信一路引出来的跳数；`replyTo` 有值时，处理它的那一轮结束时把最终回复寄给那个进程。 */
export interface Letter {
  from: Sender;
  content: Content[];
  hops: number;
  replyTo?: ProcessId;
}

export interface Turn {
  steps: number;
  /** 运行中到的信，原样存放；写进段时才渲染。 */
  queued: Letter[];
  /** 本轮已经写进段的信的最大跳数。 */
  hops: number;
  /** 本轮结束时要寄回信的进程，去重。 */
  replyTo: ProcessId[];
}

export type Purpose = "turn" | "handoff";

export type Phase =
  | { tag: "idle"; ended?: Ended }
  | { tag: "awaitingModel"; turn: Turn; purpose: Purpose }
  | { tag: "awaitingTool"; turn: Turn };

export type Ended = "done" | "stepLimit" | "stopped" | { error: string };

export interface ToolResultContent {
  content: Content[];
  isError: boolean;
}

export type Input =
  | { kind: "letter"; letter: Letter }
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

/** 记忆接口（见 .knowledge/kb-memory.md）。全部同步，在事务里执行。view(ns) 的 UTF-8 字节数永远不超过 MEMORY_VIEW_MAX_BYTES；set 拒绝会超出的写入。 */
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

/** CLI 寄来的信：用户的信，一个文本块，跳数 0，不要回信。 */
export function userLetter(text: string): Extract<Input, { kind: "letter" }> {
  return { kind: "letter", letter: { from: { kind: "user" }, content: textContent(text), hops: 0 } };
}

/** 一段文本的内容块。 */
export function textContent(text: string): Content[] {
  return [{ type: "text", text }];
}

export function unreachable(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
