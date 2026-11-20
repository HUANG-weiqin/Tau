// D92：弱模型兜底。可恢复的模型失败不结束这一轮，重发同一个请求，请求末尾带一条不入库的提示，有次数上限。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, EMPTY_REPLY_NOTE, HANDOFF_INSTRUCTION, HANDOFF_RETRY, LENGTH_NOTE } from "../../src/kernel/context.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import { HANDOFF_REQUEST_MAX_BYTES, RETRIES_PER_REPLY, STEPS_PER_TURN, tokens, utf8Bytes } from "../../src/kernel/derive.ts";
import type { AssistantMessage } from "../../src/kernel/types.ts";
import { assistant, call, current, feed, letter, letterInput, modelInterrupted, preset, reply, stopInput, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const LOW = 1_000;
/** 失败的回复，用量不是 0：用量也要累计。 */
const empty = (stopReason: "stop" | "toolUse" = "stop") => assistant({ usage: LOW, stopReason, thinking: "想了想", text: " \n" });
const cut = () => assistant({ usage: LOW, stopReason: "length", text: "半截" });
const broke = (errorMessage = "boom") => assistant({ usage: LOW, stopReason: "error", errorMessage });

function begin(text = "你好"): World {
  const w = world(preset());
  feed(w, userInput(text));
  return w;
}

/** 进程在等换段说明：回复的用量已经过了阈值，工具结果写入后就换段。 */
function beginHandoff(): World {
  const w = world(preset());
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: 150_000, text: "先看", calls: [call("c1")] }));
  toolDone(w, "好");
  assert.equal(waiting(w).purpose, "handoff");
  return w;
}

function waiting(w: World) {
  const ph = w.p.phase;
  if (ph.tag !== "awaitingModel") throw new Error(`阶段是 ${ph.tag}，应为 awaitingModel`);
  return ph;
}

/** 回复之后：还在等模型，用途不变，重试记号、步数、副作用编号都对，段没有变。 */
function assertRetried(w: World, before: { effect: number; steps: number; len: number; seq: number }, expected: { kind: "empty" | "length" | "handoff" | "error"; n: number }, purpose: "turn" | "handoff") {
  const ph = waiting(w);
  assert.equal(ph.purpose, purpose);
  assert.deepEqual(ph.turn.retry, expected);
  assert.equal(ph.turn.steps, before.steps + 1);
  assert.equal(w.p.lastEffect, before.effect + 1);
  assert.equal(current(w).length, before.len, "失败的回复不入段");
  assert.equal(w.p.segment.seq, before.seq);
  assert.deepEqual(effectOf(w.p, current(w)), { kind: "callModel", n: w.p.lastEffect, purpose });
}

const snap = (w: World) => ({ effect: w.p.lastEffect, steps: waiting(w).turn.steps, len: current(w).length, seq: w.p.segment.seq });

/** 连续失败 `RETRIES_PER_REPLY` 次，每次都重发；返回最后一次重发后的状态。 */
function failTimes(w: World, make: () => AssistantMessage, kind: "empty" | "length" | "handoff" | "error", purpose: "turn" | "handoff") {
  for (let n = 1; n <= RETRIES_PER_REPLY; n++) {
    const before = snap(w);
    const s = reply(w, make());
    assert.deepEqual(s.append, []);
    assert.deepEqual(s.out, []);
    assertRetried(w, before, { kind, n }, purpose);
  }
}

describe("重试次数", () => {
  test("上限是 2", () => assert.equal(RETRIES_PER_REPLY, 2));
});

describe("1 空回复", () => {
  for (const stopReason of ["stop", "toolUse"] as const) {
    test(`${stopReason}：没有非空白文字、没有工具调用：重发两次，第三次保持现状（写进段，done）`, () => {
      const w = begin();
      failTimes(w, () => empty(stopReason), "empty", "turn");
      const s = reply(w, empty(stopReason));
      assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
      assert.equal(s.append.length, 1);
      assert.equal(current(w).length, 2);
    });
  }

  test("没有任何内容块也算空", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW }));
    assert.deepEqual(waiting(w).turn.retry, { kind: "empty", n: 1 });
  });

  test("带工具调用的不算空，哪怕没有文字", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    assert.equal(w.p.phase.tag, "awaitingTool");
  });

  test("有文字的不算空", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, text: "好" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("失败的回复的用量照样累计", () => {
    const w = begin();
    reply(w, empty());
    assert.equal(w.p.usage.input, LOW);
  });
});

