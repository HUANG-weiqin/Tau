// 设计稿 5.3：回信。decide 的 out 给出要寄的回信；规则 3 的顺序、规则 4 的收件人和跳数、回信不带 replyTo。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { endedReason, finalReply, STEPS_PER_TURN } from "../../src/kernel/derive.ts";
import type { Ended } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, letterInput, modelInterrupted, modelOk, preset, processLetter, reply, stopInput, textOf, toolDone, toolInterrupted, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";
import { effectOf } from "../../src/kernel/decide.ts";

const P = preset({ id: "tester", contextWindow: 100_000 });
const LOW = 1_000;

/** 回信：发信的是 p1（预设 tester），带结束原因，没有 replyTo。 */
const back = (to: string, text: string, ended: Ended, hops: number) => ({
  to,
  letter: { from: { kind: "process", id: "p1", preset: "tester", reply: { ended } }, content: text === "" ? [] : [{ type: "text", text }], hops },
});

/** 一轮开始：进程 a 要回信的信，跳数 3。等模型。 */
function begin(over: Parameters<typeof processLetter>[1] = {}): World {
  const w = world(P);
  feed(w, letterInput(processLetter("问题", { id: "a", replyTo: "a", hops: 3, ...over })));
  return w;
}

describe("回信：每种结束原因", () => {
  test("done：正文是最终回复，头里的结束原因是 done，跳数加一，不带 replyTo", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: LOW, text: "答案" }));
    assert.deepEqual(s.out, [back("a", "答案", "done", 4)]);
    assert.ok(!("replyTo" in s.out[0]!.letter));
    assert.equal(w.p.phase.tag, "idle");
  });

  test("done：最终回复可以是空的，内容块为空", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: LOW }));
    assert.deepEqual(s.out, [back("a", "", "done", 4)]);
  });

  test("done：带工具调用的回复先补“未执行”，最终回复取这条助手消息的正文", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: LOW, stopReason: "stop", text: "好了", calls: [call("c1")] }));
    assert.deepEqual(s.out, [back("a", "好了", "done", 4)]);
  });

  test("stopped：正在等工具时停止，回信正文是上一条助手消息的正文", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, text: "先看看", calls: [call("c1")] }));
    const s = feed(w, stopInput());
    assert.deepEqual(s.out, [back("a", "先看看", "stopped", 4)]);
  });

  test("stopped：还没有助手消息时停止，正文为空", () => {
    const w = begin();
    assert.deepEqual(feed(w, stopInput()).out, [back("a", "", "stopped", 4)]);
  });

  test("stepLimit", () => {
    const v = begin();
    for (let i = 1; i <= STEPS_PER_TURN; i++) {
      const s = reply(v, assistant({ usage: LOW, text: `第${i}步`, calls: [call(`c${i}`)] }));
      assert.deepEqual(s.out, []);
      if (i === STEPS_PER_TURN) break;
      toolDone(v, "好");
    }
    assert.deepEqual(toolDone(v, "好").out, [back("a", `第${STEPS_PER_TURN}步`, "stepLimit", 4)]);
  });

  test("出错：模型回复出错，原因已按 endedReason 处理（没有换行，不超长）", () => {
    const w = begin();
    const long = `第一行\n第二行${"错".repeat(3_000)}`;
    const s = reply(w, assistant({ usage: LOW, stopReason: "error", errorMessage: long }));
    const ended = { error: endedReason(long) };
    assert.ok(!ended.error.includes("\n"));
    assert.deepEqual(s.out, [back("a", "", ended, 4)]);
  });

  test("出错：模型调用和工具被中断", () => {
    const w = begin();
    assert.deepEqual(feed(w, modelInterrupted(effectOf(w.p, current(w))!.n)).out, [back("a", "", { error: "服务重启，模型调用被中断" }, 4)]);
    const v = begin();
    reply(v, assistant({ usage: LOW, text: "我来读", calls: [call("c1")] }));
    assert.deepEqual(feed(v, toolInterrupted(effectOf(v.p, current(v))!.n)).out, [back("a", "我来读", { error: "服务重启，工具被中断" }, 4)]);
  });

  test("出错：length", () => {
    const w = begin();
    assert.deepEqual(reply(w, assistant({ usage: LOW, stopReason: "length", text: "半截" })).out, [back("a", "", { error: "输出被截断" }, 4)]);
  });

  test("没有要回信的信：out 为空，每一步都是", () => {
    const w = world(P);
    assert.deepEqual(feed(w, userInput("你好")).out, []);
    assert.deepEqual(reply(w, assistant({ usage: LOW, text: "好", calls: [call("c1")] })).out, []);
    assert.deepEqual(toolDone(w, "好").out, []);
    assert.deepEqual(reply(w, assistant({ usage: LOW, text: "完" })).out, []);
    // 不要回信的进程的信（包括回信）也不引出回信。
    const v = world(P);
    feed(v, letterInput(processLetter("通知", { id: "a" })));
    assert.deepEqual(reply(v, assistant({ usage: LOW, text: "收到" })).out, []);
    feed(v, letterInput(processLetter("答案", { id: "a", reply: "done" })));
    assert.deepEqual(reply(v, assistant({ usage: LOW, text: "好" })).out, []);
  });

  test("运行中没有信的中间步骤不寄信；收到信、写进段也不寄信", () => {
    const w = begin();
    assert.deepEqual(feed(w, letterInput(processLetter("又一封", { id: "b", replyTo: "b" }))).out, []);
    assert.deepEqual(reply(w, assistant({ usage: LOW, text: "x", calls: [call("c1")] })).out, []);
    // 安全点并入排队的信：还没结束，不寄。
    assert.deepEqual(toolDone(w, "好").out, []);
  });
});

