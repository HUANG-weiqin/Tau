// 设计稿第 5 节的每一行流程，以及第 4.2 节的丢弃规则、第 4.3 节的 start。
// 每次 feed 之后都会检查 assertInvariants。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { StopReason } from "@earendil-works/pi-ai";
import { buildContext, CARRY_HEADER, HANDOFF_HEADER, HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { effectOf, start } from "../../src/kernel/decide.ts";
import { BYTES_PER_TOKEN, clip, contextUsed, handoffThreshold, MESSAGE_MAX_BYTES, pendingCalls, STEPS_PER_TURN, utf8Bytes } from "../../src/kernel/derive.ts";
import type { Ended, Input, Message } from "../../src/kernel/types.ts";
import {
  assistant,
  call,
  codeText,
  current,
  env,
  feed,
  modelInterrupted,
  modelOk,
  preset,
  reply,
  stopInput,
  textOf,
  toolDone,
  toolInterrupted,
  toolOk,
  userInput,
  world,
} from "./helpers.ts";
import type { World } from "./helpers.ts";

// 设计稿里写明的文本。
const INTERRUPTED = "被中断，结果未知";
const SKIPPED = "未执行";

const W = 100_000;
const P = preset({ contextWindow: W });
const T = handoffThreshold(P);
/** 远低于阈值的用量。 */
const LOW = 1_000;
/** 达到阈值的用量。 */
const HIGH = Math.ceil(T);

/** 消息的简写：工具结果写成 `id=文本`，其余写成 `角色:文本`。 */
function brief(ms: readonly Message[]): string[] {
  return ms.map((m) => (m.role === "toolResult" ? `${m.toolCallId}=${textOf(m)}` : `${m.role}:${textOf(m)}`));
}

/** 新进程收到第一条用户消息。 */
function begin(text = "你好", pr = P): World {
  const w = world(pr);
  feed(w, userInput(text));
  return w;
}

/** 一轮开始后，模型要求按顺序调用这些工具。 */
function withCalls(ids: string[], u = LOW): World {
  const w = begin();
  reply(w, assistant({ usage: u, calls: ids.map((id) => call(id)) }));
  return w;
}

/** 一轮里先跑一个工具，工具结果写入后用量到阈值：进入换段，本轮已走 2 步。 */
function atHandoff(): World {
  const w = begin();
  reply(w, assistant({ usage: HIGH, calls: [call("c1")] }));
  toolDone(w, "好");
  assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" });
  return w;
}

/** 断言这条输入被丢弃：进程记录和工作段都不变。 */
function assertDropped(w: World, input: Input): void {
  const p = w.p;
  const seg = current(w);
  const s = feed(w, input);
  assert.deepEqual(s.append, []);
  assert.deepEqual(w.p, p);
  assert.deepEqual(current(w), seg);
}

describe("4.3 start", () => {
  test("只建一个 idle 进程：段号 1，lastEffect 为 0，memoryView 取自 env", () => {
    const p = start("p1", P, env(123, "k: v"));
    assert.deepEqual(p, { id: "p1", preset: P, createdAt: 123, segment: { seq: 1, memoryView: "k: v" }, lastEffect: 0, phase: { tag: "idle" } });
    assert.equal(effectOf(p, []), null);
  });

  test("decide 只在开段时使用 Env.memoryView", () => {
    const w = world(P, env(0, "旧"));
    feed(w, userInput("你好"), env(1, "新一"));
    reply(w, assistant({ usage: HIGH, calls: [call("c1")] }), env(2, "新二"));
    feed(w, userInput("排队"), env(3, "新三"));
    toolDone(w, "好", env(4, "新四"));
    assert.equal(w.p.segment.memoryView, "旧");
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
    reply(w, assistant({ usage: 10, text: "交接说明" }), env(5, "开段时的视图"));
    assert.deepEqual(w.p.segment, { seq: 2, memoryView: "开段时的视图" });
  });
});

describe("5.1 continueTurn", () => {
  test("步数达到 STEPS_PER_TURN 时以 stepLimit 结束本轮；排队的消息写入，但不再继续", () => {
    const w = begin();
    let calls = 1; // begin 已经发出第一次模型调用
    for (let id = 0; ; id++) {
      assert.ok(calls <= STEPS_PER_TURN, `调用了 ${calls} 次模型，超过 ${STEPS_PER_TURN}`);
      reply(w, assistant({ usage: LOW, calls: [call(`c${id}`)] }));
      if (id === 2) feed(w, userInput("排队的消息"));
      const s = toolDone(w, "好");
      if (w.p.phase.tag === "idle") {
        assert.deepEqual(brief(s.append), [`c${id}=好`, "user:排队的消息"]);
        break;
      }
      calls++;
      assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.turn.steps, calls);
    }
    assert.equal(calls, STEPS_PER_TURN);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
  });

  test("每次调用模型都计一步，交接调用也算", () => {
    const w = atHandoff();
    const s = reply(w, assistant({ usage: 10, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: [] }, purpose: "turn" });
    assert.equal(w.p.lastEffect, s.prev.lastEffect + 1);
  });

  test("上下文用量达到阈值进入 handoff，差一个 token 就是 turn", () => {
    for (const [delta, purpose] of [
      [0, "handoff"],
      [-1, "turn"],
    ] as const) {
      const w = begin();
      const next: Message = { role: "user", content: "继续", timestamp: 0 };
      const est = contextUsed(w.p, [assistant({ usage: 1 }), next]) - 1;
      reply(w, assistant({ usage: Math.ceil(T) - est + delta, text: "好的" }));
      assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
      feed(w, userInput("继续"));
      assert.equal(contextUsed(w.p, current(w)), Math.ceil(T) + delta);
      assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose });
    }
  });
});

