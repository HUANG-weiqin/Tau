// 会话配置（D71）：`reconfigure` 输入在纯函数层的规则。调用参数立即换；结构性字段空闲且没回复过时直接采用，否则存 `next`，换段时采用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, CARRY_HEADER, HANDOFF_HEADER, IMAGE_UNSUPPORTED, toolDescriptions } from "../../src/kernel/context.ts";
import { fork } from "../../src/kernel/decide.ts";
import { estimatedUsed, handoffThreshold, startError } from "../../src/kernel/derive.ts";
import { observe } from "../../src/kernel/observe.ts";
import { pendingFields, sameStructure } from "../../src/kernel/snapshot.ts";
import type { Env, Input, PresetSnapshot, PresetTool, ToolDef } from "../../src/kernel/types.ts";
import { assistant, call, current, env, feed, giveUp, image, letterInput, preset, reply, stopInput, textOf, toolDone, userInput, userLetterWith, withoutBrief, world } from "./helpers.ts";
import type { World } from "./helpers.ts";

const LOW = 1_000;
const P = preset({ contextWindow: 100_000, input: ["text", "image"] });
/** 全部结构性字段都和 P 不同。 */
const NEW: PresetSnapshot = { ...P, model: "faux/other", prompt: "新提示词。", tools: ["read"] as PresetTool[], contextWindow: 64_000, input: ["text"], workdir: "E:/other", context: ["AGENTS.md"] };

const rc = (s: PresetSnapshot): Input => ({ kind: "reconfigure", preset: s });
/** 存储层给 `fresh` 的视图；`memoryView` 是旧快照的，用来确认采用时取的是 `fresh` 的。 */
const withFresh = (memoryView: string, contextView?: string): Env => ({ now: 0, memoryView: "旧记忆", fresh: { memoryView, ...(contextView === undefined ? {} : { contextView }) } });
const purposeOf = (w: World) => (w.p.phase.tag === "awaitingModel" ? w.p.phase.purpose : undefined);
const without = <T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...o };
  for (const k of keys) delete copy[k];
  return copy;
};

const idleFresh = (pr = P): World => world(pr);
/** 一轮正常结束：段里有助手消息，进程空闲。 */
function idleWithReply(pr = P): World {
  const w = world(pr);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: LOW, text: "好的" }));
  assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  return w;
}
const awaitingModel = (): World => {
  const w = world(P);
  feed(w, userInput("你好"));
  return w;
};
const awaitingTool = (): World => {
  const w = world(P);
  feed(w, userInput("你好"));
  reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
  return w;
};

for (const [name, make] of [["idle", idleWithReply], ["awaitingModel", awaitingModel], ["awaitingTool", awaitingTool]] as const) {
  test(`调用参数立即生效：${name}。不写消息，不发回信，不改阶段，不动副作用`, () => {
    const w = make();
    const before = w.p;
    const length = current(w).length;
    const s = { ...P, thinking: "high", handoff: 50_000, options: { temperature: 0.2 } } as PresetSnapshot;
    const step = feed(w, rc(s), withFresh("", ""));
    assert.deepEqual(step.append, []);
    assert.deepEqual(step.out, []);
    assert.deepEqual(step.after, step.before);
    assert.equal(current(w).length, length);
    assert.deepEqual(w.p.preset, s);
    assert.deepEqual({ ...w.p, preset: before.preset }, before, "除了快照，进程记录一点没动：阶段、副作用编号、next、段");
    assert.equal("next" in w.p, false);
  });
}

test("调用参数：S 没有的键，快照里也去掉（用解构去键，不留 undefined）", () => {
  const full = preset({ ...P, thinking: "low", handoff: 5_000, options: { temperature: 1 } });
  const w = idleWithReply(full);
  feed(w, rc(without(full, "thinking", "handoff", "options")), withFresh(""));
  assert.deepEqual(w.p.preset, without(full, "thinking", "handoff", "options"));
  assert.equal("thinking" in w.p.preset || "handoff" in w.p.preset || "options" in w.p.preset, false);
});

