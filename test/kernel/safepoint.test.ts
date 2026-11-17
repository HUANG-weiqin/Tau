// 设计稿 5.2 安全点投递、5.4 主动换段（handoff）。每次 feed 之后都会检查 assertInvariants。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, CARRY_HEADER, HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import { finalReply, handoffThreshold, pendingCalls, STEPS_PER_TURN } from "../../src/kernel/derive.ts";
import type { Message } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, image, letter, letterInput, preset, processLetter, reply, stopInput, textOf, toolDone, toolInterrupted, userInput, userLetterWith, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000 });
const LOW = 1_000;
const HIGH = handoffThreshold(P);

const brief = (ms: readonly Message[]): string[] => ms.map((m) => (m.role === "toolResult" ? `${m.toolCallId}=${textOf(m)}` : `${m.role}:${textOf(m)}`));
const phase = (w: World) => w.p.phase;
const turnOf = (w: World) => (w.p.phase.tag === "idle" ? undefined : w.p.phase.turn);
const purposeOf = (w: World) => (w.p.phase.tag === "awaitingModel" ? w.p.phase.purpose : undefined);

/** 一轮开始，模型要求按顺序调用这些工具（名字默认 read）。 */
function withCalls(ids: string[], u = LOW, name = "read"): World {
  const w = world(P);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: u, calls: ids.map((id) => call(id, name)) }));
  return w;
}

