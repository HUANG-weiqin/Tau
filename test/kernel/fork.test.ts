// fork（纯函数部分）：复制范围、拒绝、新进程记录的每个字段。每个新进程都检查 assertInvariants。
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectOf, fork } from "../../src/kernel/decide.ts";
import type { Message, Process } from "../../src/kernel/types.ts";
import { assertInvariants } from "../invariants.ts";
import { assistant, call, current, deepFreeze, env, feed, image, modelInterrupted, preset, reply, stopInput, textOf, toolDone, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const P = preset({ contextWindow: 100_000, thinking: "low", input: ["text", "image"] });

/** 三轮的 idle 进程：段里是 u1 a1 u2 a2 u3 a3，用量不是 0，记忆视图有内容。 */
function threeTurns(): World {
  const w = world(P, env(5, "记忆：甲"));
  for (const n of [1, 2, 3]) {
    feed(w, userInput(`问${n}`), env(10 + n));
    reply(w, assistant({ usage: { ...assistant({ usage: 0 }).usage, input: 100, output: 7, cacheRead: 3, cacheWrite: 1, totalTokens: 111 }, text: `答${n}` }));
  }
  return w;
}

const forked = (w: World, before: number | undefined, id = "f1", now = 99) => fork(id, deepFreeze(w.p), current(w), before, now);
const asWorld = (r: ReturnType<typeof fork>): World => ({ p: r.process, segments: new Map([[1, r.messages]]) });

test("带 before：新进程的第 1 段是前面的全部消息，原样复制；阶段是不带结束原因的 idle", () => {
  const w = threeTurns();
  const seg = current(w);
  assert.equal(seg.length, 6);
  for (const before of [0, 2, 4]) {
    const r = forked(w, before);
    assert.deepEqual(r.messages, seg.slice(0, before));
    assert.deepEqual(r.process.phase, { tag: "idle" });
    assertInvariants(r.process, r.messages);
  }
});

test("不带 before：复制当前段的全部消息，阶段复制源进程的 idle（含结束原因）", () => {
  const w = threeTurns();
  const r = forked(w, undefined);
  assert.deepEqual(r.messages, current(w));
  assert.deepEqual(r.process.phase, { tag: "idle", ended: "done" });
  assertInvariants(r.process, r.messages);
  for (const ended of ["stepLimit", "stopped", { error: "炸了" }] as const) {
    const p: Process = { ...w.p, phase: { tag: "idle", ended } };
    assert.deepEqual(fork("f", p, current(w), undefined, 0).process.phase, { tag: "idle", ended });
  }
  // 还没跑过一轮的 idle：空段，没有结束原因。
  const fresh = world(P);
  const e = forked(fresh, undefined);
  assert.deepEqual(e.messages, []);
  assert.deepEqual(e.process.phase, { tag: "idle" });
});

test("新进程记录的每个字段", () => {
  const w = threeTurns();
  const p = fork("new", { ...w.p, parent: "boss" }, current(w), 2, 777).process;
  assert.deepEqual(p, {
    id: "new",
    preset: w.p.preset,
    createdAt: 777,
    segment: { seq: 1, memoryView: "记忆：甲" },
    lastEffect: 0,
    phase: { tag: "idle" },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal("parent" in p, false);
  assert.ok(w.p.usage.input > 0 && w.p.lastEffect === 3, "源进程有用量和编号，新进程都不继承");
});

test("源进程换过段：只复制当前段，新进程是第 1 段，不带旧段", () => {
  const w = threeTurns();
  const moved: Process = { ...w.p, segment: { seq: 3, memoryView: "新视图" }, lastEffect: 9 };
  const cur: Message[] = [{ role: "user", content: "交接", timestamp: 1 }, { role: "user", content: "接着", timestamp: 2 }];
  const r = fork("f", moved, cur, 1, 0);
  assert.equal(r.process.segment.seq, 1);
  assert.equal(r.process.segment.memoryView, "新视图");
  assert.deepEqual(r.messages, [cur[0]]);
});

test("拒绝：before 超出范围、不是用户消息、运行中不带 before；不改源进程", () => {
  const w = threeTurns();
  assert.throws(() => forked(w, 6), /没有第 6 条/);
  assert.throws(() => forked(w, 100), /没有第 100 条/);
  assert.throws(() => forked(w, 1), /第 1 条是 assistant，不是用户消息/);
  assert.throws(() => forked(w, 5), /不是用户消息/);
  const empty = world(P);
  assert.throws(() => forked(empty, 0), /没有第 0 条/);
  feed(w, userInput("再来"));
  assert.equal(w.p.phase.tag, "awaitingModel");
  assert.throws(() => forked(w, undefined), /正在运行/);
  reply(w, assistant({ usage: 10, calls: [call("c1")] }));
  assert.equal(w.p.phase.tag, "awaitingTool");
  assert.throws(() => forked(w, undefined), /正在运行/);
  // 带 before 时，运行中也可以：前缀都在完整的地方。
  assert.doesNotThrow(() => forked(w, 4));
});

test("反例：在安全点并入的信之前切，前缀以工具结果结尾，新进程能正常开下一轮", () => {
  const w = world(P);
  feed(w, userInput("读一下"));
  reply(w, assistant({ usage: 100, calls: [call("c1"), call("c2")] }));
  feed(w, userInput("插话"));
  toolDone(w, "一");
  toolDone(w, "二");
  const seg = current(w);
  assert.deepEqual(seg.map((m) => m.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
  assert.equal(textOf(seg[4]!), "插话");
  // 源进程此刻在运行（等模型）。
  const r = forked(w, 4);
  assert.equal(r.messages.at(-1)?.role, "toolResult");
  const f = asWorld(r);
  assertInvariants(f.p, f.segments.get(1)!);
  feed(f, userInput("接着"), env(1));
  assert.equal(f.p.phase.tag, "awaitingModel");
  assert.deepEqual(effectOf(f.p, current(f)), { kind: "callModel", n: 1, purpose: "turn" });
  assert.deepEqual(current(f).map((m) => m.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
  assert.equal(textOf(current(f).at(-1)!), "接着");
});

test("新进程从 idle 继续：带 before 的下一封信前面没有“上一轮的说明”，不带 before 的有", () => {
  const w = threeTurns();
  const a = asWorld(forked(w, 4));
  feed(a, userInput("新问"), env(1));
  assert.equal(textOf(current(a)[4]!), "新问");
  const stopped: Process = { ...w.p, phase: { tag: "idle", ended: "stopped" } };
  const b = asWorld(fork("f", stopped, current(w), undefined, 0));
  feed(b, userInput("新问"), env(1));
  assert.match(textOf(current(b)[6]!), /^.+\n\n新问$/s, "和源进程的下一封信一样，带结束原因的说明");
  const sourceNext: World = { p: stopped, segments: new Map([[1, current(w)]]) };
  feed(sourceNext, userInput("新问"), env(1));
  assert.equal(textOf(current(b)[6]!), textOf(current(sourceNext)[6]!));
});

test("复制的图片引用原样保留；源进程的记录和消息不变", () => {
  const w = world(P);
  const img = { ...image("blob:" + "a".repeat(64)) };
  feed(w, { kind: "letter", letter: { from: { kind: "user" }, content: [{ type: "text", text: "看" }, img], hops: 0 } });
  reply(w, assistant({ usage: 10, text: "看到了" }));
  feed(w, userInput("下一个"));
  reply(w, assistant({ usage: 10, text: "好" }));
  const before = JSON.stringify([w.p, current(w)]);
  const r = forked(w, 2);
  assert.deepEqual(r.messages, current(w).slice(0, 2));
  assert.deepEqual((r.messages[0] as { content: unknown[] }).content[1], img);
  assert.equal(JSON.stringify([w.p, current(w)]), before);
});

test("源进程停止、中断后的段也能 fork（工具结果已补完）", () => {
  const w = world(P);
  feed(w, userInput("读"));
  reply(w, assistant({ usage: 10, calls: [call("c1")] }));
  feed(w, stopInput());
  assert.equal(w.p.phase.tag, "idle");
  const r = forked(w, undefined);
  assertInvariants(r.process, r.messages);
  const w2 = world(P);
  feed(w2, userInput("问"));
  feed(w2, modelInterrupted(1));
  const r2 = forked(w2, undefined);
  assert.deepEqual(r2.process.phase, w2.p.phase);
  assertInvariants(r2.process, r2.messages);
});