test("handoff 立即生效：下一次安全点就按新阈值判断，进程在跑也行", () => {
  const w = awaitingTool();
  feed(w, rc({ ...P, handoff: 500 }), withFresh(""));
  assert.equal(handoffThreshold(w.p.preset), 500);
  assert.equal(w.p.phase.tag, "awaitingTool", "在途的工具调用不受影响");
  toolDone(w, "好");
  assert.equal(purposeOf(w), "handoff", "用量 1000 已经高于新阈值 500");
  // 调高：已存下的 purpose 不重算，下一次调用起才用新阈值。
  const v = awaitingModel();
  feed(v, rc({ ...P, handoff: 500 }), withFresh(""));
  assert.equal(purposeOf(v), "turn");
});

test("调用参数和结构性字段一起改：调用参数立即换，结构性字段存进 next，next 带着同样的调用参数", () => {
  const w = idleWithReply();
  const s = { ...NEW, thinking: "medium" } as PresetSnapshot;
  feed(w, rc(s), withFresh("M", "C"));
  assert.equal(w.p.preset.thinking, "medium");
  assert.deepEqual(w.p.next, s);
  assert.deepEqual(without(w.p.preset, "thinking"), P);
});

// 结构性字段：直接采用

test("空闲、段里没有助手消息：直接采用，段号不变，两个视图取 fresh 的；不写消息，next 没有", () => {
  const w = idleFresh();
  const step = feed(w, rc(NEW), withFresh("新记忆", "### AGENTS.md\n新"));
  assert.deepEqual(w.p.preset, NEW);
  assert.deepEqual(w.p.segment, { seq: 1, memoryView: "新记忆", contextView: "### AGENTS.md\n新" });
  assert.equal("next" in w.p, false);
  assert.deepEqual(step.append, []);
  assert.deepEqual(w.p.phase, { tag: "idle" });
  const sys = buildContext(w.p, []).systemPrompt ?? "";
  assert.ok(sys.startsWith("新提示词。\n\n工作目录：E:/other"));
  assert.ok(sys.indexOf("### AGENTS.md\n新") < sys.indexOf("新记忆"), "上下文在记忆前面");
  assert.deepEqual(buildContext(w.p, []).tools, toolDescriptions(NEW));
});

test("直接采用：视图为空时没有 contextView 这个键；fresh 缺省时记忆视图用 env 的、没有上下文视图", () => {
  const w = idleFresh();
  feed(w, rc(NEW), withFresh("", ""));
  assert.deepEqual(w.p.segment, { seq: 1, memoryView: "" });
  const v = idleFresh();
  feed(v, rc(NEW), { now: 0, memoryView: "env 的" });
  assert.deepEqual(v.p.segment, { seq: 1, memoryView: "env 的" });
});

test("空闲、段里有用户消息但没有助手消息（上一轮被停止）：也直接采用", () => {
  const w = idleFresh();
  feed(w, userInput("你好"));
  feed(w, stopInput());
  assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
  assert.equal(current(w).length, 1);
  feed(w, rc(NEW), withFresh("M", "C"));
  assert.deepEqual(w.p.preset, NEW);
  assert.deepEqual(w.p.segment, { seq: 1, memoryView: "M", contextView: "C" });
  assert.equal("next" in w.p, false);
});

test("段里有图：新模型也收图就直接采用；不收图就存 next（已有的消息不改写，直接采用会让下一次调用带着图失败）", () => {
  const make = (): World => {
    const w = idleFresh();
    feed(w, letterInput(userLetterWith("看图", [image()])));
    feed(w, stopInput());
    assert.equal(current(w).length, 1);
    return w;
  };
  const kept = make();
  feed(kept, rc({ ...NEW, input: ["text", "image"] }), withFresh("M", "C"));
  assert.equal(kept.p.preset.model, "faux/other");
  assert.equal("next" in kept.p, false);

  const held = make();
  feed(held, rc(NEW), withFresh("M", "C"));
  assert.equal("next" in held.p, true, "新模型不收图，存 next");
  assert.deepEqual(held.p.next, NEW);
  assert.equal(held.p.preset.model, P.model);
  assert.deepEqual(held.p.segment, { seq: 1, memoryView: "" });

  // 段里没有图时，新模型不收图也直接采用。
  const text = idleFresh();
  feed(text, rc(NEW), withFresh("M"));
  assert.equal("next" in text.p, false);
});

/** 空闲、段里只有一条用户消息（上一轮被停止），没有助手消息。 */
function idleStopped(pr = P): World {
  const w = world(pr);
  feed(w, userInput("你好"));
  feed(w, stopInput());
  assert.equal(current(w).length, 1);
  return w;
}

