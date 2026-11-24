// 交接请求的最后一次重发放宽（D110）：前两次和以前一字不差；次数用完、本来要报交接失败时，收下 handoff 调用参数里的字符串，toolUse 而调用全是 handoff 也收下。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_HEADER } from "../../src/kernel/context.ts";
import { assistant, call, current, feed, preset, reply, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const summary = "目标：重构 X 模块。已完成 a、b。试过把 c 并进 a，循环依赖，放弃。下一步 d。";

function atHandoff(): World {
  const w = world(preset({ contextWindow: 200_000, handoff: 30_000 }));
  feed(w, userInput("重构 X 模块"));
  reply(w, assistant({ usage: 31_000, calls: [call("r0", "read")] }));
  toolDone(w, "内容");
  assert.ok(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose === "handoff");
  return w;
}
const first = (w: World) => textOf(current(w)[0]!);
const retryOf = (w: World) => (w.p.phase.tag === "awaitingModel" ? w.p.phase.turn.retry : undefined);

test("说明写在 handoff 的参数里：前两次照旧重发，第三次收下正文加参数", () => {
  const w = atHandoff();
  const make = () => assistant({ usage: 31_500, stopReason: "toolUse", text: "好的，现在开始换段。", calls: [call("h", "handoff", { summary })] });
  reply(w, make());
  assert.deepEqual(retryOf(w), { kind: "handoff", n: 1 });
  reply(w, make());
  assert.deepEqual(retryOf(w), { kind: "handoff", n: 2 });
  reply(w, make());
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(`${HANDOFF_HEADER}好的，现在开始换段。\n${summary}`));
  assert.ok(current(w).every((m) => m.role !== "assistant"));
  assert.ok(w.p.phase.tag === "awaitingModel" && !("retry" in w.p.phase.turn));
});

test("旁白加 handoff，第二次只写文字：和现在一样，第二次拿到完整说明", () => {
  const w = atHandoff();
  reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: "我来调用 handoff 工具完成换段。", calls: [call("h", "handoff", {})] }));
  assert.equal(w.p.segment.seq, 1);
  reply(w, assistant({ usage: 31_500, text: summary }));
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(HANDOFF_HEADER + summary));
});

test("完整说明加 handoff：第三次收下，不再报交接失败", () => {
  const w = atHandoff();
  for (let i = 0; i < 3; i++) reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("h", "handoff", {})] }));
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(HANDOFF_HEADER + summary));
});

test("中间夹一次流出错：n 不分种类，第三次照样收下", () => {
  const w = atHandoff();
  reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("h", "handoff", {})] }));
  reply(w, assistant({ usage: 0, stopReason: "error", errorMessage: "断了" }));
  assert.deepEqual(retryOf(w), { kind: "error", n: 2 });
  reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("h", "handoff", {})] }));
  assert.equal(w.p.segment.seq, 2);
});

test("说明加 [memory_set, handoff]：照旧报交接失败：toolUse", () => {
  const w = atHandoff();
  for (let i = 0; i < 3; i++) reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("m", "memory_set", { key: "k", value: "v", brief: "b" }), call("h", "handoff", {})] }));
  assert.equal(w.p.segment.seq, 1);
  assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：toolUse" } });
});

test("只有空白的文字加 handoff({})：照旧报交接失败", () => {
  const w = atHandoff();
  for (let i = 0; i < 3; i++) reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: " \n", calls: [call("h", "handoff", {})] }));
  assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：toolUse" } });
});

test("handoff 的参数是 null 或字符串：第三次不抛错，只收文字", () => {
  for (const args of [null, "整段说明"] as unknown[]) {
    const w = atHandoff();
    for (let i = 0; i < 3; i++) reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: "说明", calls: [{ type: "toolCall", id: "h", name: "handoff", arguments: args as never }] }));
    assert.equal(w.p.segment.seq, 2);
    assert.ok(first(w).startsWith(`${HANDOFF_HEADER}说明\n\n`), JSON.stringify(first(w).slice(0, 60)));
  }
});

test("没有文字、只有 handoff({summary})：前两次照旧重发（参数只在最后一次算），第三次收下参数", () => {
  const w = atHandoff();
  for (const stopReason of ["stop", "toolUse"] as const) {
    reply(w, assistant({ usage: 31_500, stopReason, calls: [call("h", "handoff", { summary })] }));
    assert.equal(w.p.segment.seq, 1);
  }
  reply(w, assistant({ usage: 31_500, stopReason: "toolUse", calls: [call("h", "handoff", { summary })] }));
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(HANDOFF_HEADER + summary));
});

test("handoff 写成别的写法（Handoff、functions.handoff:0）也算 handoff 调用", () => {
  const w = atHandoff();
  for (const name of ["Handoff", "functions.handoff:0"]) {
    reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("h", name, {})] }));
  }
  reply(w, assistant({ usage: 31_500, stopReason: "toolUse", text: summary, calls: [call("h", "functions.handoff:0", {})] }));
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(HANDOFF_HEADER + summary));
});

test("stop、没有正文、[memory_set, handoff({summary})]：和 toolUse 一样报交接失败，memory_set 不被悄悄丢掉（K2）", () => {
  const w = atHandoff();
  for (let i = 0; i < 3; i++) reply(w, assistant({ usage: 31_500, stopReason: "stop", calls: [call("m", "memory_set", { key: "k", value: "v", brief: "b" }), call("h", "handoff", { summary })] }));
  assert.equal(w.p.segment.seq, 1);
  assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：stop" } });
});

test("stop 带正文又带别的调用：照旧收下正文，调用丢掉（D110 之前就有的行为）", () => {
  const w = atHandoff();
  reply(w, assistant({ usage: 31_500, stopReason: "stop", text: summary, calls: [call("m", "memory_set", { key: "k", value: "v", brief: "b" })] }));
  assert.equal(w.p.segment.seq, 2);
  assert.ok(first(w).startsWith(HANDOFF_HEADER + summary));
});
