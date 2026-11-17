// D64 第 7 组：换段信。带 `handoff` 的信在三个时机写进段时，下一次调用的用途是 handoff；其余情形标记作废。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { handoffThreshold, STEPS_PER_TURN } from "../../src/kernel/derive.ts";
import type { Letter } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, letter, letterInput, preset, reply, stopInput, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000 });
const LOW = 1_000;
const HIGH = handoffThreshold(P);

const marked = (text: string): Letter => ({ ...letter(text), handoff: true });
const purposeOf = (w: World) => (w.p.phase.tag === "awaitingModel" ? w.p.phase.purpose : undefined);

/** 一轮正常结束：段里有助手消息，进程空闲。 */
function idleWithReply(): World {
  const w = world(P);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: LOW, text: "好的" }));
  assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  return w;
}

/** 一轮开始，模型要求调用 c1。 */
function withCall(): World {
  const w = world(P);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
  return w;
}

describe("换段信：三个时机", () => {
  test("空闲时收信：用途是 handoff，这封信不进交接请求，换段后在新段里被处理", () => {
    const w = idleWithReply();
    feed(w, letterInput(marked("请换段后处理这个")));
    assert.equal(purposeOf(w), "handoff");
    assert.equal(current(w).at(-1)?.role, "user");
    const req = buildContext(w.p, current(w)).messages;
    assert.ok(!JSON.stringify(req).includes("请换段后处理这个"), "信不进交接请求");
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(current(w).length, 1);
    assert.ok(textOf(current(w)[0]!).startsWith(HANDOFF_HEADER + "交接说明"));
    assert.ok(textOf(current(w)[0]!).includes("请换段后处理这个"));
    assert.equal(purposeOf(w), "turn", "新段里照常调用模型");
    reply(w, assistant({ usage: LOW, text: "处理了" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("安全点合并：运行中寄来，在安全点生效", () => {
    const w = withCall();
    feed(w, letterInput(marked("插话")));
    assert.equal(w.p.phase.tag, "awaitingTool");
    toolDone(w, "好");
    assert.equal(purposeOf(w), "handoff");
    assert.equal(textOf(current(w).at(-1)!), "插话");
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.ok(textOf(current(w)[0]!).includes("插话"));
    assert.equal(purposeOf(w), "turn");
  });

  test("done 之后用排队的信开新一轮：生效；队列里的标记已用掉", () => {
    const w = withCall();
    toolDone(w, "好");
    assert.equal(purposeOf(w), "turn");
    feed(w, letterInput(marked("等我说完")));
    reply(w, assistant({ usage: LOW, text: "说完了" }));
    assert.equal(purposeOf(w), "handoff");
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.steps, 1);
    assert.deepEqual(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.queued, []);
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(purposeOf(w), "turn");
  });
});

describe("换段信：作废", () => {
  test("段里没有助手消息：忽略", () => {
    const w = world(P);
    feed(w, letterInput(marked("第一封")));
    assert.equal(purposeOf(w), "turn");
    assert.equal(w.p.segment.seq, 1);
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.queued.length, 0);
  });

  test("不是 done 结束：合并的信上的标记作废，不留到下一轮", () => {
    const w = idleWithReply();
    feed(w, userInput("下一件"));
    feed(w, letterInput(marked("排队的换段信")));
    reply(w, assistant({ usage: LOW, stopReason: "error", errorMessage: "炸了" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "炸了" } });
    assert.ok(textOf(current(w).at(-1)!).includes("排队的换段信"));
    feed(w, userInput("再来一封"));
    assert.equal(purposeOf(w), "turn");
    assert.equal(w.p.segment.seq, 1);

    const s = withCall();
    feed(s, letterInput(marked("会被停止")));
    feed(s, stopInput());
    assert.deepEqual(s.p.phase, { tag: "idle", ended: "stopped" });
    feed(s, userInput("再来"));
    assert.equal(purposeOf(s), "turn");
  });

  test("步数用完：没有合并的信，标记作废", () => {
    const w = world(P);
    feed(w, userInput("开始"));
    for (let id = 0; w.p.phase.tag !== "idle"; id++) {
      reply(w, assistant({ usage: LOW, calls: [call(`c${id}`)] }));
      if (w.p.phase.tag === "awaitingTool" && w.p.phase.turn.steps === STEPS_PER_TURN) feed(w, letterInput(marked("太晚了")));
      toolDone(w, "好");
    }
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
    assert.equal(w.p.segment.seq, 1);
    feed(w, userInput("再来"));
    assert.equal(purposeOf(w), "turn");
  });

  test("和阈值同时成立，或者和 handoff 工具同时成立：只换一次", () => {
    const w = withCall();
    feed(w, letterInput(marked("插话")));
    toolDone(w, "好");
    assert.equal(purposeOf(w), "handoff");
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2, "只换一次");
    assert.equal(purposeOf(w), "turn");

    const h = world(P);
    feed(h, userInput("你好"));
    reply(h, assistant({ usage: HIGH, calls: [call("c1")] }));
    feed(h, letterInput(marked("插话")));
    toolDone(h, "好");
    assert.equal(purposeOf(h), "handoff");
    reply(h, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(h.p.segment.seq, 2);
    assert.equal(purposeOf(h), "turn", "换过一次，不再换");
    assert.ok(textOf(current(h)[0]!).includes("插话"));

    const t = world(P);
    feed(t, userInput("你好"));
    reply(t, assistant({ usage: LOW, calls: [call("c1", "handoff", {})] }));
    feed(t, letterInput(marked("插话")));
    toolDone(t, "好");
    assert.equal(purposeOf(t), "handoff");
    reply(t, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(t.p.segment.seq, 2);
    assert.equal(purposeOf(t), "turn");
  });

  test("交接调用进行中到的换段信：接受交接时去掉队列里的标记，换段后不再换", () => {
    const w = withCall();
    toolDone(w, "好");
    reply(w, assistant({ usage: HIGH, calls: [call("c2")] }));
    toolDone(w, "好");
    assert.equal(purposeOf(w), "handoff");
    feed(w, letterInput(marked("交接中到的")));
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.queued.length, 1);
    assert.ok(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.queued.every((l) => l.handoff === undefined));
    reply(w, assistant({ usage: LOW, calls: [call("c3")] }));
    toolDone(w, "好");
    assert.equal(purposeOf(w), "turn", "合并这封信时不再触发换段");
    assert.equal(w.p.segment.seq, 2);
  });
});
