// start、decide、effectOf：纯函数（见 .knowledge/kb-kernel.md）。
import { CARRY_HEADER, HANDOFF_HEADER, HANDOFF_INSTRUCTION, tailStart } from "./context.ts";
import { clip, contextUsed, endedReason, endedText, handoffRequested, handoffThreshold, IMAGES_PER_MESSAGE, MARGIN_TOKENS, MESSAGE_MAX_BYTES, pendingCalls, STEPS_PER_TURN, tokens, utf8Bytes } from "./derive.ts";
import { textContent, unreachable } from "./types.ts";
import type { AssistantMessage, Content, Effect, Ended, Env, ImageContent, Input, Letter, Message, Phase, PresetSnapshot, Process, ProcessId, ToolCall, ToolResultContent, Turn, Usage } from "./types.ts";

export const INTERRUPTED = "被中断，结果未知";
export const SKIPPED = "未执行";

export function start(id: ProcessId, preset: PresetSnapshot, env: Env): Process {
  return { id, preset, createdAt: env.now, segment: { seq: 1, memoryView: env.memoryView }, lastEffect: 0, phase: { tag: "idle" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

/** 处理一条输入时的草稿。`seg` 是当前段的全部消息，`append` 是这次要追加的。 */
interface Draft {
  p: Process;
  seg: Message[];
  append: Message[];
  env: Env;
}

export function decide(p: Process, segment: readonly Message[], input: Input, env: Env): { process: Process; append: Message[] } {
  const d: Draft = { p, seg: [...segment], append: [], env };
  step(d, input);
  return { process: d.p, append: d.append };
}

export function effectOf(p: Process, segment: readonly Message[]): Effect | null {
  const { phase } = p;
  switch (phase.tag) {
    case "idle":
      return null;
    case "awaitingModel":
      return { kind: "callModel", n: p.lastEffect, purpose: phase.purpose };
    case "awaitingTool": {
      const call = pendingCalls(segment)[0];
      return call ? { kind: "runTool", n: p.lastEffect, call } : null;
    }
    default:
      return unreachable(phase);
  }
}

function step(d: Draft, input: Input): void {
  const { phase } = d.p;
  switch (input.kind) {
    case "letter":
      if (phase.tag === "idle") {
        const note = endedNote(phase.ended);
        const { text, images } = render([input.letter]);
        push(d, userMessage(note === "" ? text : `${note}\n\n${text}`, images, false, d.env.now));
        continueTurn(d, newTurn([input.letter]));
      } else {
        const turn = { ...phase.turn, queued: [...phase.turn.queued, input.letter] };
        d.p = { ...d.p, phase: { ...phase, turn } };
      }
      return;
    case "stop":
      if (phase.tag !== "idle") endTurn(d, phase.turn, "stopped");
      return;
    case "modelResult":
      if (phase.tag !== "awaitingModel" || input.n !== d.p.lastEffect) return;
      if (input.outcome.status === "interrupted") return endTurn(d, phase.turn, { error: "服务重启，模型调用被中断" });
      d.p = { ...d.p, usage: addUsage(d.p.usage, input.outcome.message.usage) };
      if (phase.purpose === "turn") return onReply(d, phase.turn, input.outcome.message);
      return onHandoff(d, phase.turn, input.outcome.message);
    case "toolResult":
      if (phase.tag !== "awaitingTool" || input.n !== d.p.lastEffect) return;
      if (input.outcome.status === "interrupted") return endTurn(d, phase.turn, { error: "服务重启，工具被中断" });
      return onToolResult(d, phase.turn, input.outcome.content);
    default:
      return unreachable(input);
  }
}

/** 第 5.3 节。 */
function onReply(d: Draft, turn: Turn, m: AssistantMessage): void {
  const r = m.stopReason;
  switch (r) {
    case "toolUse":
    case "stop":
      if (tooManyCalls(m)) return endTurn(d, turn, { error: "一次回复的工具调用太多" });
      push(d, m);
      if (r === "toolUse" && pendingCalls(d.seg).length > 0) return enter(d, { tag: "awaitingTool", turn });
      return endTurn(d, turn, "done");
    case "length":
      return endTurn(d, turn, { error: "输出被截断" });
    case "error":
    case "aborted":
    case "pending":
    case "deferred":
      return endTurn(d, turn, { error: m.errorMessage ?? r });
    default: {
      // 编译期穷尽；运行时遇到 pi-ai 之外的值也按失败处理，不让这条输入卡住。
      const unknown: never = r;
      return endTurn(d, turn, { error: m.errorMessage ?? String(unknown) });
    }
  }
}

/**
 * 这条回复的工具调用要是都补成“未执行”，补的结果和交接指令放不放得进 MARGIN_TOKENS。放不进时换段请求可能超过窗口，
 * 所以和 `length` 一样不写入。ID 算两次：它由服务端分配，回复的用量里没有它，之后的请求里调用和结果各带一次。
 */
function tooManyCalls(m: AssistantMessage): boolean {
  const bytes = m.content.reduce((n, c) => (c.type === "toolCall" ? n + 2 * utf8Bytes(c.id) + utf8Bytes(c.name) + utf8Bytes(SKIPPED) : n), 0);
  return tokens(bytes) + tokens(utf8Bytes(HANDOFF_INSTRUCTION)) > MARGIN_TOKENS;
}

/** 第 5.4 节。 */
function onHandoff(d: Draft, turn: Turn, m: AssistantMessage): void {
  const note = m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
  if ((m.stopReason === "stop" || m.stopReason === "length") && note !== "") {
    if (d.append.length > 0) throw new Error("换段前不能有要追加的消息");
    // 交接请求没带段末的用户消息（见 buildContext），把它们原样附在交接说明后面：文本接在说明后，图片块原样带过去。
    const tail = d.seg.slice(tailStart(d.seg)).flatMap((u) => (u.role === "user" ? [typeof u.content === "string" ? textContent(u.content) : u.content] : []));
    const carriedText = tail.map(textOf).filter((t) => t !== "").join("\n\n");
    const carried = tail.length === 0 ? "" : `\n\n${CARRY_HEADER}${carriedText === "" ? "" : `\n\n${carriedText}`}`;
    d.p = { ...d.p, segment: { seq: d.p.segment.seq + 1, memoryView: d.env.memoryView } };
    d.seg = [];
    push(d, userMessage(HANDOFF_HEADER + note + carried, tail.flatMap(imagesOf), true, d.env.now));
    return continueTurn(d, turn);
  }
  return endTurn(d, turn, { error: "交接失败：" + (m.errorMessage ?? m.stopReason) });
}

/** 第 5.2 节，`toolResult` 正常。 */
function onToolResult(d: Draft, turn: Turn, content: ToolResultContent): void {
  const call = pendingCalls(d.seg)[0];
  if (!call) throw new Error("awaitingTool 时没有待执行的工具调用");
  push(d, toolResult(call, content.content, content.isError, d.env.now));
  const rest = pendingCalls(d.seg);
  if (rest.length > 0 && !overThreshold(d)) return enter(d, { tag: "awaitingTool", turn });
  for (const c of rest) push(d, toolResult(c, textContent(SKIPPED), true, d.env.now));
  return atSafePoint(d, turn);
}

/**
 * 安全点（设计稿第 5.2 节）：这批工具结果都写完或补完，调用 `continueTurn` 之前。先查步数：步数用完时不合并，
 * 信留在 `queued`，由 `endTurn` 处理。否则排队的信合并成一条用户消息写进段，`replyTo` 和 `hops` 并进本轮。写入不计步。
 */
function atSafePoint(d: Draft, turn: Turn): void {
  if (turn.steps >= STEPS_PER_TURN || turn.queued.length === 0) return continueTurn(d, turn);
  const { text, images } = render(turn.queued);
  push(d, userMessage(text, images, false, d.env.now));
  const replyTo = [...new Set([...turn.replyTo, ...turn.queued.flatMap((l) => (l.replyTo === undefined ? [] : [l.replyTo]))])];
  const hops = Math.max(turn.hops, ...turn.queued.map((l) => l.hops));
  return continueTurn(d, { ...turn, queued: [], hops, replyTo });
}

function continueTurn(d: Draft, turn: Turn): void {
  if (turn.steps >= STEPS_PER_TURN) return endTurn(d, turn, "stepLimit");
  const next = { ...turn, steps: turn.steps + 1 };
  return enter(d, { tag: "awaitingModel", turn: next, purpose: overThreshold(d) || handoffRequested(d.seg) ? "handoff" : "turn" });
}

function endTurn(d: Draft, turn: Turn, ended: Ended): void {
  // 正在等的就是第一个待执行的调用：它可能已经开始。
  const waiting = d.p.phase.tag === "awaitingTool";
  pendingCalls(d.seg).forEach((c, i) => push(d, toolResult(c, textContent(waiting && i === 0 ? INTERRUPTED : SKIPPED), true, d.env.now)));
  if (turn.queued.length > 0) {
    const { text, images } = render(turn.queued);
    push(d, userMessage(text, images, false, d.env.now));
  }
  if (ended === "done" && turn.queued.length > 0) return continueTurn(d, newTurn(turn.queued));
  d.p = { ...d.p, phase: { tag: "idle", ended } };
}

/** 新一轮：`hops` 和 `replyTo` 只取自开这一轮的信（设计稿第 5.3 节规则 2、5）。 */
function newTurn(letters: readonly Letter[]): Turn {
  const replyTo = letters.flatMap((l) => (l.replyTo === undefined ? [] : [l.replyTo]));
  return { steps: 0, queued: [], hops: Math.max(...letters.map((l) => l.hops)), replyTo: [...new Set(replyTo)] };
}

const textOf = (blocks: readonly Content[]): string => blocks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
const imagesOf = (blocks: readonly Content[]): ImageContent[] => blocks.flatMap((c) => (c.type === "image" ? [c] : []));

/** 信的头（设计稿第 5.1 节）。`mixed`：这一批里有进程的信，用户的信才加头。 */
function header(l: Letter, mixed: boolean): string {
  const f = l.from;
  if (f.kind === "user") return mixed ? "（来自用户）" : "";
  if (f.reply) return `（进程 ${f.id} 的回信，这一轮${endedText(f.reply.ended)}）`;
  const who = `来自进程 ${f.id}，预设 ${f.preset}`;
  return l.replyTo === undefined ? `（${who}）` : `（${who}。它在等回信：你这一轮结束时，最终回复会寄给它，之后的几轮不会。）`;
}

/** 一批信写进段的正文和图片：每封信是头、换行、正文，信之间空一行；图片按信的顺序。 */
function render(letters: readonly Letter[]): { text: string; images: ImageContent[] } {
  const mixed = letters.some((l) => l.from.kind === "process");
  const text = letters
    .map((l) => {
      const h = header(l, mixed);
      return h === "" ? textOf(l.content) : `${h}\n${textOf(l.content)}`;
    })
    .join("\n\n");
  return { text, images: letters.flatMap((l) => imagesOf(l.content)) };
}

/**
 * 文本和图片成内容块：文本经 clip 成一个文本块（没有文本就不加），图片块原样接在后面。
 * `limit` 时最多留最后 IMAGES_PER_MESSAGE 张，多出的从最早的起省略，文本块末尾加一行说明；连这一行不超过 MESSAGE_MAX_BYTES。
 */
function fit(text: string | undefined, images: readonly ImageContent[], limit: boolean): Content[] {
  const omitted = limit ? Math.max(0, images.length - IMAGES_PER_MESSAGE) : 0;
  const kept = images.slice(omitted);
  if (omitted === 0) return text === undefined ? kept : [{ type: "text", text: clip(text) }, ...kept];
  const line = `[图片：省略了 ${omitted} 张较早的图片]`;
  const body = text === undefined || text === "" ? line : `${clip(text, MESSAGE_MAX_BYTES - utf8Bytes(line) - 1)}\n${line}`;
  return [{ type: "text", text: body }, ...kept];
}

/** 累计用量：不丢弃的模型结果都加（设计稿第 5.8 节）。 */
function addUsage(u: Usage, m: Usage): Usage {
  return { input: u.input + m.input, output: u.output + m.output, cacheRead: u.cacheRead + m.cacheRead, cacheWrite: u.cacheWrite + m.cacheWrite };
}

/** 进入一个等待阶段：发出下一个副作用编号。 */
function enter(d: Draft, phase: Exclude<Phase, { tag: "idle" }>): void {
  d.p = { ...d.p, phase, lastEffect: d.p.lastEffect + 1 };
}

function overThreshold(d: Draft): boolean {
  return contextUsed(d.p, d.seg) >= handoffThreshold(d.p.preset);
}

function push(d: Draft, m: Message): void {
  d.seg.push(m);
  d.append.push(m);
}

/**
 * 上一轮没有正常结束时，下一条用户消息前面的说明。段里不写失败的回复，也不写停止，模型否则看不出
 * 上一轮没做完，会把旧请求当成还要做的事。合并的排队消息不加：说明只加在之后的第一条消息上。
 */
function endedNote(ended: Ended | undefined): string {
  switch (ended) {
    case undefined:
    case "done":
      return "";
    case "stopped":
      return "（用户停止了上一轮。上面还没回复的消息都已取消：不要回应它们，只回应下面这条消息。）";
    case "stepLimit":
      return "（上一轮的步数用完了，停在中途。）";
    default:
      return `（上一轮出错，没有做完：${endedReason(ended.error)}）`;
  }
}

/**
 * decide 写入的每条用户消息都经过这里（工具结果经 `toolResult`）：空闲时的消息、合并的排队消息、新段的第一条。
 * 没有图片时正文是字符串；有图片时是文本块加图片块。`limit`：新段的第一条，图片张数受限。
 */
function userMessage(text: string, images: readonly ImageContent[], limit: boolean, now: number): Message {
  return { role: "user", content: images.length === 0 ? clip(text) : fit(text === "" ? undefined : text, images, limit), timestamp: now };
}

/** 工具结果：文本和图片都经 `fit`，图片张数受限。 */
function toolResult(call: ToolCall, content: readonly Content[], isError: boolean, now: number): Message {
  const images = imagesOf(content);
  const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  // 有图片时，空串和没有文本一样：不加文本块。没有图片时保持从前的做法。
  const only = images.length > 0 && text === "";
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: fit(only || (images.length === 0 && content.length === 0) ? undefined : text, images, true), isError, timestamp: now };
}