test("直接采用要放得下：估算用量（不用锚点）低于新快照的阈值，`>=` 算放不下，和 fork 带 preset 一样", () => {
  const view = withFresh("M", "C");
  const used = estimatedUsed({ ...idleStopped().p, preset: NEW, segment: { seq: 1, memoryView: "M", contextView: "C" } }, current(idleStopped()));
  // 阈值恰好等于用量：放不下，存 next；fork 带 preset 同样拒绝。
  const full = { ...NEW, handoff: used };
  const held = idleStopped();
  feed(held, rc(full), view);
  assert.deepEqual(held.p.next, full);
  assert.equal(held.p.preset.model, P.model, "当前快照没换");
  assert.deepEqual(held.p.segment, { seq: 1, memoryView: "" });
  assert.deepEqual(held.p.phase, { tag: "idle", ended: "stopped" });
  assert.throws(() => fork("c", held.p, current(held), undefined, 99, { preset: full, memoryView: "M", contextView: "C" }), /放不进预设/);
  // 阈值比用量大 1：放得下，直接采用；fork 带 preset 也放行。
  const room = { ...NEW, handoff: used + 1 };
  const taken = idleStopped();
  feed(taken, rc(room), view);
  assert.deepEqual(taken.p.preset, room);
  assert.equal("next" in taken.p, false);
  assert.deepEqual(taken.p.segment, { seq: 1, memoryView: "M", contextView: "C" });
  assert.doesNotThrow(() => fork("c", taken.p, current(taken), undefined, 99, { preset: room, memoryView: "M", contextView: "C" }));
});

test("窗口换小、段里的消息放不进：不直接采用，存 next；当前快照照常用，下一封信在旧快照上处理", () => {
  // 四条各约 32 KB 的用户消息，每一轮都出错：段里没有助手消息，空闲。
  const big = "字".repeat(11_000);
  const wide = preset({ contextWindow: 200_000, tools: ["read"] });
  const w = idleFresh(wide);
  for (let i = 0; i < 4; i++) {
    feed(w, userInput(big));
    giveUp(w, assistant({ usage: 0, stopReason: "error", errorMessage: "provider down" }));
  }
  assert.equal(current(w).filter((m) => m.role === "assistant").length, 0);
  const small = { ...wide, model: "faux/small", contextWindow: 40_000 };
  assert.equal(startError(small), null, "启动检查放行：它只看固定部分");
  assert.ok(estimatedUsed({ ...w.p, preset: small }, current(w)) >= handoffThreshold(small), "段放不进新窗口");
  const step = feed(w, rc(small), withFresh("", ""));
  assert.deepEqual(w.p.next, small);
  assert.equal(w.p.preset.contextWindow, 200_000, "当前快照没换");
  assert.deepEqual(step.append, []);
  assert.deepEqual(step.out, []);
  feed(w, userInput("再试一次"));
  assert.equal(purposeOf(w), "turn", "用量没到旧阈值，在旧快照上正常调用");
  // 对照：同样的窗口，段里只有一条短消息，放得下，直接采用。
  const light = idleStopped(wide);
  feed(light, rc(small), withFresh("", ""));
  assert.equal(light.p.preset.contextWindow, 40_000);
  assert.equal("next" in light.p, false);
});

// 结构性字段：存 next

test("段里有助手消息：存 next，当前快照的结构性字段和段都不变", () => {
  const w = idleWithReply();
  const before = w.p;
  feed(w, rc(NEW), withFresh("M", "C"));
  assert.deepEqual(w.p.next, NEW);
  assert.deepEqual({ ...w.p, next: undefined }, { ...before, next: undefined });
  assert.deepEqual(w.p.segment, before.segment);
});

for (const [name, make] of [["awaitingModel", awaitingModel], ["awaitingTool", awaitingTool]] as const) {
  test(`${name}：结构性字段存 next，在途的调用不受影响`, () => {
    const w = make();
    const before = w.p;
    const step = feed(w, rc(NEW), withFresh("M", "C"));
    assert.deepEqual(w.p.next, NEW);
    assert.deepEqual(w.p.preset, P);
    assert.deepEqual(w.p.phase, before.phase);
    assert.equal(w.p.lastEffect, before.lastEffect);
    assert.deepEqual(step.after, step.before);
    assert.deepEqual(buildContext(w.p, current(w)).tools, toolDescriptions(P), "在途的请求仍用旧的工具清单");
  });
}