describe("回信：最终回复在合并排队的信之前算", () => {
  test("停止时有排队的信：回信带合并之前的最终回复，等着的连接拿到空串", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, text: "先看看", calls: [call("c1")] }));
    feed(w, userInput("插话"));
    const s = feed(w, stopInput());
    assert.deepEqual(s.out, [back("a", "先看看", "stopped", 4)]);
    assert.equal(textOf(current(w).at(-1)!), "插话");
    assert.equal(finalReply(current(w)), "");
  });

  test("done 时有排队的信：回信带这一轮的最终回复，不是新一轮的", () => {
    const w = begin();
    feed(w, userInput("插话"));
    const s = reply(w, assistant({ usage: LOW, text: "第一轮" }));
    assert.deepEqual(s.out, [back("a", "第一轮", "done", 4)]);
    assert.equal(w.p.phase.tag, "awaitingModel");
  });
});

describe("回信：排队的信里的 replyTo", () => {
  test("done：开新一轮，replyTo 和 hops 只取自这批信，不寄回信；上一轮的回信照寄，跳数含这批信", () => {
    const w = begin();
    feed(w, letterInput(processLetter("再问", { id: "b", replyTo: "b", hops: 7 })));
    const s = reply(w, assistant({ usage: LOW, text: "第一轮" }));
    // 回信的跳数：max(3, 7) + 1。
    assert.deepEqual(s.out, [back("a", "第一轮", "done", 8)]);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 7, replyTo: ["b"] }, purpose: "turn" });
    // 新一轮结束：只回信给 b，跳数 7 + 1。
    const t = reply(w, assistant({ usage: LOW, text: "第二轮" }));
    assert.deepEqual(t.out, [back("b", "第二轮", "done", 8)]);
  });

  test("不是 done：给 turn.replyTo 寄带正文的回信，给排队信的 replyTo 寄正文为空的回信", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, text: "做到一半", calls: [call("c1")] }));
    feed(w, letterInput(processLetter("再问", { id: "b", replyTo: "b", hops: 7 })));
    const s = feed(w, stopInput());
    assert.deepEqual(s.out, [back("a", "做到一半", "stopped", 8), back("b", "", "stopped", 8)]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
  });

  test("不是 done：出错也一样", () => {
    const w = begin();
    feed(w, letterInput(processLetter("再问", { id: "b", replyTo: "b", hops: 1 })));
    const s = reply(w, assistant({ usage: LOW, stopReason: "error", errorMessage: "坏了" }));
    assert.deepEqual(s.out, [back("a", "", { error: "坏了" }, 4), back("b", "", { error: "坏了" }, 4)]);
  });

  test("同一个进程只收一封：排队的信的 replyTo 已在 turn.replyTo 里", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, text: "做到一半", calls: [call("c1")] }));
    feed(w, letterInput(processLetter("补充", { id: "a", replyTo: "a", hops: 2 })));
    const s = feed(w, stopInput());
    assert.deepEqual(s.out, [back("a", "做到一半", "stopped", 4)]);
  });

  test("同一个进程只收一封：排队的两封信 replyTo 相同", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    feed(w, letterInput(processLetter("一", { id: "b", replyTo: "b", hops: 2 })));
    feed(w, letterInput(processLetter("二", { id: "b", replyTo: "b", hops: 5 })));
    const s = feed(w, stopInput());
    assert.deepEqual(s.out, [back("b", "", "stopped", 6)]);
  });

  test("done 且 turn.replyTo 为空：排队信的 replyTo 不寄信，只开新一轮", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    feed(w, letterInput(processLetter("问", { id: "b", replyTo: "b", hops: 2 })));
    const s = reply(w, assistant({ usage: LOW, text: "好" }));
    assert.deepEqual(s.out, []);
    assert.deepEqual(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.replyTo, ["b"]);
  });

  test("安全点并入的信：它的 replyTo 在本轮结束时收到带正文的回信", () => {
    const w = world(P);
    feed(w, userInput("你好"));
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    feed(w, letterInput(processLetter("问", { id: "b", replyTo: "b", hops: 5 })));
    toolDone(w, "好");
    assert.deepEqual(w.p.phase.tag === "awaitingModel" && [w.p.phase.turn.replyTo, w.p.phase.turn.hops], [["b"], 5]);
    const s = reply(w, assistant({ usage: LOW, text: "答" }));
    assert.deepEqual(s.out, [back("b", "答", "done", 6)]);
  });

  test("换段后的结束：回信带新段里的最终回复", () => {
    const w = begin();
    reply(w, assistant({ usage: 100_000, text: "旧段", calls: [call("c1")] }));
    toolDone(w, "好");
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    const s = reply(w, assistant({ usage: LOW, text: "新段的答案" }));
    assert.deepEqual(s.out, [back("a", "新段的答案", "done", 4)]);
  });
});

test("模型结果被丢弃时不寄信", () => {
  const w = begin();
  const n = effectOf(w.p, current(w))!.n;
  assert.deepEqual(feed(w, modelOk(n + 5, assistant({ usage: LOW, text: "伪造" }))).out, []);
  assert.deepEqual(feed(world(P), stopInput()).out, []);
});
