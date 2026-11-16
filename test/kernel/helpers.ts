// 内核测试的辅助：把 decide 的结果应用到内存里的状态上，以及预设、消息和输入的构造器。
import type { AssistantMessage, StopReason, ToolCall, Usage } from "@earendil-works/pi-ai";
import { decide, effectOf, start } from "../../src/kernel/decide.ts";
import { textContent, unreachable, userLetter } from "../../src/kernel/types.ts";
import type { Content, Effect, Ended, Env, ImageContent, Input, Letter, Message, PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { assertInvariants } from "../invariants.ts";

export function preset(over: Partial<PresetSnapshot> = {}): PresetSnapshot {
  return {
    id: "tester",
    workdir: "E:/work",
    model: "faux/test-model",
    tools: ["read", "write", "edit", "bash", "memory"],
    toolDefs: [],
    prompt: "你是测试用的助手。",
    contextWindow: 200_000,
    input: ["text"],
    ...over,
  };
}

export function env(now: number, memoryView = ""): Env {
  return { now, memoryView };
}

/** 用量字面量。`totalTokens` 为 0 时，内核取四项之和。 */
export function usage(totalTokens: number, parts: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {}): Usage {
  return {
    input: parts.input ?? 0,
    output: parts.output ?? 0,
    cacheRead: parts.cacheRead ?? 0,
    cacheWrite: parts.cacheWrite ?? 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function call(id: string, name = "read", args: ToolCall["arguments"] = { path: "a.txt" }): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export interface ReplySpec {
  /** 数字表示 `totalTokens`（全部算作 input）。 */
  usage: Usage | number;
  /** 缺省时：有工具调用就是 `toolUse`，否则是 `stop`。 */
  stopReason?: StopReason;
  text?: string;
  thinking?: string;
  calls?: ToolCall[];
  errorMessage?: string;
  timestamp?: number;
}

/** 助手消息字面量，用量由调用方明确给出。 */
export function assistant(s: ReplySpec): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (s.thinking !== undefined) content.push({ type: "thinking", thinking: s.thinking });
  if (s.text !== undefined) content.push({ type: "text", text: s.text });
  for (const c of s.calls ?? []) content.push(c);
  const m: AssistantMessage = {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: typeof s.usage === "number" ? usage(s.usage, { input: s.usage }) : s.usage,
    stopReason: s.stopReason ?? ((s.calls?.length ?? 0) > 0 ? "toolUse" : "stop"),
    timestamp: s.timestamp ?? 0,
  };
  if (s.errorMessage !== undefined) m.errorMessage = s.errorMessage;
  return m;
}

export const userInput = (text: string): Input => userLetter(text);
/** 排队里的一封用户的信。 */
export const letter = (text: string): Letter => userLetter(text).letter;
/** 一张图片块，`data` 用来区分。 */
export const image = (data = "aGk="): ImageContent => ({ type: "image", data, mimeType: "image/png" });
/** 用户的信，可以带图片。 */
export const userLetterWith = (text: string, images: ImageContent[] = []): Letter => ({ from: { kind: "user" }, content: [...(text === "" ? [] : textContent(text)), ...images], hops: 0 });
/** 进程的信：回信（`reply`）、要回信的信（`replyTo`）或者普通的信。 */
export function processLetter(text: string, over: { id?: string; preset?: string; replyTo?: string; reply?: Ended; hops?: number; images?: ImageContent[] } = {}): Letter {
  const from = { kind: "process" as const, id: over.id ?? "x", preset: over.preset ?? "other", ...(over.reply === undefined ? {} : { reply: { ended: over.reply } }) };
  return { from, content: [...textContent(text), ...(over.images ?? [])], hops: over.hops ?? 1, ...(over.replyTo === undefined ? {} : { replyTo: over.replyTo }) };
}
export const letterInput = (l: Letter): Input => ({ kind: "letter", letter: l });
export const stopInput = (): Input => ({ kind: "stop" });
export const modelOk = (n: number, message: AssistantMessage): Input => ({ kind: "modelResult", n, outcome: { status: "ok", message } });
export const modelInterrupted = (n: number): Input => ({ kind: "modelResult", n, outcome: { status: "interrupted" } });
export const toolOk = (n: number, text: string, isError = false): Input => ({ kind: "toolResult", n, outcome: { status: "ok", content: { content: textContent(text), isError } } });
export const toolOkContent = (n: number, content: Content[], isError = false): Input => ({ kind: "toolResult", n, outcome: { status: "ok", content: { content, isError } } });
export const toolInterrupted = (n: number): Input => ({ kind: "toolResult", n, outcome: { status: "interrupted" } });

/** 内存里的状态：进程记录，加上每一段的消息。 */
export interface World {
  p: Process;
  segments: Map<number, readonly Message[]>;
}

export function world(pr: PresetSnapshot = preset(), e: Env = env(0), id = "p1"): World {
  return { p: start(id, pr, e), segments: new Map() };
}

export function current(w: World): readonly Message[] {
  return w.segments.get(w.p.segment.seq) ?? [];
}

export type Out = ReturnType<typeof decide>["out"][number];

export interface Step {
  prev: Process;
  before: Effect | null;
  after: Effect | null;
  append: Message[];
  out: Out[];
}

/**
 * 处理一条输入：调用 decide，把新的进程记录和追加的消息写回 `w`。
 * 追加的消息一律写进新进程记录的 `segment.seq` 那一段。旧状态和输入先被冻结，decide 改动它们就会抛错。
 * 写回之后检查不变量。
 */
export function feed(w: World, input: Input, e: Env = env(0)): Step {
  const prev = deepFreeze(w.p);
  const seg = current(w);
  const before = effectOf(prev, seg);
  const r = decide(prev, seg, deepFreeze(input), deepFreeze(e));
  const seq = r.process.segment.seq;
  if (seq !== prev.segment.seq && (seq !== prev.segment.seq + 1 || w.segments.has(seq))) {
    throw new Error(`段号从 ${prev.segment.seq} 变成 ${seq}：一次只能开一个新段`);
  }
  const next = Object.freeze([...(w.segments.get(seq) ?? []), ...r.append.map(deepFreeze)]);
  w.segments.set(seq, next);
  w.p = r.process;
  assertInvariants(w.p, next);
  return { prev, before, after: effectOf(w.p, next), append: r.append, out: r.out };
}

/** 回复进程正在等的模型调用。 */
export function reply(w: World, m: AssistantMessage, e: Env = env(0)): Step {
  const eff = effectOf(w.p, current(w));
  if (eff?.kind !== "callModel") throw new Error(`进程没有在等模型：${JSON.stringify(eff)}`);
  return feed(w, modelOk(eff.n, m), e);
}

/** 回复进程正在等的工具调用。 */
export function toolDone(w: World, text: string, e: Env = env(0), isError = false): Step {
  const eff = effectOf(w.p, current(w));
  if (eff?.kind !== "runTool") throw new Error(`进程没有在等工具：${JSON.stringify(eff)}`);
  return feed(w, toolOk(eff.n, text, isError), e);
}

export function textOf(m: Message): string {
  switch (m.role) {
    case "user":
      return typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    case "assistant":
      return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    case "toolResult":
      return m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    default:
      return unreachable(m);
  }
}

/** 像源代码一样的文本：带换行、引号和中文，至少 `bytes` 字节。 */
export function codeText(bytes: number, tag = "x"): string {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const line = `  const ${tag}${i} = "数据 ${i}"; // 第 ${i} 行，说明\t'引用'\n`;
    lines.push(line);
    n += Buffer.byteLength(line);
  }
  return lines.join("");
}

export function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}
