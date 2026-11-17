// D64 第 4 组：进程记录的 `since`：进入当前阶段、或者发出当前副作用的时刻。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fork, start } from "../../src/kernel/decide.ts";
import { observe } from "../../src/kernel/observe.ts";
import type { Process } from "../../src/kernel/types.ts";
import { assistant, call, current, env, feed, letter, letterInput, modelInterrupted, modelOk, preset, processLetter, reply, stopInput, toolDone, toolInterrupted, userInput, world } from "./helpers.ts";

const P = preset();

describe("since 在各转移上的值", () => {
  test("start 写建进程的时刻", () => {
    assert.equal(start("p", P, env(123)).since, 123);
  });

  test("空闲收信：发出模型调用的时刻；排队的信不动它", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    assert.equal(w.p.since, 20);
    feed(w, userInput("排队"), env(30));
    feed(w, letterInput(processLetter("又来")), env(40));
    assert.equal(w.p.since, 20, "留在 turn.queued 里，阶段和副作用都没变");
  });

  test("调用工具、工具结果后再调模型、正常结束，都写当时的 env.now", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    reply(w, assistant({ usage: 100, calls: [call("c1")] }), env(30));
    assert.equal(w.p.phase.tag, "awaitingTool");
    assert.equal(w.p.since, 30);
    toolDone(w, "ok", env(40));
    assert.equal(w.p.phase.tag, "awaitingModel");
    assert.equal(w.p.since, 40);
    reply(w, assistant({ usage: 200, text: "好了" }), env(50));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
    assert.equal(w.p.since, 50);
  });

  test("模型出错和模型被中断：段里不写消息，since 仍是结束的时刻", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    const before = current(w).length;
    reply(w, assistant({ usage: 0, stopReason: "error", errorMessage: "炸了" }), env(33));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "炸了" } });
    assert.equal(current(w).length, before, "出错不写消息");
    assert.equal(w.p.since, 33);
    feed(w, userInput("再来"), env(40));
    const n = w.p.lastEffect;
    feed(w, modelInterrupted(n), env(44));
    assert.equal(w.p.since, 44);
  });

  test("停止：写停止的时刻；空闲时的停止和过时的结果不动它", () => {
    const w = world(P, env(10));
    feed(w, stopInput(), env(15));
    assert.equal(w.p.since, 10, "空闲时停止什么都不改");
    feed(w, userInput("开头"), env(20));
    feed(w, modelOk(w.p.lastEffect + 7, assistant({ usage: 1, text: "过时" })), env(25));
    assert.equal(w.p.since, 20, "编号对不上的结果被忽略");
    feed(w, stopInput(), env(60));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
    assert.equal(w.p.since, 60);
  });

  test("工具被中断：结束的时刻", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    reply(w, assistant({ usage: 100, calls: [call("c1")] }), env(30));
    feed(w, toolInterrupted(w.p.lastEffect), env(70));
    assert.equal(w.p.phase.tag, "idle");
    assert.equal(w.p.since, 70);
  });

  test("结束时有排队的信：合并后接着开新一轮，since 是新一轮发出调用的时刻", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    feed(w, userInput("排队"), env(25));
    reply(w, assistant({ usage: 100, text: "好" }), env(80));
    assert.equal(w.p.phase.tag, "awaitingModel");
    assert.equal(w.p.since, 80);
  });

  test("换段：交接调用和新段里的调用，各写发出时刻", () => {
    const w = world(P, env(10));
    feed(w, userInput("开头"), env(20));
    reply(w, assistant({ usage: 100, text: "好" }), env(30));
    feed(w, letterInput({ ...letter("换段"), handoff: true }), env(40));
    assert.deepEqual([w.p.phase.tag, w.p.since], ["awaitingModel", 40]);
    reply(w, assistant({ usage: 100, text: "交接说明" }), env(50));
    assert.equal(w.p.segment.seq, 2);
    assert.equal(w.p.since, 50);
  });
});

test("fork 写建新进程的时刻，带 before 和不带 before 都一样", () => {
  const w = world(P, env(10));
  feed(w, userInput("开头"), env(20));
  reply(w, assistant({ usage: 100, text: "好" }), env(30));
  assert.equal(fork("a", w.p, current(w), undefined, 777).process.since, 777);
  assert.equal(fork("b", w.p, current(w), 0, 888).process.since, 888);
});

describe("投影的 ProcessView.since", () => {
  const withSince = (p: Process, since: number): Process => ({ ...p, since });
  test("自己、兄弟、子进程都带；旧记录没有这个键就不带", () => {
    const me = withSince({ ...start("me", P, env(0)), phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" }, lastEffect: 1 }, 500);
    const sib = withSince({ ...start("sib", P, env(0)), phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" }, lastEffect: 1 }, 600);
    const kid = withSince({ ...start("kid", P, env(0)), parent: "me", phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } }, lastEffect: 1 }, 700);
    const { since: _, ...old }: Process = { ...start("old", P, env(0)), phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose: "turn" }, lastEffect: 1 };
    const v = observe(me, [], [me, sib, kid, old], 1000);
    assert.equal(v.self.since, 500);
    assert.deepEqual(v.siblings.map((s) => [s.id, s.since]), [["sib", 600], ["kid", 700], ["old", undefined]]);
    assert.equal("since" in v.siblings.find((s) => s.id === "old")!, false);
    assert.deepEqual(v.children.map((s) => [s.id, s.since]), [["kid", 700]]);
  });
});
