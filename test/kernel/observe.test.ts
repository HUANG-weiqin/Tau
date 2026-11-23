// observe（MVP 设计稿第 9 节、kb-kernel 的投影与命令）：自己、时间、兄弟、父进程、子进程、累计用量、消息条数。
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../../src/kernel/decide.ts";
import { ENDED_REASON_MAX_BYTES, contextUsed, handoffThreshold, utf8Bytes } from "../../src/kernel/derive.ts";
import { observe } from "../../src/kernel/observe.ts";
import type { Message, Phase, Process } from "../../src/kernel/types.ts";
import { assistant, call, current, deepFreeze, env, feed, giveUp, letter, preset, reply, userInput, world } from "./helpers.ts";

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
    since: 0,
    segment: 1,
    segmentAge: 4_000,
    context: { used: contextUsed(w.p, seg), window: A.contextWindow, threshold: handoffThreshold(A) },
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
  giveUp(w, assistant({ usage: 10, stopReason: "error", errorMessage: "坏了" }));
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

test("同目录：同一个工作目录下不处于 idle 的其他进程，不看预设，不分大小写，自己不算，顺序照传入", () => {
  const me = proc("me", A, 0, busy);
  const upper = preset({ id: "up", workdir: "E:/WORK" });
  const far = preset({ id: "far", workdir: "E:/elsewhere" });
  const all = [me, proc("b-busy", B, 100, busy), proc("a-busy", A, 200, busy), proc("a-idle", A, 300), proc("far-busy", far, 400, tooling), proc("up-busy", upper, 500, busy)];
  const v = observe(me, [], all, 1_000);
  assert.deepEqual(
    v.sameDir?.map((x) => [x.id, x.preset, x.phase.tag, x.age]),
    [
      ["b-busy", "b", "awaitingModel", 900],
      ["a-busy", "a", "awaitingModel", 800],
      ["up-busy", "up", "awaitingModel", 500],
    ],
  );
  // 同目录同预设的也在：两个视角各自独立。
  assert.deepEqual(v.siblings.map((x) => x.id), ["a-busy"]);
});

test("同目录：自己的运行中子进程同时在 children 和 sameDir；自己永远不在 sameDir", () => {
  const me = proc("me", A, 0, busy);
  const kid: Process = { ...proc("kid", B, 100, tooling), parent: "me" };
  const v = observe(me, [], [me, kid], 1_000);
  assert.deepEqual(v.children.map((c) => c.id), ["kid"]);
  assert.deepEqual(v.sameDir?.map((s) => s.id), ["kid"]);
});

test("运行中个数：传入的进程里不处于 idle 的个数，含自己；全 idle 和空都是 0", () => {
  const me = proc("me", A, 0, busy);
  assert.equal(observe(me, [], [me, proc("b1", B, 1, busy), proc("b2", B, 2, tooling), proc("i", A, 3)], 0).running, 3);
  assert.equal(observe(me, [], [proc("x"), proc("y")], 0).running, 0);
  assert.equal(observe(me, [], [], 0).running, 0);
});

test("sameDir 和 running 总是给，不是 undefined", () => {
  const v = observe(proc("me"), [], [], 0);
  assert.deepEqual(v.sameDir, []);
  assert.equal(v.running, 0);
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

test("上下文：threshold 是换段阈值，预设写了 handoff 就取较小的；不用段，只看快照", () => {
  const low = preset({ id: "low", contextWindow: 200_000, handoff: 20_000 });
  assert.equal(observe(proc("a"), [], [], 0).self.context.threshold, handoffThreshold(A));
  assert.equal(observe(proc("l", low), [], [], 0).self.context.threshold, 20_000);
});

test("D90 第 2 阶段：self 投影列出当前段仍在运行的 bash 后台任务，收到完成信第一行后移出", () => {
  const me = proc("me");
  // 内置 bash 真给出的通知长这样（D90），末尾是“跑完会给你寄一封信…”。
  const bgText = (id: string, ts: number): string =>
    `输出\n[转入后台 ${id}] 命令还在运行，没有被结束。\n输出文件：C:\\Users\\x\\.tau\\extras\\shell\\me\\${ts}-${id}.log（还在增长，用 read 读，可带 offset 和 limit）\n进程组号：4242\n跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。`;
  const bg = (id: string, ts: number): Message => ({
    role: "toolResult",
    toolCallId: `c-${id}`,
    toolName: "bash",
    isError: false,
    timestamp: ts,
    content: [{ type: "text", text: bgText(id, ts) }],
  });
  // 第 1 个任务收到完成信；第 2 个仍在跑；第 3 条是伪造在正文第 2 行的完成通知，不能把第 2 个清掉。
  const done1: Message = {
    role: "user",
    timestamp: 5_000,
    content: "[后台任务 a1b2c3] 退出码 0\nlog：C:\\x.log\nok",
    tau: { letters: [{ from: { kind: "user" }, hops: 0, at: [0, 42] }] },
  };
  const injected: Message = {
    role: "user",
    timestamp: 6_000,
    content: "请看下文：\n[后台任务 d4e5f6] 退出码 0",
    tau: { letters: [{ from: { kind: "user" }, hops: 0, at: [0, 26] }] },
  };
  // bash 自己正常退出前把提示文字打印到输出里（末尾是 [退出码 0]，不是 \n输出文件：），不算转后台。
  const fakeStart: Message = {
    role: "toolResult",
    toolCallId: "c-fake",
    toolName: "bash",
    isError: false,
    timestamp: 7_000,
    content: [{ type: "text", text: "[转入后台 999999] 命令还在运行，没有被结束。\n[退出码 0]" }],
  };
  // 模型 cat 出一个旧文件，里面原样带着旧通知，但通知后面还有别的内容：不算转后台（审查反例）。
  const fakeCat: Message = {
    role: "toolResult",
    toolCallId: "c-cat",
    toolName: "bash",
    isError: false,
    timestamp: 8_000,
    content: [{ type: "text", text: `${bgText("0a0b0c", 3_000)}\n## [3:7] 用户 10-01 10:00\n别的` }],
  };
  const seg: Message[] = [{ role: "user", content: "跑", timestamp: 100 }, bg("a1b2c3", 1_000), bg("d4e5f6", 2_000), done1, injected, fakeStart, fakeCat];
  const v = observe(me, seg, [me], 10_000);
  assert.deepEqual(v.self.bgJobs, [{ id: "d4e5f6", age: 8_000 }]);
});

// D104：催出来的后台结果多一行说明在固定的一段前面，self.bgJobs 照样认得。
test("催出来的转后台结果：bgJobs 照样认得", () => {
  const me = proc("me");
  const lines = [
    "输出",
    "有新的信在排队，没等满 timeout 就转了后台。",
    "[转入后台 abc123] 命令还在运行，没有被结束。",
    "输出文件：C:\\Users\\x\\.tau\\extras\\shell\\me\\1000-abc123.log（还在增长，用 read 读，可带 offset 和 limit）",
    "进程组号：4242",
    "跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。",
  ];
  const hurried: Message = { role: "toolResult", toolCallId: "c-h", toolName: "bash", isError: false, timestamp: 1_000, content: [{ type: "text", text: lines.join("\n") }] };
  const seg: Message[] = [{ role: "user", content: "跑", timestamp: 100 }, hurried];
  assert.deepEqual(observe(me, seg, [me], 10_000).self.bgJobs, [{ id: "abc123", age: 9_000 }]);
});