describe("5.1 endTurn", () => {
  test("正在等的调用写“被中断，结果未知”，其余写“未执行”，已有的结果不动", () => {
    const w = withCalls(["c1", "c2", "c3"]);
    toolDone(w, "一");
    const s = feed(w, stopInput());
    assert.deepEqual(brief(s.append), [`c2=${INTERRUPTED}`, `c3=${SKIPPED}`]);
    assert.deepEqual(brief(current(w)).slice(2), ["c1=一", `c2=${INTERRUPTED}`, `c3=${SKIPPED}`]);
  });

  test("排队的消息合并成一条用户消息，写入工作段", () => {
    const w = withCalls(["c1", "c2"]);
    feed(w, userInput("甲"));
    feed(w, userInput("乙"));
    const s = feed(w, stopInput());
    assert.deepEqual(brief(s.append).slice(0, 2), [`c1=${INTERRUPTED}`, `c2=${SKIPPED}`]);
    assert.equal(s.append.length, 3);
    const merged = s.append[2]!;
    assert.equal(merged.role, "user");
    const text = textOf(merged);
    assert.ok(text.includes("甲") && text.includes("乙") && text.indexOf("甲") < text.indexOf("乙"), text);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
  });

  test("ended 是 done 且有排队的消息：用新的 Turn 执行 continueTurn", () => {
    const w = withCalls(["c1"]);
    toolDone(w, "好");
    feed(w, userInput("甲"));
    feed(w, userInput("乙"));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: ["甲", "乙"] }, purpose: "turn" });
    const s = reply(w, assistant({ usage: LOW, text: "完成了" }));
    assert.equal(s.append.length, 2);
    assert.deepEqual(brief(s.append.slice(0, 1)), ["assistant:完成了"]);
    const merged = s.append[1]!;
    assert.equal(merged.role, "user");
    assert.ok(textOf(merged).indexOf("甲") >= 0 && textOf(merged).indexOf("甲") < textOf(merged).indexOf("乙"), textOf(merged));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" });
    assert.equal(w.p.lastEffect, s.prev.lastEffect + 1);
  });

  test("ended 不是 done 时：排队的消息写入后进入 idle", () => {
    const w = begin();
    feed(w, userInput("甲"));
    const s = reply(w, assistant({ usage: 0, stopReason: "error", errorMessage: "529 过载" }));
    assert.deepEqual(brief(s.append), ["user:甲"]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "529 过载" } });
  });
});

