// observe（设计稿第 9 节）：自己、时间、兄弟进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../../src/kernel/decide.ts";
import { contextUsed } from "../../src/kernel/derive.ts";
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