test("next 被再次 reconfigure 替换：后到的赢", () => {
  const w = idleWithReply();
  feed(w, rc(NEW), withFresh("M"));
  const second = { ...NEW, prompt: "第二版。" };
  feed(w, rc(second), withFresh("M"));
  assert.deepEqual(w.p.next, second);
});

test("换回和当前结构性字段一样的快照：取消 next，调用参数照换", () => {
  const w = idleWithReply();
  feed(w, rc(NEW), withFresh("M"));
  assert.ok(w.p.next);
  feed(w, rc({ ...P, thinking: "low" }), withFresh("M"));
  assert.equal("next" in w.p, false);
  assert.deepEqual(w.p.preset, { ...P, thinking: "low" });
  // 没有 next 时，一样的快照什么都不改。
  const before = w.p;
  const step = feed(w, rc(w.p.preset), withFresh("M"));
  assert.deepEqual(w.p, before);
  assert.deepEqual(step.append, []);
});

test("键的顺序不同不算不同：稳定序列化比较，toolDefs 里的参数也一样", () => {
  const def: ToolDef = { name: "t", description: "d", parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } }, command: "x", timeout: 60, output: "text" };
  const base = preset({ ...P, toolDefs: [def] });
  const w = idleWithReply(base);
  const reordered: ToolDef = { ...def, parameters: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" } };
  feed(w, rc({ ...base, toolDefs: [reordered] }), withFresh("M"));
  assert.equal("next" in w.p, false, "只是键的顺序不同");
  feed(w, rc({ ...base, toolDefs: [{ ...def, command: "y" }] }), withFresh("M"));
  assert.ok(w.p.next, "命令不同就是不同");
});

// 换段时采用

/** 空闲、有助手消息、有 next（NEW）。 */
function pendingWorld(next: PresetSnapshot = NEW): World {
  const w = idleWithReply();
  feed(w, rc(next), withFresh("新记忆", "### AGENTS.md\n新"));
  assert.deepEqual(w.p.next, next);
  return w;
}
/** 带换段标记的信：写进段时下一次调用的用途是 handoff。 */
const marked = (text: string) => letterInput({ ...userLetterWith(text), handoff: true });

test("换段采用 next：快照、阈值、记忆视图、上下文视图、系统提示词、工具描述都是新的，next 去掉；交接请求本身仍用旧的", () => {
  const w = pendingWorld();
  feed(w, marked("换段后处理这个"));
  assert.equal(purposeOf(w), "handoff");
  const ask = buildContext(w.p, current(w));
  assert.ok(ask.systemPrompt?.startsWith("你是测试用的助手。"), "交接请求仍用旧快照的系统提示词");
  assert.deepEqual(ask.tools, toolDescriptions(P));
  reply(w, assistant({ usage: LOW, text: "交接说明" }), withFresh("新记忆", "### AGENTS.md\n新"));
  assert.equal(w.p.segment.seq, 2);
  assert.deepEqual(w.p.preset, NEW);
  assert.equal("next" in w.p, false);
  assert.deepEqual(w.p.segment, { seq: 2, memoryView: "新记忆", contextView: "### AGENTS.md\n新" });
  assert.equal(handoffThreshold(w.p.preset), handoffThreshold(NEW));
  const req = buildContext(w.p, current(w));
  assert.ok(req.systemPrompt?.startsWith("新提示词。\n\n工作目录：E:/other"));
  assert.ok(req.systemPrompt?.includes("### AGENTS.md\n新") && req.systemPrompt.includes("新记忆"));
  assert.deepEqual(req.tools, toolDescriptions(NEW));
  assert.ok(textOf(current(w)[0]!).includes("换段后处理这个"), "带过去的信照常带过去");
  assert.equal(purposeOf(w), "turn");
});

test("换段采用 next：新阈值生效。next 的窗口小，旧快照下不到阈值的用量，在新段里已经到了", () => {
  const small = { ...NEW, contextWindow: 40_000 };
  const w = pendingWorld(small);
  assert.equal(handoffThreshold(w.p.preset), handoffThreshold(P), "换段之前仍是旧阈值");
  feed(w, marked("换"));
  reply(w, assistant({ usage: LOW, text: "交接说明" }), withFresh("M", "C"));
  assert.equal(handoffThreshold(w.p.preset), handoffThreshold(small));
  assert.ok(handoffThreshold(small) < 10_000 && 10_000 < handoffThreshold(P));
  reply(w, assistant({ usage: 5_000, calls: [call("c1")] }));
  toolDone(w, "好");
  assert.equal(purposeOf(w), "turn", "用量没到新阈值");
  reply(w, assistant({ usage: 10_000, calls: [call("c2")] }));
  toolDone(w, "好");
  assert.equal(purposeOf(w), "handoff", "到了新阈值，旧阈值下还没到");
});

