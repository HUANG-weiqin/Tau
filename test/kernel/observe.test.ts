// observe（设计稿第 9 节、kernel-v2 第 4 节）：自己、时间、兄弟、父进程、子进程、累计用量、消息条数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../../src/kernel/decide.ts";
import { ENDED_REASON_MAX_BYTES, contextUsed, utf8Bytes } from "../../src/kernel/derive.ts";
import { observe } from "../../src/kernel/observe.ts";
import type { Message, Phase, Process } from "../../src/kernel/types.ts";
import { assistant, call, current, deepFreeze, env, feed, letter, preset, reply, userInput, world } from "./helpers.ts";

const A = preset({ id: "a", model: "faux/a" });
const B = preset({ id: "b" });

function proc(id: string, pr = A, createdAt = 0, phase: Phase = { tag: "idle" }): Process {
  return { ...start(id, pr, env(createdAt)), lastEffect: phase.tag === "idle" ? 0 : 1, phase };
}

const busy: Phase = { tag: "awaitingModel", turn: { steps: 3, queued: [letter("x")], hops: 0, replyTo: [] }, purpose: "turn" };
const tooling: Phase = { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } };

test("自己：ID、预设、模型、阶段、第几段、本段开始多久、上下文已用和窗口", () => {
  const w = world(A, env(1_000), "me");
  feed(w, userInput("你好"), env(5_000));
  reply(w, assistant({ usage: 1_234, calls: [call("c1")] }));
  feed(w, userInput("排队一"));
  feed(w, userInput("排队二"));
  const seg = current(w);
  const v = observe(w.p, seg, [], 9_000);
  assert.equal(v.now, 9_000);
  assert.deepEqual(v.self, {
    id: "me",
    preset: "a",
    model: "faux/a",
    phase: { tag: "awaitingTool", steps: 1, queued: 2 },
    age: 8_000,
    segment: 1,
    segmentAge: 4_000,
    context: { used: contextUsed(w.p, seg), window: A.contextWindow },
    messages: 2,
    usage: { input: 1_234, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal(v.self.context.used, 1_234);
});

test("阶段：等模型时带用途；idle 带上一轮的结束原因，没跑过就没有", () => {
  assert.deepEqual(observe(proc("p", A, 0, busy), [{ role: "user", content: "u", timestamp: 0 }], [], 0).self.phase, {
    tag: "awaitingModel",
    purpose: "turn",
    steps: 3,
    queued: 1,
  });
  const fresh = observe(proc("p"), [], [], 10).self;
  assert.deepEqual(fresh.phase, { tag: "idle" });
  assert.equal(fresh.segmentAge, null);

  const w = world(A);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: 10, stopReason: "error", errorMessage: "坏了" }));
  assert.deepEqual(observe(w.p, current(w), [], 0).self.phase, { tag: "idle", ended: { error: "坏了" } });
});

test("兄弟：同一个预设下不处于 idle 的其他进程，带 ID、阶段、运行多久", () => {
  const me = proc("me", A, 0, busy);
  const siblings = [
    me,
    proc("a-busy", A, 100, busy),
    proc("a-idle", A, 200),
    proc("b-busy", B, 300, busy),
    proc("a-tool", A, 400, tooling),
    { ...proc("a-ended", A, 500), lastEffect: 4, phase: { tag: "idle", ended: "done" } } satisfies Process,
  ];
  const v = observe(me, [{ role: "user", content: "u", timestamp: 0 }], siblings, 1_000);
  assert.deepEqual(
    v.siblings.map((s) => [s.id, s.phase.tag, s.age]),
    [
      ["a-busy", "awaitingModel", 900],
      ["a-tool", "awaitingTool", 600],
    ],
  );
  assert.deepEqual(v.siblings[0]?.phase, { tag: "awaitingModel", purpose: "turn", steps: 3, queued: 1 });
});

test("observe 是纯函数：不改输入，同样的输入给同样的结果", () => {
  const me = deepFreeze(proc("me", A, 0, busy));
  const seg: readonly Message[] = deepFreeze([{ role: "user", content: "u", timestamp: 5 }]);
  const others = deepFreeze([proc("x", A, 1, busy)]);
  assert.deepEqual(observe(me, seg, others, 50), observe(me, seg, others, 50));
});

test("消息条数是当前段的条数，累计用量是进程记录的用量", () => {
  const me: Process = { ...proc("me"), usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } };
  const seg: Message[] = [
    { role: "user", content: "a", timestamp: 0 },
    { role: "user", content: "b", timestamp: 1 },
    { role: "user", content: "c", timestamp: 2 },
  ];
  const v = observe(me, seg, [], 10).self;
  assert.equal(v.messages, 3);
  assert.deepEqual(v.usage, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
  assert.equal(observe(me, [], [], 10).self.messages, 0);
});

test("父进程：有就带 parent，没有就没有这个键", () => {
  const kid: Process = { ...proc("kid"), parent: "me" };
  assert.equal(observe(kid, [], [], 0).self.parent, "me");
  assert.equal("parent" in observe(proc("me"), [], [], 0).self, false);
});

test("子进程：parent 是自己的，运行中的带视图，空闲的只给个数；不分预设，不含别人的子进程", () => {
  const me = proc("me", A, 0, busy);
  const kid = (id: string, pr: Process["preset"], phase: Phase, parent: string, at: number): Process => ({ ...proc(id, pr, at, phase), parent });
  const all = [
    me,
    kid("k-busy", A, busy, "me", 100),
    kid("k-tool", B, tooling, "me", 200),
    kid("k-idle", A, { tag: "idle" }, "me", 300),
    { ...kid("k-done", B, { tag: "idle", ended: "done" }, "me", 400), lastEffect: 3 },
    kid("other-kid", A, busy, "other", 500),
    proc("no-parent", A, 600, busy),
  ];
  const v = observe(me, [], all, 1_000);
  assert.deepEqual(
    v.children.map((c) => [c.id, c.preset, c.parent, c.phase.tag, c.age]),
    [
      ["k-busy", "a", "me", "awaitingModel", 900],
      ["k-tool", "b", "me", "awaitingTool", 800],
    ],
  );
  assert.equal(v.idleChildren, 2);
  // 兄弟照 v1：同一个预设、不处于 idle 的其他进程，子进程也算。
  assert.deepEqual(v.siblings.map((s) => s.id), ["k-busy", "other-kid", "no-parent"]);
  // 孙子不算：只看 parent 等于自己。
  const grand = observe(proc("g", A), [], [...all, { ...proc("gg", A, 0, busy), parent: "g" }], 0);
  assert.deepEqual(grand.children.map((c) => c.id), ["gg"]);
  assert.equal(grand.idleChildren, 0);
});

test("出错的原因在投影里截短：先截再把换行换成空格；进程记录里仍是原文", () => {
  const long = `头${"x".repeat(2_000)}\n尾`;
  const me: Process = { ...proc("me", A, 0, { tag: "idle", ended: { error: long } }), lastEffect: 2 };
  const v = observe(me, [], [me], 0);
  const shown = (v.self.phase as { ended: { error: string } }).ended.error;
  assert.ok(utf8Bytes(shown) <= ENDED_REASON_MAX_BYTES + 3, String(utf8Bytes(shown)));
  assert.ok(shown.length < long.length && shown.startsWith("头") && shown.endsWith("尾") && !/[\r\n]/.test(shown));
  assert.equal((me.phase as { ended: { error: string } }).ended.error, long);
});
