// 内核的全部类型。外部类型只能 import type（见 .knowledge/kb-kernel.md）。
import type { AssistantMessage, Context, ImageContent, TextContent, SimpleStreamOptions, ThinkingLevel, Tool, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type { AssistantMessage, ImageContent, ToolCall, ToolResultMessage, UserMessage };

/** 信件和工具结果的内容块。图片的 data 将写成 `blob:<hash>`（设计稿第 5.6 节）。 */
export type Content = TextContent | ImageContent;

/** 工作段里只有这三种消息。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ProcessId = string;
/** 毫秒时间戳。 */
export type Instant = number;

export type PresetTool = "read" | "write" | "edit" | "bash" | "memory" | "agents";

/** 工具定义（`~/.tau/tools/<name>.json`，设计稿 5.5），默认值已补上。名称、说明和参数给模型看；命令、超时和输出方式给执行器。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Tool["parameters"];
  command: string;
  /** 秒，1 到 600。 */
  timeout: number;
  output: "text" | "content";
}

/** 启动时冻结的预设。 */
export interface PresetSnapshot {
  id: string;
  workdir: string;
  /** `<provider>/<model-id>` */
  model: string;
  tools: PresetTool[];
  /** 预设 `tools` 里写的工具定义，按写的顺序。启动时冻结，之后改文件不影响这个进程。 */
  toolDefs: ToolDef[];
  prompt: string;
  contextWindow: number;
  /** 模型能收的输入，从模型目录冻结。含 `image` 才会有图片（设计稿第 5.6 节）。 */
  input: ("text" | "image")[];
  /** pi-ai 的思考级别。预设没写就没有这个键，调用模型时不传 `reasoning`。 */
  thinking?: ThinkingLevel;
  /** 换段阈值的上限，token，正整数。预设没写就没有这个键。只能把阈值调低：写得比算出的阈值大就等于没写。 */
  handoff?: number;
  /** 预设里一行 JSON 写的调用参数，白名单见 `presets/load.ts`。执行器先铺它，再铺内核自己的键。预设没写（或写 `{}`）就没有这个键。 */
  options?: PresetOptions;
}

/** 预设能带的 `streamSimple` 参数：pi-ai 转发、能用 JSON 写、又不归内核管的键。 */
export type PresetOptions = Pick<SimpleStreamOptions, "temperature" | "cacheRetention" | "transport" | "timeoutMs" | "websocketConnectTimeoutMs" | "maxRetryDelayMs" | "metadata" | "thinkingBudgets" | "samplingParams">;

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
  /** 换段信（D64 第 7 组）：只由协议的 `send` 产生，只有 `true` 才写这个键。生效的条件和时机见 `decide`。 */
  handoff?: true;
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

/** 工具定义在结果里声明的库内动作（D64 第 10 组）：名字和参数，由 `handleNext` 执行。 */
export interface DeclaredCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type Input =
  | { kind: "letter"; letter: Letter }
  | { kind: "modelResult"; n: number; outcome: { status: "ok"; message: AssistantMessage } | { status: "interrupted" } }
  | { kind: "toolResult"; n: number; outcome: { status: "ok"; content: ToolResultContent; calls?: DeclaredCall[] } | { status: "interrupted" } }
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

/** 记忆接口（见 .knowledge/kb-memory.md）。全部同步。写（set、delete）在调用方的事务里执行，随事务提交或回滚；读（view、get、entries、namespaces）也可以由服务在事务外直接调。view(ns) 的 UTF-8 字节数永远不超过 MEMORY_VIEW_MAX_BYTES；set 拒绝会超出的写入。 */
export interface Memory {
  view(ns: string): string;
  /** 这个 ns 的全部键，按键的 UTF-8 字节序排。 */
  entries(ns: string): (Versioned & { key: string })[];
  /** 有键的全部 ns，按 UTF-8 字节序排。 */
  namespaces(): string[];
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

/** `Memory` 的写入失败形状：版本冲突（带最新值），或超出上限。 */
export type MemoryFailure = Extract<ReturnType<Memory["set"]>, { ok: false }>;

/** 协议的一项记忆写入（见 .knowledge/kb-memory.md）。 */
export type MemoryOp = { kind: "set"; ns: string; key: string; value: string; expected: number | null } | { kind: "delete"; ns: string; key: string; expected: number };

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