describe("2 length", () => {
  test("重发两次，第三次报“输出被截断”，截断的回复都不入段", () => {
    const w = begin();
    failTimes(w, cut, "length", "turn");
    const s = reply(w, cut());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "输出被截断" } });
    assert.deepEqual(s.append, []);
    assert.equal(current(w).length, 1);
  });

  test("length 带着工具调用也不入段、不执行", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, stopReason: "length", text: "半截", calls: [call("c1")] }));
    assert.deepEqual(waiting(w).turn.retry, { kind: "length", n: 1 });
    assert.equal(current(w).length, 1);
  });
});

describe("3 stop 带工具调用", () => {
  test("进 awaitingTool，调用不补“未执行”", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: LOW, stopReason: "stop", text: "我来读", calls: [call("c1"), call("c2")] }));
    assert.equal(w.p.phase.tag, "awaitingTool");
    assert.equal(s.append.length, 1);
    assert.deepEqual(effectOf(w.p, current(w)), { kind: "runTool", n: w.p.lastEffect, call: call("c1") });
    toolDone(w, "内容1");
    toolDone(w, "内容2");
    assert.equal(waiting(w).purpose, "turn");
    assert.deepEqual(current(w).slice(2).map((m) => m.role), ["toolResult", "toolResult"]);
    assert.ok(current(w).slice(2).every((m) => m.role === "toolResult" && !m.isError && m.tau === undefined));
  });
});

describe("4 换段", () => {
  test("toolUse：重发两次（用途仍是 handoff），第三次报交接失败", () => {
    const w = beginHandoff();
    const make = () => assistant({ usage: LOW, text: "我先查一下", calls: [call("h1")] });
    failTimes(w, make, "handoff", "handoff");
    const s = reply(w, make());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：toolUse" } });
    assert.deepEqual(s.append.length, 0);
    assert.equal(w.p.segment.seq, 1);
  });

  for (const stopReason of ["stop", "length"] as const) {
    test(`${stopReason} 但说明为空：重发两次，第三次报交接失败：${stopReason}`, () => {
      const w = beginHandoff();
      const make = () => assistant({ usage: LOW, stopReason, text: "  ", thinking: "想" });
      failTimes(w, make, "handoff", "handoff");
      reply(w, make());
      assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: `交接失败：${stopReason}` } });
    });
  }

  test("重试后拿到说明：开新段，turn 里没有 retry", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, calls: [call("h1")] }));
    assert.deepEqual(waiting(w).turn.retry, { kind: "handoff", n: 1 });
    const s = reply(w, assistant({ usage: LOW, text: "交接说明：继续" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(s.append.length, 1);
    const ph = waiting(w);
    assert.equal(ph.purpose, "turn");
    assert.ok(!("retry" in ph.turn));
  });

  test("有说明的 length 照旧被接受", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, stopReason: "length", text: "说明" }));
    assert.equal(w.p.segment.seq, 2);
  });

  test("交接请求里 toolUse 带说明文字也不接受", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, text: "让我先查一下", calls: [call("h1")] }));
    assert.equal(w.p.segment.seq, 1);
    assert.deepEqual(waiting(w).turn.retry, { kind: "handoff", n: 1 });
  });
});

describe("5 流中途出错", () => {
  test("turn：重发两次，第三次按现状报错", () => {
    const w = begin();
    failTimes(w, () => broke("连接断了"), "error", "turn");
    reply(w, broke("连接断了"));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "连接断了" } });
    assert.equal(current(w).length, 1);
  });

  test("没有 errorMessage 时原因是 stopReason", () => {
    const w = begin();
    failTimes(w, () => assistant({ usage: LOW, stopReason: "error" }), "error", "turn");
    reply(w, assistant({ usage: LOW, stopReason: "error" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "error" } });
  });

  test("handoff：同样重发，用途不变", () => {
    const w = beginHandoff();
    failTimes(w, () => broke("断了"), "error", "handoff");
    reply(w, broke("断了"));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：断了" } });
  });

  for (const stopReason of ["aborted", "pending", "deferred"] as const) {
    test(`${stopReason} 不重试`, () => {
      const w = begin();
      reply(w, assistant({ usage: LOW, stopReason, errorMessage: "x" }));
      assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "x" } });
      const h = beginHandoff();
      reply(h, assistant({ usage: LOW, stopReason }));
      assert.deepEqual(h.p.phase, { tag: "idle", ended: { error: `交接失败：${stopReason}` } });
    });
  }
});

