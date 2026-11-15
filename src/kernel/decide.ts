// start、decide、effectOf：纯函数（见 .knowledge/kb-kernel.md）。
import { CARRY_HEADER, HANDOFF_HEADER, HANDOFF_INSTRUCTION, tailStart } from "./context.ts";
import { clip, contextUsed, handoffThreshold, MARGIN_TOKENS, pendingCalls, STEPS_PER_TURN, tokens, utf8Bytes } from "./derive.ts";
import { unreachable } from "./types.ts";
import type { AssistantMessage, Effect, Ended, Env, Input, Message, Phase, PresetSnapshot, Process, ProcessId, ToolCall, ToolResultContent, Turn } from "./types.ts";

export const INTERRUPTED = "被中断，结果未知";
export const SKIPPED = "未执行";

export function start(id: ProcessId, preset: PresetSnapshot, env: Env): Process {
  return { id, preset, createdAt: env.now, segment: { seq: 1, memoryView: env.memoryView }, lastEffect: 0, phase: { tag: "idle" } };
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
    case "userMessage":
      if (phase.tag === "idle") {
        push(d, userMessage(input.text, d.env.now));
        continueTurn(d, { steps: 0, queued: [] });
      } else {
        const turn = { ...phase.turn, queued: [...phase.turn.queued, input.text] };
        d.p = { ...d.p, phase: { ...phase, turn } };
      }
      return;
    case "stop":
      if (phase.tag !== "idle") endTurn(d, phase.turn, "stopped");
      return;
    case "modelResult":
      if (phase.tag !== "awaitingModel" || input.n !== d.p.lastEffect) return;
      if (input.outcome.status === "interrupted") return endTurn(d, phase.turn, { error: "服务重启，模型调用被中断" });
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
    // 交接请求没带段末的用户消息（见 buildContext），把它们原样附在交接说明后面。
    const tail = d.seg.slice(tailStart(d.seg)).flatMap((u) => (u.role === "user" && typeof u.content === "string" ? [u.content] : []));
    const carried = tail.length === 0 ? "" : `\n\n${CARRY_HEADER}\n\n${tail.join("\n\n")}`;
    d.p = { ...d.p, segment: { seq: d.p.segment.seq + 1, memoryView: d.env.memoryView } };
    d.seg = [];
    push(d, userMessage(HANDOFF_HEADER + note + carried, d.env.now));
    return continueTurn(d, turn);
  }
  return endTurn(d, turn, { error: "交接失败：" + (m.errorMessage ?? m.stopReason) });
}

/** 第 5.2 节，`toolResult` 正常。 */
function onToolResult(d: Draft, turn: Turn, content: ToolResultContent): void {
  const call = pendingCalls(d.seg)[0];
  if (!call) throw new Error("awaitingTool 时没有待执行的工具调用");
  push(d, toolResult(call, clip(content.text), content.isError, d.env.now));
  const rest = pendingCalls(d.seg);
  if (rest.length > 0 && !overThreshold(d)) return enter(d, { tag: "awaitingTool", turn });
  for (const c of rest) push(d, toolResult(c, SKIPPED, true, d.env.now));
  return continueTurn(d, turn);
}

function continueTurn(d: Draft, turn: Turn): void {
  if (turn.steps >= STEPS_PER_TURN) return endTurn(d, turn, "stepLimit");
  const next = { ...turn, steps: turn.steps + 1 };
  return enter(d, { tag: "awaitingModel", turn: next, purpose: overThreshold(d) ? "handoff" : "turn" });
}

function endTurn(d: Draft, turn: Turn, ended: Ended): void {
  // 正在等的就是第一个待执行的调用：它可能已经开始。
  const waiting = d.p.phase.tag === "awaitingTool";
  pendingCalls(d.seg).forEach((c, i) => push(d, toolResult(c, waiting && i === 0 ? INTERRUPTED : SKIPPED, true, d.env.now)));
  if (turn.queued.length > 0) push(d, userMessage(turn.queued.join("\n\n"), d.env.now));
  if (ended === "done" && turn.queued.length > 0) return continueTurn(d, { steps: 0, queued: [] });
  d.p = { ...d.p, phase: { tag: "idle", ended } };
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

/** decide 写入的每条用户消息都裁剪到字节上限：空闲时的消息、合并的排队消息、新段的第一条。 */
function userMessage(text: string, now: number): Message {
  return { role: "user", content: clip(text), timestamp: now };
}

function toolResult(call: ToolCall, text: string, isError: boolean, now: number): Message {
  return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError, timestamp: now };
}