describe("5.2 安全点投递", () => {
  test("工具运行中到的信，在下一次调用模型之前写进段；写入不计步", () => {
    const w = withCalls(["c1", "c2"]);
    feed(w, userInput("插话"));
    const s1 = toolDone(w, "一");
    assert.deepEqual(s1.append.map((m) => m.role), ["toolResult"], "批没做完，不是安全点");
    assert.equal(phase(w).tag, "awaitingTool");
    const s2 = toolDone(w, "二");
    assert.deepEqual(brief(s2.append), ["c2=二", "user:插话"]);
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 0, replyTo: [] }, purpose: "turn" });
    assert.deepEqual(brief(current(w).slice(-3)), ["c1=一", "c2=二", "user:插话"]);
    assert.equal(buildContext(w.p, current(w)).messages.at(-1)?.role, "user");
  });

  test("没有排队的信时照旧", () => {
    const w = withCalls(["c1"]);
    const s = toolDone(w, "好");
    assert.deepEqual(brief(s.append), ["c1=好"]);
  });

  test("几封信合并，头照第 2 步", () => {
    const w = withCalls(["c1"]);
    feed(w, userInput("甲"));
    feed(w, userInput("乙"));
    assert.deepEqual(brief(toolDone(w, "好").append), ["c1=好", "user:甲\n\n乙"]);

    const m = withCalls(["c1"]);
    feed(m, userInput("甲"));
    feed(m, letterInput(processLetter("乙", { id: "q1", preset: "helper" })));
    const text = textOf(toolDone(m, "好").append[1]!);
    assert.equal(text, "（来自用户）\n甲\n\n（来自进程 q1，预设 helper）\n乙");
  });

  test("信带图片：不限张数，按顺序全带", () => {
    const w = withCalls(["c1"]);
    feed(w, letterInput(userLetterWith("甲", [image("a"), image("b")])));
    feed(w, letterInput(userLetterWith("乙", [image("c")])));
    const m = toolDone(w, "好").append[1]!;
    assert.ok(m.role === "user" && typeof m.content !== "string");
    assert.deepEqual(m.content.filter((c) => c.type === "image").map((c) => c.data), ["a", "b", "c"]);
  });

  test("replyTo 并进 turn（去重），hops 取最大", () => {
    const w = withCalls(["c1"]);
    feed(w, letterInput(processLetter("甲", { id: "x", replyTo: "x", hops: 3 })));
    feed(w, letterInput(processLetter("乙", { id: "y", replyTo: "y", hops: 5 })));
    feed(w, letterInput(processLetter("丙", { id: "x", replyTo: "x", hops: 2 })));
    toolDone(w, "好");
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 5, replyTo: ["x", "y"] }, purpose: "turn" });
  });

  test("并进已有的 replyTo 和 hops，不覆盖", () => {
    const w = world(P);
    feed(w, letterInput(processLetter("起", { id: "a", replyTo: "a", hops: 4 })));
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    feed(w, letterInput(processLetter("插", { id: "b", replyTo: "b", hops: 1 })));
    toolDone(w, "好");
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 4, replyTo: ["a", "b"] }, purpose: "turn" });
  });

  test("步数用完：不合并，信留在 queued，endTurn 写入；finalReply 和不合并时一样", () => {
    /** 跑到最后一步的最后一个工具结果之前；`late` 为真时这时来一封信。 */
    const run = (late: boolean): World => {
      const w = world(P);
      feed(w, userInput("你好"));
      for (let i = 1; i <= STEPS_PER_TURN; i++) {
        reply(w, assistant({ usage: LOW, text: `第${i}步`, calls: [call(`c${i}`)] }));
        if (i === STEPS_PER_TURN) break;
        toolDone(w, "好");
      }
      assert.equal(turnOf(w)?.steps, STEPS_PER_TURN);
      if (late) feed(w, userInput("插话"));
      toolDone(w, "好");
      return w;
    };
    const plain = run(false);
    const late = run(true);
    assert.deepEqual(phase(plain), { tag: "idle", ended: "stepLimit" });
    assert.deepEqual(phase(late), { tag: "idle", ended: "stepLimit" });
    assert.deepEqual(brief(current(late).slice(-2)), [`c${STEPS_PER_TURN}=好`, "user:插话"]);
    // 信没有被安全点抢先并入：结果之后的段，和没有信时一样，算出同一个最终回复。
    assert.equal(finalReply(current(late).slice(0, -1)), finalReply(current(plain)));
    assert.equal(finalReply(current(plain)), `第${STEPS_PER_TURN}步`);
  });

  test("步数用完：最后一批没做完时，turn.queued 原样保留，做完由 endTurn 写入", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    for (let i = 1; i <= STEPS_PER_TURN; i++) {
      reply(w, assistant({ usage: LOW, calls: [call(`c${i}`), call(`d${i}`)] }));
      if (i === STEPS_PER_TURN) feed(w, userInput("插话"));
      toolDone(w, "好");
      if (i < STEPS_PER_TURN) toolDone(w, "好");
    }
    // 最后一批的第一个结果写入后还在等第二个：queued 没动。
    assert.deepEqual(turnOf(w)?.queued, [letter("插话")]);
    toolDone(w, "好");
    assert.deepEqual(phase(w), { tag: "idle", ended: "stepLimit" });
  });

  test("等模型时到的信不写进段，等下一个安全点", () => {
    const w = withCalls(["c1"]);
    toolDone(w, "好"); // 没有排队的信，进入等模型
    const before = current(w);
    const s = feed(w, userInput("等模型时到的"));
    assert.deepEqual(s.append, []);
    assert.deepEqual(current(w), before);
    assert.deepEqual(turnOf(w)?.queued, [letter("等模型时到的")]);
    reply(w, assistant({ usage: LOW, calls: [call("c2")] }));
    assert.deepEqual(current(w).at(-1)?.role, "assistant", "回复写入时也不合并");
    assert.equal(turnOf(w)?.queued.length, 1);
    const t = toolDone(w, "好");
    assert.deepEqual(brief(t.append), ["c2=好", "user:等模型时到的"]);
  });

  test("换段成功以后、等模型回复时到的信，等下一个安全点", () => {
    const w = withCalls(["c1"], HIGH);
    toolDone(w, "好");
    assert.equal(purposeOf(w), "handoff");
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    const seg = current(w);
    const s = feed(w, userInput("新段里到的"));
    assert.deepEqual(s.append, []);
    assert.deepEqual(current(w), seg);
    reply(w, assistant({ usage: LOW, calls: [call("c2")] }));
    assert.deepEqual(brief(toolDone(w, "好").append), ["c2=好", "user:新段里到的"]);
  });

  test("到了阈值：批里剩下的补未执行，然后安全点并入，再换段；并入的信随换段带到新段", () => {
    const w = withCalls(["c1", "c2"], HIGH);
    feed(w, userInput("插话"));
    const s = toolDone(w, "好");
    assert.deepEqual(brief(s.append), ["c1=好", "c2=未执行", "user:插话"]);
    assert.equal(purposeOf(w), "handoff");
    const req = buildContext(w.p, current(w)).messages;
    assert.equal(req.at(-1)?.role, "user", "交接请求以指令结尾");
    assert.ok(!req.some((m) => m.role === "user" && m.content === "插话"), "交接请求不带段末的信");
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(textOf(current(w)[0]!), `${HANDOFF_HEADER}说明\n\n${CARRY_HEADER}\n\n插话`);
  });

  test("安全点之后这一轮异常结束：并入的信已经在段里，最终回复是空串", () => {
    const w = withCalls(["c1"]);
    feed(w, userInput("插话"));
    toolDone(w, "好");
    feed(w, stopInput());
    assert.deepEqual(phase(w), { tag: "idle", ended: "stopped" });
    assert.equal(current(w).at(-1)?.role, "user");
    assert.equal(textOf(current(w).at(-1)!), "插话");
    assert.equal(pendingCalls(current(w)).length, 0);
  });

  test("工具被中断时不是安全点：信由 endTurn 写入", () => {
    const w = withCalls(["c1"]);
    feed(w, userInput("插话"));
    const eff = effectOf(w.p, current(w))!;
    const s = feed(w, toolInterrupted(eff.n));
    assert.deepEqual(brief(s.append), ["c1=被中断，结果未知", "user:插话"]);
    assert.deepEqual(phase(w), { tag: "idle", ended: { error: "服务重启，工具被中断" } });
  });

  test("带工具调用的助手消息后面紧跟它的结果：并入后再来一批工具也成立", () => {
    const w = withCalls(["c1", "c2"]);
    feed(w, userInput("插话"));
    toolDone(w, "一");
    toolDone(w, "二");
    reply(w, assistant({ usage: LOW, calls: [call("c3"), call("c4")] }));
    toolDone(w, "三");
    feed(w, userInput("又一封"));
    toolDone(w, "四");
    reply(w, assistant({ usage: LOW, text: "好了" }));
    assert.deepEqual(brief(current(w)), ["user:你好", "assistant:", "c1=一", "c2=二", "user:插话", "assistant:", "c3=三", "c4=四", "user:又一封", "assistant:好了"]);
    assert.deepEqual(phase(w), { tag: "idle", ended: "done" });
  });
});