test("没有 next 的换段：快照不变，记忆视图用 env 的，上下文视图每次换段重取（取 fresh 的）；fresh 缺省时没有这个键", () => {
  const w = idleWithReply();
  feed(w, marked("换"));
  reply(w, assistant({ usage: LOW, text: "说明" }), { now: 0, memoryView: "M", fresh: { memoryView: "不用它", contextView: "C" } });
  assert.deepEqual(w.p.preset, P);
  assert.deepEqual(w.p.segment, { seq: 2, memoryView: "M", contextView: "C" });
  const v = idleWithReply();
  feed(v, marked("换"));
  reply(v, assistant({ usage: LOW, text: "说明" }), env(0, "M"));
  assert.deepEqual(v.p.segment, { seq: 2, memoryView: "M" });
  const u = idleWithReply();
  feed(u, marked("换"));
  reply(u, assistant({ usage: LOW, text: "说明" }), { now: 0, memoryView: "M", fresh: { memoryView: "M", contextView: "" } });
  assert.deepEqual(u.p.segment, { seq: 2, memoryView: "M" }, "空视图不写键");
});

test("交接后检查在 next 上失败：丢掉 next，进程用旧快照继续，不会每封信都交接失败", () => {
  // 窗口小得固定部分就放不下新段：启动检查在服务里查过，所以这里是交接后检查的情形。
  const tight = { ...NEW, contextWindow: 28_000 };
  const w = pendingWorld(tight);
  const old = w.p.preset;
  feed(w, marked("换"));
  reply(w, assistant({ usage: LOW, text: "交接说明" }), withFresh("M", "C"));
  const ended = w.p.phase.tag === "idle" ? w.p.phase.ended : undefined;
  assert.ok(typeof ended === "object" && ended.error.startsWith("交接失败：新段一开头就到阈值（固定部分 "), JSON.stringify(ended));
  assert.ok(typeof ended === "object" && ended.error.includes("共 ") && ended.error.endsWith("；待换的配置已丢弃"), JSON.stringify(ended));
  assert.ok(typeof ended === "object" && ended.error.includes("上下文 "), "next 有 context，原因里多一项上下文");
  assert.equal("next" in w.p, false);
  assert.deepEqual(w.p.preset, old, "旧快照不变");
  assert.equal(w.p.segment.seq, 1, "没有换段");
  // 不死循环：下一封信照常在旧快照上处理，用途是 turn。
  feed(w, userInput("再来一封"));
  assert.equal(purposeOf(w), "turn");
  reply(w, assistant({ usage: LOW, text: "好" }));
  assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  // 再换一次段：没有 next 了，在旧快照上成功。
  feed(w, marked("再换"));
  reply(w, assistant({ usage: LOW, text: "说明" }), withFresh("M"));
  assert.equal(w.p.segment.seq, 2);
  assert.deepEqual(w.p.preset, old);
});

test("别的原因的交接失败不丢 next：模型出错、空说明、带工具调用", () => {
  const cases = [
    assistant({ usage: LOW, stopReason: "error", errorMessage: "炸了" }),
    assistant({ usage: LOW, text: "  \n" }),
    assistant({ usage: LOW, stopReason: "toolUse", text: "先查一下", calls: [call("c1")] }),
  ];
  for (const m of cases) {
    const w = pendingWorld();
    feed(w, marked("换"));
    giveUp(w, m, withFresh("新记忆", "C"));
    const ended = w.p.phase.tag === "idle" ? w.p.phase.ended : undefined;
    assert.ok(typeof ended === "object" && ended.error.startsWith("交接失败："), JSON.stringify(ended));
    assert.ok(!(typeof ended === "object" && ended.error.includes("待换的配置已丢弃")));
    assert.deepEqual(w.p.next, NEW, "next 还在，下一次换段再试");
    assert.equal(w.p.segment.seq, 1);
  }
});