describe("计数", () => {
  test("换一种失败，n 接着数：交替失败也最多重发两次", () => {
    const w = begin();
    reply(w, empty());
    assert.deepEqual(waiting(w).turn.retry, { kind: "empty", n: 1 });
    reply(w, cut());
    assert.deepEqual(waiting(w).turn.retry, { kind: "length", n: 2 });
    reply(w, broke());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "boom" } });
  });

  test("好的回复把 retry 清掉：之后的阶段里都没有，新的失败又从 1 数", () => {
    const w = begin();
    reply(w, empty());
    reply(w, empty());
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    const tool = w.p.phase;
    assert.equal(tool.tag, "awaitingTool");
    assert.ok(tool.tag === "awaitingTool" && !("retry" in tool.turn));
    toolDone(w, "好");
    assert.ok(!("retry" in waiting(w).turn));
    reply(w, empty());
    assert.deepEqual(waiting(w).turn.retry, { kind: "empty", n: 1 });
  });

  test("重试后得到正常的最终回复：idle，下一轮从干净的 turn 开始", () => {
    const w = begin();
    reply(w, broke());
    reply(w, assistant({ usage: LOW, text: "答案" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
    feed(w, userInput("再问"));
    assert.ok(!("retry" in waiting(w).turn));
  });

  test("重试也计步：步数用完时不再重发，以 stepLimit 结束", () => {
    const w = begin();
    const ph = waiting(w);
    w.p = { ...w.p, lastEffect: STEPS_PER_TURN, phase: { ...ph, turn: { ...ph.turn, steps: STEPS_PER_TURN } } };
    reply(w, empty());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
  });
});

describe("请求末尾的提示", () => {
  /** 没有 retry 时的请求，用来比较。 */
  const plain = (w: World) => {
    const ph = waiting(w);
    const { retry: _, ...turn } = ph.turn;
    return buildContext({ ...w.p, phase: { ...ph, turn } }, current(w));
  };

  test("empty：末尾加一条用户消息，时间戳取段里最后一条的；其余和没有 retry 时一字不差", () => {
    const w = begin();
    reply(w, empty());
    const req = buildContext(w.p, current(w));
    const base = plain(w);
    assert.equal(EMPTY_REPLY_NOTE, "你上一条回复是空的：没有文字，也没有工具调用。请继续做事；做完了就写出最终回复。");
    assert.deepEqual(req.messages, [...base.messages, { role: "user", content: EMPTY_REPLY_NOTE, timestamp: current(w).at(-1)!.timestamp }]);
    assert.equal(req.systemPrompt, base.systemPrompt);
    assert.deepEqual(req.tools, base.tools);
  });

  test("length", () => {
    const w = begin();
    reply(w, cut());
    const req = buildContext(w.p, current(w));
    assert.equal(LENGTH_NOTE, "你上一条回复太长，被截断，已经丢弃。请缩短思考和输出，把事情拆成小步，一步一步做。");
    assert.deepEqual(req.messages.slice(0, -1), plain(w).messages);
    assert.deepEqual(req.messages.at(-1), { role: "user", content: LENGTH_NOTE, timestamp: 0 });
  });

  test("error：不追加，请求和没有 retry 时一样", () => {
    const w = begin();
    reply(w, broke());
    assert.deepEqual(buildContext(w.p, current(w)), plain(w));
  });

  test("handoff：提示接在交接指令同一条消息里，空行隔开", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, calls: [call("h1")] }));
    const req = buildContext(w.p, current(w));
    assert.equal(HANDOFF_RETRY, "注意：你上一次回复没有写出交接说明。这一次不要调用任何工具，也不要写工具调用，只用文字写交接说明。");
    const base = plain(w);
    assert.equal(req.messages.length, base.messages.length);
    assert.deepEqual(req.messages.slice(0, -1), base.messages.slice(0, -1));
    assert.deepEqual(req.messages.at(-1), { role: "user", content: `${HANDOFF_INSTRUCTION}\n\n${HANDOFF_RETRY}`, timestamp: base.messages.at(-1)!.timestamp });
    assert.deepEqual(req.tools, base.tools);
  });

  test("handoff 的 error 重试：也带提示，只要重发过就带（kind 只记最后一次失败的种类）", () => {
    const w = beginHandoff();
    const first = buildContext(w.p, current(w));
    reply(w, broke());
    const req = buildContext(w.p, current(w));
    assert.deepEqual(req.messages.slice(0, -1), first.messages.slice(0, -1));
    assert.equal(req.messages.at(-1)!.role === "user" && req.messages.at(-1)!.content, `${HANDOFF_INSTRUCTION}\n\n${HANDOFF_RETRY}`);
  });

  test("handoff：toolUse 再流出错：第三次请求仍带提示", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, calls: [call("h1")] }));
    reply(w, broke());
    assert.deepEqual(waiting(w).turn.retry, { kind: "error", n: 2 });
    const last = buildContext(w.p, current(w)).messages.at(-1)!;
    assert.equal(last.role === "user" && last.content, `${HANDOFF_INSTRUCTION}\n\n${HANDOFF_RETRY}`);
  });

  test("提示不入库，不进 append", () => {
    const w = begin();
    const s = reply(w, empty());
    assert.deepEqual(s.append, []);
    assert.ok(current(w).every((m) => m.role !== "user" || typeof m.content !== "string" || m.content !== EMPTY_REPLY_NOTE));
  });

  test("HANDOFF_REQUEST_MAX_BYTES 是指令加分隔加重试提示", () => {
    assert.equal(HANDOFF_REQUEST_MAX_BYTES, utf8Bytes(`${HANDOFF_INSTRUCTION}\n\n${HANDOFF_RETRY}`));
    assert.ok(tokens(HANDOFF_REQUEST_MAX_BYTES) > tokens(utf8Bytes(HANDOFF_INSTRUCTION)));
  });
});