describe("5.2 每种输入", () => {
  test("userMessage，进程 idle：写入工作段，用新的 Turn 执行 continueTurn", () => {
    const w = world(P);
    const s = feed(w, userInput("你好"), env(10));
    assert.deepEqual(brief(s.append), ["user:你好"]);
    assert.equal(s.append[0]?.timestamp, 10);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" });
    assert.deepEqual(s.after, { kind: "callModel", n: 1, purpose: "turn" });

    // 上一轮走了 2 步；新的一轮从头计步。
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    toolDone(w, "好");
    reply(w, assistant({ usage: LOW, text: "完成了" }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
    feed(w, userInput("再来"));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" });
  });

  test("decide 写入的用户消息裁剪到字节上限：空闲时的消息、合并的排队消息", () => {
    const big = codeText(100 * 1024);
    const w = begin(big);
    assert.equal(textOf(current(w)[0]!), clip(big));
    assert.ok(utf8Bytes(textOf(current(w)[0]!)) <= MESSAGE_MAX_BYTES);

    const q = withCalls(["c1"]);
    const parts = [codeText(20_000, "甲"), codeText(20_000, "乙")];
    for (const text of parts) feed(q, userInput(text));
    assert.deepEqual(q.p.phase.tag !== "idle" && q.p.phase.turn.queued, parts, "排队时不裁剪");
    const s = feed(q, stopInput());
    assert.equal(textOf(s.append.at(-1)!), clip(parts.join("\n\n")));
    assert.ok(utf8Bytes(textOf(s.append.at(-1)!)) <= MESSAGE_MAX_BYTES);
  });

  test("userMessage，进程正在运行：放进 turn.queued，不写工作段，不发新副作用", () => {
    const w = begin();
    const a = feed(w, userInput("甲"));
    assert.deepEqual(a.append, []);
    assert.deepEqual(a.after, a.before);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: ["甲"] }, purpose: "turn" });

    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    const b = feed(w, userInput("乙"));
    assert.deepEqual(b.append, []);
    assert.deepEqual(b.after, b.before);
    assert.deepEqual(w.p.phase, { tag: "awaitingTool", turn: { steps: 1, queued: ["甲", "乙"] } });
  });

  test("modelResult 被中断：endTurn(服务重启，模型调用被中断)，用途 turn 和 handoff 都一样", () => {
    const a = begin();
    const s = feed(a, modelInterrupted(a.p.lastEffect));
    assert.deepEqual(s.append, []);
    assert.deepEqual(a.p.phase, { tag: "idle", ended: { error: "服务重启，模型调用被中断" } });

    const b = atHandoff();
    const before = current(b);
    feed(b, modelInterrupted(b.p.lastEffect));
    assert.deepEqual(b.p.phase, { tag: "idle", ended: { error: "服务重启，模型调用被中断" } });
    assert.equal(b.p.segment.seq, 1);
    assert.deepEqual(current(b), before);
  });

  test("toolResult 正常，还有待执行的调用且用量没到阈值：进入下一个 awaitingTool", () => {
    const w = withCalls(["c1", "c2", "c3"]);
    const s = toolDone(w, "结果一", env(0), true);
    assert.deepEqual(brief(s.append), ["c1=结果一"]);
    assert.equal(s.append[0]?.role === "toolResult" && s.append[0].isError, true);
    assert.deepEqual(w.p.phase, { tag: "awaitingTool", turn: { steps: 1, queued: [] } });
    assert.equal(w.p.lastEffect, s.prev.lastEffect + 1);
    assert.deepEqual(s.after, { kind: "runTool", n: w.p.lastEffect, call: call("c2") });
  });

  test("toolResult 正常，没有待执行的调用了：continueTurn", () => {
    const w = withCalls(["c1", "c2"]);
    toolDone(w, "一");
    const s = toolDone(w, "二");
    assert.deepEqual(brief(s.append), ["c2=二"]);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "turn" });
  });

  test("toolResult 正常，写入后用量到阈值：剩下的调用补“未执行”，然后换段", () => {
    const margin = 500;
    const big = "a".repeat((margin + 50) * BYTES_PER_TOKEN);
    assert.ok(utf8Bytes(big) <= MESSAGE_MAX_BYTES, "前提：这个结果不会被截断");
    const w = withCalls(["c1", "c2", "c3"], HIGH - margin);
    assert.ok(contextUsed(w.p, current(w)) < T);
    const s = toolDone(w, big);
    assert.ok(contextUsed(w.p, current(w)) >= T);
    assert.deepEqual(brief(s.append), [`c1=${big}`, `c2=${SKIPPED}`, `c3=${SKIPPED}`]);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" });
    assert.deepEqual(pendingCalls(current(w)), []);
  });

  test("toolResult 正常，最后一个结果写入后到阈值：没有要补的，直接换段", () => {
    const margin = 500;
    const big = "b".repeat((margin + 50) * BYTES_PER_TOKEN);
    const w = withCalls(["c1", "c2"], HIGH - margin);
    toolDone(w, "一");
    assert.equal(w.p.phase.tag, "awaitingTool");
    const s = toolDone(w, big);
    assert.deepEqual(brief(s.append), [`c2=${big}`]);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" });
  });

  test("toolResult 超出字节上限：写入时保留头尾", () => {
    const text = "头".repeat(1000) + "中😀".repeat(MESSAGE_MAX_BYTES) + "尾".repeat(1000);
    const w = withCalls(["c1"]);
    const s = toolDone(w, text);
    const stored = textOf(s.append[0]!);
    assert.ok(utf8Bytes(stored) <= MESSAGE_MAX_BYTES, `写入了 ${utf8Bytes(stored)} 字节`);
    assert.ok(stored.startsWith("头".repeat(1000)));
    assert.ok(stored.endsWith("尾".repeat(1000)));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(stored), "截断不能拆开代理对");
  });

  test("toolResult 被中断：endTurn(服务重启，工具被中断)，后面的工具不再跑", () => {
    const w = withCalls(["c1", "c2", "c3"]);
    toolDone(w, "一");
    const s = feed(w, toolInterrupted(w.p.lastEffect));
    assert.deepEqual(brief(s.append), [`c2=${INTERRUPTED}`, `c3=${SKIPPED}`]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "服务重启，工具被中断" } });
    assert.equal(s.after, null);
  });

  test("stop，进程正在等模型：endTurn(stopped)，没有要补的结果", () => {
    const w = begin();
    const s = feed(w, stopInput());
    assert.deepEqual(s.append, []);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });

    const h = atHandoff();
    feed(h, stopInput());
    assert.deepEqual(h.p.phase, { tag: "idle", ended: "stopped" });
    assert.equal(h.p.segment.seq, 1);
  });

  test("stop，进程正在等工具：只有正在等的写“被中断，结果未知”", () => {
    const w = withCalls(["c1", "c2", "c3"]);
    const s = feed(w, stopInput());
    assert.deepEqual(brief(s.append), [`c1=${INTERRUPTED}`, `c2=${SKIPPED}`, `c3=${SKIPPED}`]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
  });

  test("stop，进程 idle：什么都不做", () => {
    const fresh = world(P);
    assertDropped(fresh, stopInput());
    assert.deepEqual(fresh.p.phase, { tag: "idle" });

    const w = begin();
    reply(w, assistant({ usage: LOW, text: "好的" }));
    assertDropped(w, stopInput());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });
});