test("没有声明 context、没有待换配置的交接失败，原因的文字和以前一字不变", () => {
  const w = world(preset({ contextWindow: 28_000 }));
  feed(w, userInput("你好"));
  assert.equal(purposeOf(w), "handoff", "固定部分就到阈值了");
  reply(w, assistant({ usage: 5, text: "交接说明" }), { now: 0, memoryView: "", fresh: { memoryView: "", contextView: "" } });
  const ended = w.p.phase.tag === "idle" ? w.p.phase.ended : undefined;
  assert.match(typeof ended === "object" ? ended.error : "", /^交接失败：新段一开头就到阈值（固定部分 \d+、记忆 0、交接说明 \d+，共 \d+ \/ \d+ token）$/);
});

test("采用 next 时新模型不收图片：带过去的用户消息里的图，在原位置换成说明", () => {
  const w = pendingWorld();
  feed(w, letterInput({ ...userLetterWith("看这张图", [image("x")]), handoff: true }));
  reply(w, assistant({ usage: LOW, text: "交接说明" }), withFresh("M", "C"));
  assert.deepEqual(w.p.preset, NEW);
  const first = withoutBrief(current(w)[0]!);
  assert.equal(first.role, "user");
  assert.equal(first.role === "user" && first.content, `${HANDOFF_HEADER}交接说明\n\n${CARRY_HEADER}\n\n看这张图\n${IMAGE_UNSUPPORTED}`);
  // 对照：新模型收图片，图原样带过去。
  const keep = pendingWorld({ ...NEW, input: ["text", "image"] });
  feed(keep, letterInput({ ...userLetterWith("看这张图", [image("x")]), handoff: true }));
  reply(keep, assistant({ usage: LOW, text: "交接说明" }), withFresh("M", "C"));
  const kept = current(keep)[0]!;
  assert.ok(kept.role === "user" && typeof kept.content !== "string" && kept.content.some((c) => c.type === "image"));
  // 没有 next 时，图也原样带过去（行为不变）。
  const plain = idleWithReply(preset({ ...P, input: ["text"] }));
  feed(plain, letterInput({ ...userLetterWith("看这张图", [image("x")]), handoff: true }));
  reply(plain, assistant({ usage: LOW, text: "交接说明" }), withFresh("M"));
  const same = current(plain)[0]!;
  assert.ok(same.role === "user" && typeof same.content !== "string" && same.content.some((c) => c.type === "image"));
});

test("换段采用 next 时，运行中排队的信照常在新段里处理，信的头没变", () => {
  const w = pendingWorld();
  feed(w, marked("换"));
  feed(w, userInput("交接调用进行中到的信"));
  reply(w, assistant({ usage: LOW, text: "交接说明" }), withFresh("M"));
  assert.deepEqual(w.p.preset, NEW);
  assert.equal(w.p.phase.tag, "awaitingModel");
  assert.equal(purposeOf(w), "turn");
});

// fork、投影

test("fork 不带 next：只复制源的当前快照，新进程没有这个键", () => {
  const w = pendingWorld();
  const r = fork("c", w.p, current(w), undefined, 99);
  assert.equal("next" in r.process, false);
  assert.deepEqual(r.process.preset, P, "是当前快照，不是待换的");
  const cut = fork("c", w.p, current(w), 0, 99);
  assert.equal("next" in cut.process, false);
  // 带 preset 也一样。
  const to = fork("c", w.p, current(w), undefined, 99, { preset: NEW, memoryView: "m", contextView: "c" });
  assert.equal("next" in to.process, false);
});

test("self.pending：next 和当前快照结构性字段里不一样的键名，按固定顺序；没有 next 就没有这个键", () => {
  const w = idleWithReply();
  assert.equal("pending" in observe(w.p, current(w), [], 5).self, false);
  feed(w, rc(NEW), withFresh("M"));
  assert.deepEqual(observe(w.p, current(w), [], 5).self.pending, { fields: ["model", "prompt", "tools", "workdir", "context"] });
  assert.deepEqual(observe(w.p, current(w), [w.p], 5).self, observe(w.p, current(w), [], 5).self);
  // 只改了调用参数：没有 next。
  const v = idleWithReply();
  feed(v, rc({ ...P, thinking: "high" }), withFresh("M"));
  assert.equal("pending" in observe(v.p, current(v), [], 5).self, false);
});

