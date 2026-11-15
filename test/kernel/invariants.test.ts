// assertInvariants 自己的测试：合法状态通过，每一种被破坏的状态都被发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_RATIO, STEPS_PER_TURN } from "../../src/kernel/derive.ts";
import type { Message, Phase, Process } from "../../src/kernel/types.ts";
import { assertInvariants } from "../invariants.ts";
import { assistant, call, current, feed, preset, reply, toolDone, userInput, world } from "./helpers.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const result = (id: string, name = "read"): Message => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "好" }], isError: false, timestamp: 0 });
const asks = (...ids: string[]) => assistant({ usage: 100, calls: ids.map((id) => call(id)) });

/** 一个合法的 awaitingTool 状态：c1 有结果，正在等 c2，c3 还没开始。 */
function midTools(): { p: Process; seg: readonly Message[] } {
  const w = world(preset());
  feed(w, userInput("你好"));
  reply(w, asks("c1", "c2", "c3"));
  toolDone(w, "一");
  return { p: w.p, seg: current(w) };
}

function running(p: Process, phase: Phase): Process {
  return { ...p, phase };
}

function broken(p: Process, seg: readonly Message[], pattern: RegExp): void {
  assert.throws(() => assertInvariants(p, seg), pattern);
}

test("合法的状态通过", () => {
  const { p, seg } = midTools();
  assertInvariants(p, seg);
  assertInvariants(world().p, []);
});

test("工具结果：孤立、顺序不对、中间夹着别的消息、多出来的", () => {
  const { p } = midTools();
  const idle: Process = { ...p, phase: { tag: "idle", ended: "done" } };
  broken(idle, [result("c1")], /第一条是 toolResult/);
  broken(idle, [user("u"), result("c1")], /前面不是它的调用/);
  broken(idle, [user("u"), asks("c1", "c2"), result("c2"), result("c1")], /按顺序应属于 c1/);
  broken(idle, [user("u"), asks("c1", "c2"), result("c1"), user("插话"), result("c2")], /后面紧跟的是第 3 条 user/);
  broken(idle, [user("u"), asks("c1"), result("c1"), result("c1")], /前面不是它的调用/);
  broken(idle, [user("u"), asks("c1"), result("c1", "bash")], /按顺序应属于 c1（read）/);
  broken(idle, [user("u"), asks("c1"), asks("c2"), result("c2")], /后面紧跟的是第 2 条 assistant/);
});

test("idle 和 awaitingModel 时结果必须齐全", () => {
  const { p, seg } = midTools();
  broken({ ...p, phase: { tag: "idle", ended: "done" } }, seg, /idle 时工具调用 c2 没有结果/);
  broken(running(p, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" }), seg, /等模型时工具调用 c2 没有结果/);
});

test("awaitingTool 时必须恰好从 effectOf 指的调用开始缺", () => {
  const { p, seg } = midTools();
  broken(p, [...seg, result("c2"), result("c3")], /没有待执行的工具调用/);
  broken(p, [user("u")], /没有待执行的工具调用/);
});

test("运行中的步数、lastEffect 和工作段", () => {
  const { p, seg } = midTools();
  const turn = (steps: number) => running(p, { tag: "awaitingTool", turn: { steps, queued: [] } });
  broken(turn(0), seg, /步数是 0/);
  broken(turn(STEPS_PER_TURN + 1), seg, new RegExp(`步数是 ${STEPS_PER_TURN + 1}`));
  broken({ ...turn(1), lastEffect: 0 }, seg, /lastEffect 0 小于本轮步数 1/);
  broken(running(p, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" }), [], /运行中工作段却是空的/);
  broken({ ...p, lastEffect: -1 }, seg, /lastEffect 是 -1/);
});

test("awaitingModel：最后一条不能是助手消息，用途要和阈值一致", () => {
  const { p } = midTools();
  const model = (purpose: "turn" | "handoff") => running(p, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose });
  broken(model("turn"), [user("u"), assistant({ usage: 100, text: "好" })], /最后一条是助手消息/);
  broken(model("handoff"), [user("u")], /用途是 handoff，但上下文用量 \d+ 没有达到阈值/);
  const full = Math.ceil(HANDOFF_RATIO * p.preset.contextWindow);
  broken(model("turn"), [user("u"), assistant({ usage: full, text: "好" }), user("再来")], /用途是 turn，但上下文用量 \d+ 已经达到阈值/);
});

test("awaitingTool：已有结果后用量到阈值，就不该再等下一个工具", () => {
  const { p } = midTools();
  const full = Math.ceil(HANDOFF_RATIO * p.preset.contextWindow);
  broken(p, [user("u"), assistant({ usage: full, calls: [call("c1"), call("c2")] }), result("c1")], /达到阈值.*却还在等下一个工具/);
  // 第一个工具不检查阈值：回复本身的用量到了阈值，也照样执行。
  assertInvariants(p, [user("u"), assistant({ usage: full, calls: [call("c1"), call("c2")] })]);
});

test("idle：ended 缺省当且仅当还没跑过一轮", () => {
  const fresh = world().p;
  broken({ ...fresh, lastEffect: 3 }, [], /还没跑过一轮，lastEffect 却是 3/);
  broken(fresh, [user("u")], /还没跑过一轮，工作段却不是空的/);
  broken({ ...fresh, segment: { seq: 2, memoryView: "" } }, [], /还没跑过一轮，段号却是 2/);
  broken({ ...fresh, phase: { tag: "idle", ended: "done" } }, [user("u")], /lastEffect 却是 0/);
  broken({ ...fresh, lastEffect: 1, phase: { tag: "idle", ended: "done" } }, [], /工作段却是空的/);
  broken({ ...fresh, lastEffect: 1, phase: { tag: "idle", ended: "nope" as "done" } }, [user("u")], /未知的结束原因/);
});