describe("4.2 丢弃过时和重复的结果", () => {
  test("modelResult 的编号不是 lastEffect：丢弃", () => {
    const w = begin();
    reply(w, assistant({ usage: LOW, calls: [call("c1")] }));
    toolDone(w, "好");
    const n = w.p.lastEffect;
    assertDropped(w, modelOk(n - 1, assistant({ usage: LOW, text: "过时的" })));
    assertDropped(w, modelOk(n + 1, assistant({ usage: LOW, text: "未来的" })));
    assertDropped(w, modelInterrupted(n - 2));
  });

  test("重复的 modelResult：第二条丢弃", () => {
    const w = begin();
    const dup = modelOk(w.p.lastEffect, assistant({ usage: LOW, calls: [call("c1")] }));
    feed(w, dup);
    assertDropped(w, dup);
    toolDone(w, "好");
    const done = modelOk(w.p.lastEffect, assistant({ usage: LOW, text: "完成了" }));
    feed(w, done);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
    assertDropped(w, done);
  });

  test("toolResult 的编号不对或重复：丢弃", () => {
    const w = withCalls(["c1", "c2"]);
    const first = toolOk(w.p.lastEffect, "一");
    assertDropped(w, toolOk(w.p.lastEffect - 1, "过时的"));
    assertDropped(w, toolOk(w.p.lastEffect + 1, "未来的"));
    assertDropped(w, toolInterrupted(w.p.lastEffect + 1));
    feed(w, first);
    assertDropped(w, first);
    assert.deepEqual(brief(current(w)).slice(2), ["c1=一"]);
  });

  test("进程 idle 时收到的结果：丢弃，编号等于 lastEffect 也一样", () => {
    const fresh = world(P);
    assertDropped(fresh, modelOk(0, assistant({ usage: LOW, text: "没人问" })));
    assertDropped(fresh, toolOk(0, "没人问"));

    const a = begin();
    const n = a.p.lastEffect;
    feed(a, stopInput());
    assertDropped(a, modelOk(n, assistant({ usage: LOW, text: "停止之后才到" })));
    assertDropped(a, modelInterrupted(n));

    const b = withCalls(["c1"]);
    const m = b.p.lastEffect;
    feed(b, stopInput());
    assertDropped(b, toolOk(m, "停止之后才到"));
    assertDropped(b, toolInterrupted(m));
  });

  test("结果的种类和阶段对不上：丢弃（忠实的环境里不会出现）", () => {
    const a = begin();
    assertDropped(a, toolOk(a.p.lastEffect, "不是工具"));
    const b = withCalls(["c1"]);
    assertDropped(b, modelOk(b.p.lastEffect, assistant({ usage: LOW, text: "不是模型" })));
  });
});