test("pending.fields：toolDefs 的内容变了算 tools；contextWindow、input 变了算 model；调用参数不算", () => {
  const def: ToolDef = { name: "t", description: "d", parameters: { type: "object" }, command: "x", timeout: 60, output: "text" };
  const base = preset({ ...P, toolDefs: [def] });
  assert.deepEqual(pendingFields(base, { ...base, toolDefs: [{ ...def, description: "新说明" }] }), ["tools"]);
  assert.deepEqual(pendingFields(base, { ...base, contextWindow: 1 }), ["model"]);
  assert.deepEqual(pendingFields(base, { ...base, input: ["text"] }), ["model"]);
  assert.deepEqual(pendingFields(base, { ...base, model: "faux/x", contextWindow: 1, input: ["text"] }), ["model"]);
  assert.deepEqual(pendingFields(base, { ...base, context: ["a"] }), ["context"]);
  assert.deepEqual(pendingFields(base, { ...base, context: [] }), ["context"]);
  assert.deepEqual(pendingFields(base, { ...base, thinking: "high", handoff: 5, options: { temperature: 1 } }), []);
  assert.deepEqual(pendingFields(base, { ...base }), []);
  assert.deepEqual(pendingFields(base, { ...base, workdir: "E:/x", prompt: "p" }), ["prompt", "workdir"]);
});

// 嵌套很深的工具定义参数：工具定义只受 16 KB 限制，`parameters` 能嵌套几千层。纯函数不能因为深度抛错，否则这条输入留在信箱队头，进程和重启都卡住。

const nested = (depth: number, leaf: unknown): unknown => {
  let o = leaf;
  for (let i = 0; i < depth; i++) o = { a: o };
  return o;
};
const deepDef = (depth: number, leaf: unknown): ToolDef => ({ name: "t", description: "d", parameters: { type: "object", properties: nested(depth, leaf) } as ToolDef["parameters"], command: "x", timeout: 60, output: "text" });

test("pendingFields、sameStructure 不递归：嵌套 5000 层的快照不爆栈，结果对", () => {
  const base = preset({ toolDefs: [deepDef(5000, "x")] });
  const copy = preset({ toolDefs: [deepDef(5000, "x")] });
  const other = preset({ toolDefs: [deepDef(5000, "y")] });
  assert.deepEqual(pendingFields(base, copy), []);
  assert.equal(sameStructure(base, copy), true);
  assert.deepEqual(pendingFields(base, other), ["tools"], "最深处的差别也看得见");
  assert.equal(sameStructure(base, other), false);
  assert.deepEqual(pendingFields(base, { ...other, prompt: "p" }), ["prompt", "tools"]);
  assert.deepEqual(pendingFields(base, { ...copy, thinking: "high" }), []);
  // 最深处的键顺序不同不算不同；少一个键算不同。
  const ab = preset({ toolDefs: [deepDef(5000, { a: 1, b: 2 })] });
  assert.equal(sameStructure(ab, preset({ toolDefs: [deepDef(5000, { b: 2, a: 1 })] })), true);
  assert.equal(sameStructure(ab, preset({ toolDefs: [deepDef(5000, { a: 1 })] })), false);
  assert.equal(sameStructure(ab, preset({ toolDefs: [deepDef(5000, { a: 1, b: undefined })] })), false, "undefined 的键被跳过，所以少了 b");
  assert.equal(sameStructure(preset({ toolDefs: [deepDef(5000, { a: 1 })] }), preset({ toolDefs: [deepDef(5000, { a: 1, b: undefined })] })), true);
});

test("reconfigure 经 decide：嵌套 2200 层的工具定义，只改调用参数、改结构性字段都不抛", () => {
  const base = preset({ toolDefs: [deepDef(2200, "x")] });
  const w = idleWithReply(base);
  feed(w, rc({ ...base, thinking: "low" }), withFresh("M"));
  assert.equal(w.p.preset.thinking, "low");
  assert.equal("next" in w.p, false);
  feed(w, rc({ ...base, thinking: "low", toolDefs: [deepDef(2200, "y")] }), withFresh("M"));
  assert.ok(w.p.next);
  assert.deepEqual(observe(w.p, current(w), [], 5).self.pending, { fields: ["tools"] });
  feed(w, rc({ ...base, thinking: "high" }), withFresh("M"));
  assert.equal("next" in w.p, false, "换回去就取消");
  assert.equal(w.p.preset.thinking, "high");
});
