// 预设的 handoff：换段阈值取 min(算出的阈值, handoff)，只能调低。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedTokens, handoffThreshold, startError } from "../../src/kernel/derive.ts";
import type { World } from "./helpers.ts";
import { assistant, call, current, env, feed, preset, reply, toolDone, userInput, world } from "./helpers.ts";

const W = 200_000;
const COMPUTED = 129_520;

test("阈值取较小的：handoff 比算出的小就用它；一样或更大等于没写", () => {
  assert.equal(handoffThreshold(preset({ contextWindow: W })), COMPUTED);
  assert.equal(handoffThreshold(preset({ contextWindow: W, handoff: 20_000 })), 20_000);
  assert.equal(handoffThreshold(preset({ contextWindow: W, handoff: COMPUTED })), COMPUTED);
  assert.equal(handoffThreshold(preset({ contextWindow: W, handoff: COMPUTED + 1 })), COMPUTED);
  assert.equal(handoffThreshold(preset({ contextWindow: W, handoff: 10_000_000 })), COMPUTED);
  // 小窗口：算出的阈值不大于 0，写 handoff 也救不回来。
  assert.equal(handoffThreshold(preset({ contextWindow: 20_000, handoff: 5_000 })) <= 0, true);
});

test("启动检查用较低的阈值：低到放不下固定部分加记忆的上界就失败，报出的阈值是 handoff", () => {
  const base = preset({ contextWindow: W });
  assert.equal(startError(base), null);
  assert.equal(startError({ ...base, handoff: 100_000 }), null);
  const low = { ...base, handoff: fixedTokens(base) };
  const msg = startError(low) ?? "";
  assert.match(msg, new RegExp(`换段阈值 ${low.handoff} token$`));
  // 记忆的上界也要放得下：有 memory 工具时，刚够固定部分不够。
  const mem = preset({ contextWindow: W, handoff: fixedTokens(base) + 100 });
  assert.match(startError(mem) ?? "", /记忆的上界 [1-9]\d* token/);
  // 恰好放得下：固定部分加记忆的上界加 1。
  const m = /固定部分 (\d+) token，记忆的上界 (\d+) token/.exec(startError(mem) ?? "");
  assert.ok(m);
  assert.equal(startError({ ...mem, handoff: Number(m[1]) + Number(m[2]) + 1 }), null);
  assert.notEqual(startError({ ...mem, handoff: Number(m[1]) + Number(m[2]) }), null);
});

/** 一轮里模型回复用量 `used` 并调用一个工具，工具结果写完以后的世界。 */
function afterTool(pr: ReturnType<typeof preset>, used: number): World {
  const w = world(pr);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: used, calls: [call("c1")] }));
  toolDone(w, "好");
  return w;
}

test("带 handoff 的进程在较低的用量就换段；不带的同样的用量继续", () => {
  const plain = afterTool(preset({ contextWindow: W }), 20_000);
  assert.equal(plain.p.phase.tag, "awaitingModel");
  assert.equal(plain.p.phase.tag === "awaitingModel" && plain.p.phase.purpose, "turn");

  const low = afterTool(preset({ contextWindow: W, handoff: 20_000 }), 20_000);
  assert.equal(low.p.phase.tag === "awaitingModel" && low.p.phase.purpose, "handoff");

  // 工具结果的估算（几个 token）加上去还没到阈值，就不换。
  const under = afterTool(preset({ contextWindow: W, handoff: 20_100 }), 20_000);
  assert.equal(under.p.phase.tag === "awaitingModel" && under.p.phase.purpose, "turn");

  // 换段成功：新段，旧段留在库里的部分不归这里管；这里只看进了第 2 段。
  reply(low, assistant({ usage: 10, text: "交接说明" }));
  assert.equal(low.p.segment.seq, 2);
  assert.equal(current(low).length, 1);
});

test("交接以后的检查也用较低的阈值：handoff 低到放不下固定部分，一份交接说明就报交接失败", () => {
  const base = preset({ contextWindow: W });
  const pr = { ...base, handoff: fixedTokens(base) + 1 };
  assert.equal(startError(pr) === null, false, "这样的预设本来过不了启动检查，这里只测纯函数层");
  const w = world(pr);
  feed(w, userInput("你好"), env(0));
  assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
  reply(w, assistant({ usage: 1, text: "交接说明：目标、进展、下一步。" }));
  assert.equal(w.p.segment.seq, 1);
  const ended = w.p.phase.tag === "idle" ? w.p.phase.ended : undefined;
  assert.ok(typeof ended === "object" && ended.error.startsWith("交接失败：新段一开头就到阈值"), JSON.stringify(ended));
  assert.match(typeof ended === "object" ? ended.error : "", new RegExp(`/ ${pr.handoff} token）$`));
});