describe("5.3 模型回复（用途 turn）", () => {
  test("toolUse：写入工作段，进入第一个待执行调用的 awaitingTool", () => {
    const w = begin();
    const m = assistant({ usage: LOW, text: "我先读两个文件", calls: [call("c1"), call("c2", "bash", { command: "dir" })] });
    const s = reply(w, m);
    assert.deepEqual(s.append, [m]);
    assert.deepEqual(w.p.phase, { tag: "awaitingTool", turn: { steps: 1, queued: [] } });
    assert.deepEqual(s.after, { kind: "runTool", n: s.prev.lastEffect + 1, call: call("c1") });
  });

  test("toolUse 但没有工具调用：按 stop 处理", () => {
    const w = begin();
    const m = assistant({ usage: LOW, text: "完成了", stopReason: "toolUse" });
    const s = reply(w, m);
    assert.deepEqual(s.append, [m]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("stop：写入工作段，endTurn(done)", () => {
    const w = begin();
    const m = assistant({ usage: LOW, text: "完成了" });
    const s = reply(w, m);
    assert.deepEqual(s.append, [m]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("stop 但带着工具调用：写入，调用都补“未执行”，本轮 done", () => {
    const w = begin();
    const m = assistant({ usage: LOW, stopReason: "stop", calls: [call("c1"), call("c2")] });
    const s = reply(w, m);
    assert.deepEqual(brief(s.append).slice(1), [`c1=${SKIPPED}`, `c2=${SKIPPED}`]);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" });
  });

  test("length：不写入，endTurn(输出被截断)，截断的工具调用也不写", () => {
    const w = begin();
    const s = reply(w, assistant({ usage: LOW, stopReason: "length", calls: [call("c1", "write", { path: "a" })], errorMessage: "max tokens" }));
    assert.deepEqual(s.append, []);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "输出被截断" } });
  });

  test("stopReason 的每种取值", () => {
    // Record 让编译器检查每种取值都列到了。
    const plain: Record<StopReason, Ended> = {
      stop: "done",
      toolUse: "done",
      length: { error: "输出被截断" },
      error: { error: "error" },
      aborted: { error: "aborted" },
      pending: { error: "pending" },
      deferred: { error: "deferred" },
    };
    const withMessage: Record<StopReason, Ended> = { ...plain, error: { error: "出错了" }, aborted: { error: "出错了" }, pending: { error: "出错了" }, deferred: { error: "出错了" } };
    for (const [table, errorMessage] of [
      [plain, undefined],
      [withMessage, "出错了"],
    ] as const) {
      for (const [reason, ended] of Object.entries(table) as [StopReason, Ended][]) {
        const w = begin();
        const m = assistant({ usage: LOW, text: "正文", stopReason: reason, ...(errorMessage === undefined ? {} : { errorMessage }) });
        const s = reply(w, m);
        assert.deepEqual(w.p.phase, { tag: "idle", ended }, reason);
        assert.deepEqual(s.append, ended === "done" ? [m] : [], `${reason}：失败的回复不写入工作段`);
      }
    }
  });

  test("失败的回复不写入：最后一条助手消息的用量不会变成 0", () => {
    const w = begin();
    reply(w, assistant({ usage: 5_000, calls: [call("c1")] }));
    toolDone(w, "好");
    const used = contextUsed(w.p, current(w));
    reply(w, assistant({ usage: 0, stopReason: "error", errorMessage: "连接断开" }));
    assert.equal(contextUsed(w.p, current(w)), used);
    assert.ok(used > 5_000);
  });
});

describe("5.4 换段", () => {
  test("1. 用量到阈值进入 awaitingModel(handoff)；请求末尾加一条不入库的交接指令", () => {
    const w = atHandoff();
    const seg = current(w);
    assert.deepEqual(effectOf(w.p, seg), { kind: "callModel", n: w.p.lastEffect, purpose: "handoff" });
    const req = buildContext(w.p, seg);
    assert.equal(req.messages.length, seg.length + 1);
    const last = req.messages.at(-1);
    assert.equal(last?.role, "user");
    assert.equal(last?.role === "user" && last.content, HANDOFF_INSTRUCTION);
    assert.deepEqual(current(w), seg);
  });

  test("2. 交接回复 stop 且正文不为空：开新段，交接说明是新段的第一条消息，然后 continueTurn", () => {
    const w = atHandoff();
    const old = current(w);
    const note = "目标：重构。进展：读完了。下一步：改代码。\n最后一条用户消息：“你好”";
    const s = reply(w, assistant({ usage: 3_000, thinking: "想一想", text: note }), env(777, "开段时的记忆"));
    assert.deepEqual(w.p.segment, { seq: 2, memoryView: "开段时的记忆" });
    assert.deepEqual(w.segments.get(1), old, "交接回复不写进旧段");
    assert.equal(s.append.length, 1);
    const first = s.append[0]!;
    assert.equal(first.role, "user");
    assert.equal(first.timestamp, 777);
    assert.ok(textOf(first).endsWith(note), textOf(first));
    assert.ok(!textOf(first).includes("想一想"), "思考不是正文");
    assert.deepEqual(current(w), s.append);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: [] }, purpose: "turn" });
    assert.equal(w.p.lastEffect, s.prev.lastEffect + 1);
  });

  test("2. 交接回复 length 也接受", () => {
    const w = atHandoff();
    reply(w, assistant({ usage: 3_000, text: "截断的交接说明……", stopReason: "length" }));
    assert.equal(w.p.segment.seq, 2);
    assert.ok(textOf(current(w)[0]!).endsWith("截断的交接说明……"));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: [] }, purpose: "turn" });
  });

  test("3. 其它情况都算失败：不写入，endTurn(交接失败：…)，旧段不变", () => {
    const accepted: Record<StopReason, boolean> = { stop: true, length: true, toolUse: false, error: false, aborted: false, pending: false, deferred: false };
    const cases: { reason: StopReason; text?: string; thinking?: string; errorMessage?: string; withCall?: boolean }[] = [];
    for (const [reason, ok] of Object.entries(accepted) as [StopReason, boolean][]) {
      if (ok) {
        cases.push({ reason }, { reason, text: "" }, { reason, text: " \n\t " }, { reason, thinking: "只有思考" });
      } else {
        cases.push({ reason, text: "交接说明" }, { reason, text: "交接说明", errorMessage: "出错了" });
      }
    }
    cases.push({ reason: "toolUse", text: "交接说明", withCall: true });
    for (const c of cases) {
      const w = atHandoff();
      const old = current(w);
      const m = assistant({
        usage: 3_000,
        stopReason: c.reason,
        ...(c.text === undefined ? {} : { text: c.text }),
        ...(c.thinking === undefined ? {} : { thinking: c.thinking }),
        ...(c.errorMessage === undefined ? {} : { errorMessage: c.errorMessage }),
        ...(c.withCall ? { calls: [call("h1")] } : {}),
      });
      const s = reply(w, m);
      const label = JSON.stringify(c);
      assert.deepEqual(s.append, [], label);
      assert.equal(w.p.segment.seq, 1, label);
      assert.deepEqual(current(w), old, label);
      assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：" + (c.errorMessage ?? c.reason) } }, label);
    }
  });

  test("3. 换段失败时排队的消息仍按 endTurn 写进旧段", () => {
    const w = atHandoff();
    feed(w, userInput("排队的"));
    const s = reply(w, assistant({ usage: 3_000, stopReason: "error", errorMessage: "超时" }));
    assert.deepEqual(brief(s.append), ["user:排队的"]);
    assert.equal(w.p.segment.seq, 1);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：超时" } });
  });

  test("3. 换段失败后，再发一条消息，continueTurn 立即重试换段", () => {
    const w = atHandoff();
    reply(w, assistant({ usage: 3_000, stopReason: "toolUse", calls: [call("h1")] }));
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：toolUse" } });
    feed(w, userInput("再试一次"));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "handoff" });
    reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    assert.equal(w.p.segment.seq, 2);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "turn" });
  });

  test("4. 段末还没处理的用户消息不进交接请求，原样附在新段第一条消息的说明后面", () => {
    const w = atHandoff();
    const kept = current(w);
    for (const text of ["甲", "乙"]) {
      reply(w, assistant({ usage: 3_000, stopReason: "error", errorMessage: "超时" }));
      feed(w, userInput(text));
      assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
      assert.deepEqual(buildContext(w.p, current(w)).messages, [...kept, { role: "user", content: HANDOFF_INSTRUCTION, timestamp: 0 }], "交接请求每次都一样");
    }
    const s = reply(w, assistant({ usage: 3_000, text: "交接说明" }), env(9));
    assert.deepEqual(s.append, [{ role: "user", content: `${HANDOFF_HEADER}交接说明\n\n${CARRY_HEADER}\n\n甲\n\n乙`, timestamp: 9 }]);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "turn" });
  });

  test("4. 带过去的消息很大时，新段第一条消息整体裁剪到字节上限", () => {
    const w = atHandoff();
    const tail = [codeText(MESSAGE_MAX_BYTES, "甲"), codeText(MESSAGE_MAX_BYTES, "乙")];
    for (const text of tail) {
      reply(w, assistant({ usage: 3_000, stopReason: "error", errorMessage: "超时" }));
      feed(w, userInput(text));
    }
    const note = codeText(20_000, "note").trim();
    const s = reply(w, assistant({ usage: 3_000, text: note }));
    const first = textOf(s.append[0]!);
    assert.equal(first, clip(`${HANDOFF_HEADER}${note}\n\n${CARRY_HEADER}\n\n${tail.map((t) => clip(t)).join("\n\n")}`));
    assert.ok(utf8Bytes(first) <= MESSAGE_MAX_BYTES, `${utf8Bytes(first)} 字节`);
    assert.ok(first.startsWith(HANDOFF_HEADER + note.slice(0, 1000)));
  });

  test("一轮跨越换段：步数和排队的消息带到新段", () => {
    const w = atHandoff();
    feed(w, userInput("甲"));
    reply(w, assistant({ usage: 3_000, text: "交接说明" }));
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: ["甲"] }, purpose: "turn" });
    const s = reply(w, assistant({ usage: 3_000, text: "完成了" }));
    assert.deepEqual(brief(s.append), ["assistant:完成了", "user:甲"]);
    assert.equal(w.p.segment.seq, 2);
    assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 1, queued: [] }, purpose: "turn" });
  });

  test("5. 换段只发生在 continueTurn 里，这时所有工具调用都已有结果", () => {
    const w = withCalls(["c1", "c2", "c3"], HIGH);
    // 回复本身的用量已经到阈值，第一个工具照样执行；结果写入后剩下的补“未执行”。
    assert.deepEqual(w.p.phase, { tag: "awaitingTool", turn: { steps: 1, queued: [] } });
    const s = toolDone(w, "一");
    assert.deepEqual(brief(s.append), ["c1=一", `c2=${SKIPPED}`, `c3=${SKIPPED}`]);
    assert.deepEqual(pendingCalls(current(w)), []);
    assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff");
  });
});
