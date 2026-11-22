// 审查确认的内核缺陷的最小反例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, effectOf, INTERRUPTED, SKIPPED } from "../../src/kernel/decide.ts";
import { clip, utf8Bytes } from "../../src/kernel/derive.ts";
import { assistant, call, current, env, feed, reply, stopInput, textOf, toolDone, userInput, world } from "./helpers.ts";

test("同一条回复里工具调用 ID 重复（provider 不给 ID 时 pi-ai 填空串）：每个调用都执行、都有结果，然后继续本轮", () => {
  const w = world();
  feed(w, userInput("读两个文件"));
  reply(w, assistant({ usage: 100, calls: [call("", "read", { path: "a" }), call("", "read", { path: "b" })] }));
  const first = effectOf(w.p, current(w));
  assert.equal(first?.kind === "runTool" && first.call.arguments.path, "a");
  toolDone(w, "A");
  const second = effectOf(w.p, current(w));
  assert.equal(second?.kind === "runTool" && second.call.arguments.path, "b");
  toolDone(w, "B");
  assert.equal(w.p.phase.tag, "awaitingModel");
  assert.deepEqual(current(w).filter((m) => m.role === "toolResult").map(textOf), ["A", "B"]);
});

test("工具调用 ID 重复时停止：只有正在等的那个写“被中断”，其余写“未执行”", () => {
  const w = world();
  feed(w, userInput("跑三个"));
  reply(w, assistant({ usage: 100, calls: [call("x"), call("x"), call("x")] }));
  toolDone(w, "1");
  feed(w, stopInput());
  assert.deepEqual(current(w).filter((m) => m.role === "toolResult").map(textOf), ["1", INTERRUPTED, SKIPPED]);
});

test("clip 不按整串拷贝：一亿多字符的结果也能裁剪，字节数在上限内，保留头尾", () => {
  const text = `头${"x".repeat(120_000_000)}尾`;
  const out = clip(text, 1000);
  assert.ok(utf8Bytes(out) <= 1000);
  assert.ok(out.startsWith("头x"));
  assert.ok(out.endsWith("x尾"));
});

test("clip 不拆开代理对，极小上限也不超出", () => {
  const text = "😀".repeat(1000);
  for (const max of [1, 10, 100, 129, 130, 131, 1000]) {
    const out = clip(text, max);
    assert.ok(utf8Bytes(out) <= Math.max(max, utf8Bytes(out.replace(/😀/g, ""))), `max=${max}`);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `max=${max}`);
  }
});

test("排队的信多到十几万封：停止时算跳数不展开参数，不抛 RangeError，回信的跳数是最大值加一", () => {
  const w = world();
  feed(w, userInput("开始"));
  const phase = w.p.phase;
  assert.equal(phase.tag, "awaitingModel");
  if (phase.tag !== "awaitingModel") return;
  const queued = Array.from({ length: 200_000 }, (_, i) => ({ from: { kind: "user" as const }, content: [], hops: i === 7 ? 3 : 0 }));
  const p = { ...w.p, phase: { ...phase, turn: { ...phase.turn, queued, replyTo: ["q"] } } };
  const r = decide(p, current(w), stopInput(), env(0));
  const hops = r.out.map((o) => o.letter.hops);
  assert.deepEqual(hops, [4]);
});
