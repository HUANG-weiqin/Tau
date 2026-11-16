// 设计稿第 5.8 节：累计用量。不被丢弃的 ok 的 modelResult 都加，写不写进段都加；丢弃的和被中断的不加。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handoffThreshold } from "../../src/kernel/derive.ts";
import type { Usage } from "../../src/kernel/types.ts";
import { assistant, call, feed, modelInterrupted, modelOk, preset, reply, stopInput, toolDone, usage, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000 });
const HIGH = Math.ceil(handoffThreshold(P));
const ZERO: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** 四项各不相同，加错一项就能看出来。 */
const u = (k: number) => usage(0, { input: 1000 * k, output: 100 * k, cacheRead: 10 * k, cacheWrite: k });
/** `u(k)` 各次之和。 */
const sum = (...ks: number[]): Usage => {
  const k = ks.reduce((a, b) => a + b, 0);
  return { input: 1000 * k, output: 100 * k, cacheRead: 10 * k, cacheWrite: k };
};
const plus = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

function begin(): World {
  const w = world(P);
  feed(w, userInput("你好"));
  return w;
}

/** 等交接说明；已经累计了第一次回复的用量。 */
function atHandoff(): World {
  const w = begin();
  reply(w, assistant({ usage: usage(HIGH, { input: HIGH }), calls: [call("c1")] }));
  toolDone(w, "好");
  assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
  return w;
}

describe("累计用量", () => {
  test("新进程全是 0", () => {
    assert.deepEqual(world(P).p.usage, ZERO);
  });

  test("每种回复都加：toolUse、stop、length、error、aborted、pending、deferred", () => {
    for (const stopReason of ["toolUse", "stop", "length", "error", "aborted", "pending", "deferred"] as const) {
      const w = begin();
      reply(w, assistant({ usage: u(1), stopReason, text: "x" }));
      assert.deepEqual(w.p.usage, sum(1), stopReason);
    }
  });

  test("跨多次调用累加，四项各自累加", () => {
    const w = begin();
    reply(w, assistant({ usage: u(1), calls: [call("c1")] }));
    toolDone(w, "好");
    reply(w, assistant({ usage: u(2), text: "完成" }));
    assert.deepEqual(w.p.usage, sum(1, 2));
    feed(w, userInput("再来"));
    reply(w, assistant({ usage: u(4), text: "好" }));
    assert.deepEqual(w.p.usage, sum(1, 2, 4));
  });

  test("工具调用太多的回复不写进段，用量照加", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: u(3), calls: [call("x".repeat(9_000))] }));
    assert.deepEqual(s.append, []);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "一次回复的工具调用太多" } });
    assert.deepEqual(w.p.usage, sum(3));
  });

  test("交接回复：成功换段的和失败的都加，即使它不写进旧段", () => {
    const ok = atHandoff();
    const before = ok.p.usage;
    reply(ok, assistant({ usage: u(5), text: "交接说明" }));
    assert.equal(ok.p.segment.seq, 2);
    assert.deepEqual(ok.p.usage, plus(before, sum(5)));

    const failures = [
      assistant({ usage: u(5), stopReason: "error", errorMessage: "超时" }),
      assistant({ usage: u(5), stopReason: "toolUse", calls: [call("h1")] }),
      assistant({ usage: u(5), stopReason: "stop", text: "  " }),
    ];
    for (const m of failures) {
      const w = atHandoff();
      const b = w.p.usage;
      reply(w, m);
      assert.equal(w.p.phase.tag, "idle");
      assert.deepEqual(w.p.usage, plus(b, sum(5)));
    }
  });

  test("不加：空闲时迟到或重复的结果、编号不对的", () => {
    const w = begin();
    const n = w.p.lastEffect;
    reply(w, assistant({ usage: u(1), text: "完成" }));
    const after = w.p.usage;
    assert.deepEqual(after, sum(1));
    feed(w, modelOk(n, assistant({ usage: u(9), text: "重复" })));
    feed(w, modelOk(n + 7, assistant({ usage: u(9), text: "伪造" })));
    assert.deepEqual(w.p.usage, after);

    feed(w, userInput("再来"));
    feed(w, modelOk(w.p.lastEffect - 1, assistant({ usage: u(9), text: "编号不对" })));
    feed(w, modelOk(w.p.lastEffect + 1, assistant({ usage: u(9), text: "编号不对" })));
    assert.deepEqual(w.p.usage, after);
  });

  test("不加：停止之后才到的结果；等工具时到的模型结果", () => {
    const w = begin();
    const n = w.p.lastEffect;
    feed(w, stopInput());
    feed(w, modelOk(n, assistant({ usage: u(9), text: "停止之后才到" })));
    assert.deepEqual(w.p.usage, ZERO);

    const t = begin();
    reply(t, assistant({ usage: u(1), calls: [call("c1")] }));
    feed(t, modelOk(t.p.lastEffect, assistant({ usage: u(9), text: "种类对不上" })));
    assert.deepEqual(t.p.usage, sum(1));
  });

  test("不加：被中断的调用没有用量", () => {
    const w = begin();
    feed(w, modelInterrupted(w.p.lastEffect));
    assert.deepEqual(w.p.usage, ZERO);
  });
});
