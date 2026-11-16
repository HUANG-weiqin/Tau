// fork 带预设（换角色）：快照和记忆视图用新的，图片按新模型处理，用不带锚点的估算对新阈值。
import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_UNSUPPORTED } from "../../src/kernel/context.ts";
import { fork } from "../../src/kernel/decide.ts";
import { contextUsed, estimatedUsed, handoffThreshold } from "../../src/kernel/derive.ts";
import type { Message, PresetSnapshot, Process, UserMessage } from "../../src/kernel/types.ts";
import { assertInvariants } from "../invariants.ts";
import { assistant, current, deepFreeze, env, feed, image, preset, reply, userInput, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const OLD = preset({ id: "old", contextWindow: 200_000, input: ["text", "image"], prompt: "旧角色。" });
const NEW = preset({ id: "new", contextWindow: 100_000, input: ["text"], prompt: "新角色。", tools: ["read"] });
const to = (p: PresetSnapshot = NEW, memoryView = "新记忆") => ({ preset: p, memoryView });

function twoTurns(): World {
  const w = world(OLD, env(5, "旧记忆"));
  for (const n of [1, 2]) {
    feed(w, userInput(`问${n}`), env(10 + n));
    reply(w, assistant({ usage: 500, text: `答${n}` }));
  }
  return w;
}

test("带预设：快照和记忆视图是新的，其余和不带预设一样；源进程不变", () => {
  const w = twoTurns();
  const src = deepFreeze(w.p);
  const seg = current(w);
  const plain = fork("f", src, seg, undefined, 99);
  const r = fork("f", src, seg, undefined, 99, to());
  assert.equal(r.process.preset, NEW);
  assert.equal(r.process.segment.memoryView, "新记忆");
  assert.deepEqual({ ...r.process, preset: plain.process.preset, segment: plain.process.segment }, plain.process);
  assert.deepEqual(r.messages, seg);
  assert.deepEqual(r.process.phase, { tag: "idle", ended: "done" });
  assertInvariants(r.process, r.messages);
  assert.equal(src.preset, OLD);
  assert.equal(src.segment.memoryView, "旧记忆");
  // 带 before：照 before 的规则取。
  const cut = fork("f", src, seg, 2, 99, to());
  assert.deepEqual(cut.messages, seg.slice(0, 2));
  assert.deepEqual(cut.process.phase, { tag: "idle" });
  assertInvariants(cut.process, cut.messages);
});

const user = (content: UserMessage["content"]): Message => ({ role: "user", content, timestamp: 1 });
const result = (content: (ReturnType<typeof image> | { type: "text"; text: string })[]): Message => ({ role: "toolResult", toolCallId: "c1", toolName: "read", content, isError: false, timestamp: 2 });

test("新模型不收图片：每张图在原位置换成说明，和文字用换行连起来；用户消息成字符串，工具结果成一个文本块", () => {
  const w = world(OLD, env(0, "旧"));
  const seg: Message[] = [
    user([{ type: "text", text: "看" }, image("a"), image("b")]),
    assistant({ usage: 0, calls: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] }),
    result([{ type: "text", text: "前" }, image("c"), { type: "text", text: "后" }]),
    assistant({ usage: 0, text: "好" }),
    user([image("d")]),
    assistant({ usage: 0, text: "嗯" }),
    user("纯文字"),
  ];
  const r = fork("f", w.p, seg, undefined, 0, to());
  assert.deepEqual(r.messages[0], user(`看\n${IMAGE_UNSUPPORTED}\n${IMAGE_UNSUPPORTED}`));
  assert.deepEqual(r.messages[2], result([{ type: "text", text: `前\n${IMAGE_UNSUPPORTED}\n后` }]));
  assert.deepEqual(r.messages[4], user(IMAGE_UNSUPPORTED));
  for (const i of [1, 3, 5, 6]) assert.equal(r.messages[i], seg[i], "没有图片的消息原样");
  assert.doesNotMatch(JSON.stringify(r.messages), /"type":"image"/);
  assert.equal(seg[0]!.role === "user" && JSON.stringify(seg[0]).includes('"image"'), true, "源的消息不改");
  assertInvariants(r.process, r.messages);
  // 新模型收图片：原样。
  const keep = fork("f", w.p, seg, undefined, 0, to({ ...NEW, input: ["text", "image"] }));
  assert.deepEqual(keep.messages, seg);
});

/** 一个 idle 进程和一段大文本：用量锚点很小，估算很大。 */
function anchored(): { p: Process; seg: Message[] } {
  const w = world(OLD);
  const seg: Message[] = [user("字".repeat(30_000)), assistant({ usage: 100, text: "好" })];
  return { p: w.p, seg };
}

test("估算要低于新预设的换段阈值：刚好低于能建，等于或超过被拒；报出估算和阈值", () => {
  const { p, seg } = anchored();
  const probe = fork("f", p, seg, undefined, 0, to(NEW)).process;
  const used = estimatedUsed(probe, seg);
  assert.ok(used < handoffThreshold(NEW), "不带 handoff 时能建");
  const ok = to({ ...NEW, handoff: used + 1 });
  assert.equal(handoffThreshold(ok.preset), used + 1);
  assert.doesNotThrow(() => fork("f", p, seg, undefined, 0, ok));
  const tight = to({ ...NEW, handoff: used });
  assert.throws(() => fork("f", p, seg, undefined, 0, tight), new RegExp(`估算 ${used} token，换段阈值 ${used} token`));
  // 窗口小：阈值本身就低。
  const small = { ...NEW, contextWindow: 30_000 };
  assert.ok(used >= handoffThreshold(small));
  assert.throws(() => fork("f", p, seg, undefined, 0, to(small)), /放不进预设 new/);
});

test("反例：用 contextUsed 的锚点会放行，估算会拒绝", () => {
  const { p, seg } = anchored();
  const target = to({ ...NEW, handoff: 20_000 });
  const probe: Process = { ...p, preset: target.preset, segment: { seq: 1, memoryView: target.memoryView } };
  assert.ok(contextUsed(probe, seg) < 20_000, "锚点是旧用量，看起来很小");
  assert.ok(estimatedUsed(probe, seg) >= 20_000);
  assert.throws(() => fork("f", p, seg, undefined, 0, target), /放不进/);
  // 不带预设：和以前一样，不检查。
  assert.doesNotThrow(() => fork("f", p, seg, undefined, 0));
});

test("估算按新进程算：新预设的系统提示词和工具描述也计入，图片换成说明之后按文字算", () => {
  const w = world(OLD);
  const seg: Message[] = [user([{ type: "text", text: "x" }, image("a"), image("b"), image("c")])];
  const withImages = fork("f", w.p, seg, undefined, 0, to({ ...NEW, input: ["text", "image"] })).process;
  const asText = fork("f", w.p, seg, undefined, 0, to()).process;
  const a = estimatedUsed(withImages, seg);
  const b = estimatedUsed(asText, fork("f", w.p, seg, undefined, 0, to()).messages);
  assert.ok(a - b > 10_000, "三张图是 15000 token，换成说明以后几乎没有");
});