describe("5.4 handoff", () => {
  test("成功的 handoff 调用：安全点之后进入 awaitingModel(handoff)，用量远低于阈值也一样", () => {
    const w = withCalls(["h1"], LOW, "handoff");
    toolDone(w, "将在这批工具结果之后换段。");
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 0, replyTo: [] }, purpose: "handoff" });
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 3, queued: [], hops: 0, replyTo: [] }, purpose: "turn" });
    assert.equal(textOf(current(w)[0]!), `${HANDOFF_HEADER}说明`);
  });

  test("同一批里 handoff 之前和之后的工具照常执行，批做完才换段", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    reply(w, assistant({ usage: LOW, calls: [call("a"), call("h", "handoff"), call("b")] }));
    toolDone(w, "甲");
    toolDone(w, "ok");
    assert.equal(phase(w).tag, "awaitingTool");
    toolDone(w, "乙");
    assert.equal(purposeOf(w), "handoff");
  });

  test("和阈值同时成立", () => {
    const w = withCalls(["h1"], HIGH, "handoff");
    toolDone(w, "ok");
    assert.equal(purposeOf(w), "handoff");
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(purposeOf(w), "turn", "新段里不再换段");
  });

  test("和安全点投递同时发生：并入的信随换段带到新段", () => {
    const w = withCalls(["h1"], LOW, "handoff");
    feed(w, letterInput(processLetter("来信", { id: "x", replyTo: "x", hops: 2 })));
    toolDone(w, "ok");
    assert.deepEqual(phase(w), { tag: "awaitingModel", turn: { steps: 2, queued: [], hops: 2, replyTo: ["x"] }, purpose: "handoff" });
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(textOf(current(w)[0]!), `${HANDOFF_HEADER}说明\n\n${CARRY_HEADER}\n\n（来自进程 x，预设 other。它在等回信：你这一轮结束时，最终回复会寄给它，之后的几轮不会。）\n来信`);
    assert.deepEqual(turnOf(w)?.replyTo, ["x"]);
  });

  test("handoff 的结果是错误：不触发", () => {
    const w = withCalls(["h1"], LOW, "handoff");
    toolDone(w, "参数错误", env0(), true);
    assert.equal(purposeOf(w), "turn");
  });

  test("被补成未执行的 handoff 不触发：阈值之后批里剩下的", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    reply(w, assistant({ usage: HIGH, calls: [call("a"), call("h", "handoff")] }));
    toolDone(w, "甲"); // 到阈值：h 补成“未执行”，换段是因为阈值
    assert.deepEqual(brief(current(w).slice(-2)), ["a=甲", "h=未执行"]);
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(purposeOf(w), "turn", "新段里没有成功的 handoff");
  });

  test("被补成被中断或未执行的 handoff 不触发：停止后再来一封信", () => {
    for (const interrupt of [true, false]) {
      const w = world(P);
      feed(w, userInput("你好"));
      reply(w, assistant({ usage: LOW, calls: interrupt ? [call("h", "handoff")] : [call("a"), call("h", "handoff")] }));
      if (interrupt) feed(w, toolInterrupted(w.p.lastEffect));
      else feed(w, stopInput());
      assert.equal(phase(w).tag, "idle");
      feed(w, userInput("再来"));
      assert.equal(purposeOf(w), "turn", interrupt ? "被中断" : "未执行");
    }
  });

  test("交接失败以后，下一封信一来又换段；成功换段以后不再", () => {
    const w = withCalls(["h1"], LOW, "handoff");
    toolDone(w, "ok");
    reply(w, assistant({ usage: 10, stopReason: "error", errorMessage: "炸了" }));
    assert.deepEqual(phase(w), { tag: "idle", ended: { error: "交接失败：炸了" } });
    assert.equal(w.p.segment.seq, 1);
    feed(w, userInput("再来"));
    assert.equal(purposeOf(w), "handoff");
    reply(w, assistant({ usage: 10, text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(purposeOf(w), "turn");
  });

  test("不存状态：purpose 之外没有新字段", () => {
    const w = withCalls(["h1"], LOW, "handoff");
    toolDone(w, "ok");
    assert.deepEqual(Object.keys(w.p).sort(), ["createdAt", "id", "lastEffect", "phase", "preset", "segment", "since", "usage"]);
  });

  test("handoff 在步数用完时也只是结束本轮", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    for (let i = 1; i <= STEPS_PER_TURN; i++) {
      reply(w, assistant({ usage: LOW, calls: [call(`c${i}`, i === STEPS_PER_TURN ? "handoff" : "read")] }));
      toolDone(w, "ok");
    }
    assert.deepEqual(phase(w), { tag: "idle", ended: "stepLimit" });
  });
});

function env0() {
  return { now: 0, memoryView: "" };
}