describe("重试期间来信", () => {
  test("信进 queued，重发时原样保留；之后的安全点合并一次，不丢不重复", () => {
    const w = begin("开始");
    reply(w, empty());
    feed(w, letterInput(letter("插一句")));
    assert.equal(waiting(w).turn.queued.length, 1);
    reply(w, empty());
    assert.equal(waiting(w).turn.queued.length, 1, "重发不动 queued");
    assert.deepEqual(waiting(w).turn.retry, { kind: "empty", n: 2 });
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    assert.equal(w.p.phase.tag, "awaitingTool");
    toolDone(w, "好");
    const users = current(w).filter((m) => m.role === "user").map(textOf);
    assert.deepEqual(users, ["开始", "插一句"]);
    assert.equal(waiting(w).turn.queued.length, 0);
    assert.ok(!("retry" in waiting(w).turn));
    reply(w, assistant({ usage: LOW, text: "好了" }));
    assert.deepEqual(current(w).filter((m) => m.role === "user").map(textOf), ["开始", "插一句"]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("重试用完后报错结束：信由 endTurn 合并写进段，只合并一次", () => {
    const w = begin("开始");
    reply(w, cut());
    feed(w, letterInput(letter("插一句")));
    reply(w, cut());
    reply(w, cut());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "输出被截断" } });
    assert.deepEqual(current(w).filter((m) => m.role === "user").map(textOf), ["开始", "插一句"]);
  });

  test("重试成功以 done 结束：排队的信开下一轮，只合并一次", () => {
    const w = begin("开始");
    reply(w, broke());
    feed(w, letterInput(letter("插一句")));
    reply(w, assistant({ usage: LOW, text: "答" }));
    assert.deepEqual(current(w).filter((m) => m.role === "user").map(textOf), ["开始", "插一句"]);
    const ph = waiting(w);
    assert.equal(ph.turn.queued.length, 0);
    assert.ok(!("retry" in ph.turn));
    assert.equal(ph.turn.steps, 1);
  });

  test("换段重试期间来信：换段成功后仍在 queued，轮结束时合并一次，不丢不重复", () => {
    const w = beginHandoff();
    reply(w, assistant({ usage: LOW, calls: [call("h1")] }));
    feed(w, letterInput(letter("补一句")));
    reply(w, assistant({ usage: LOW, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(current(w).length, 1);
    assert.equal(waiting(w).turn.queued.length, 1);
    reply(w, assistant({ usage: LOW, text: "好" }));
    const users = current(w).filter((m) => m.role === "user").map(textOf);
    assert.equal(users.length, 2);
    assert.ok(users[0]!.includes("交接说明"));
    assert.equal(users[1], "补一句");
  });

  test("停止：重试中停止照常结束，retry 随 turn 丢掉", () => {
    const w = begin();
    reply(w, empty());
    feed(w, stopInput());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
  });
});

describe("崩溃", () => {
  test("重试中的 awaitingModel 被中断：照旧 error，不再重试", () => {
    for (const make of [beginHandoff, begin]) {
      const w = make();
      reply(w, make === begin ? empty() : assistant({ usage: LOW, calls: [call("h1")] }));
      assert.ok(waiting(w).turn.retry);
      feed(w, modelInterrupted(w.p.lastEffect));
      assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "服务重启，模型调用被中断" } });
    }
  });
});
