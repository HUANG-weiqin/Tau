// 执行清单第 1 步和第 4 步的验收：换段不能无限循环；交接请求加上交接说明的输出，一定放得进窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, HANDOFF_INSTRUCTION, tailStart } from "../../src/kernel/context.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import { contextUsed, handoffThreshold, MARGIN_TOKENS, MESSAGE_MAX_BYTES, messageBytes, outputMax, STEPS_PER_TURN, tokens, usageOf, utf8Bytes } from "../../src/kernel/derive.ts";
import { assistant, call, codeText, current, feed, preset, reply, stopInput, toolDone, userInput, world } from "./helpers.ts";
import type { ReplySpec, World } from "./helpers.ts";

/** 阈值是正数，但系统提示词和工具定义本身就超过阈值。 */
const TINY = 28_000;

/** 跑到进程回到 idle，返回调用了几次模型。`answer` 给出每次模型调用的回复。 */
function runTurn(w: World, answer: (purpose: "turn" | "handoff") => ReplySpec, tool = "好"): { calls: number; handoffs: number } {
  let calls = 0;
  let handoffs = 0;
  for (let guard = 0; w.p.phase.tag !== "idle"; guard++) {
    assert.ok(guard < 10 * STEPS_PER_TURN, "一轮没有停下来");
    const eff = effectOf(w.p, current(w));
    assert.ok(eff !== null);
    if (eff.kind === "callModel") {
      calls++;
      if (eff.purpose === "handoff") handoffs++;
      reply(w, assistant(answer(eff.purpose)));
    } else {
      toolDone(w, tool);
    }
  }
  return { calls, handoffs };
}

test("每段一开始就超过阈值：每次换段都计步，步数用完时结束本轮", () => {
  const w = world(preset({ contextWindow: TINY }));
  const T = handoffThreshold(w.p.preset);
  assert.ok(T > 0, `阈值 ${T}`);
  for (let round = 1; round <= 3; round++) {
    const seq = w.p.segment.seq;
    feed(w, userInput(`第 ${round} 条消息`));
    assert.ok(contextUsed(w.p, current(w)) >= T);
    const r = runTurn(w, (purpose) => {
      assert.equal(purpose, "handoff");
      return { usage: 5, text: "交接说明" };
    });
    assert.equal(r.calls, STEPS_PER_TURN);
    assert.equal(r.handoffs, STEPS_PER_TURN);
    assert.equal(w.p.segment.seq, seq + STEPS_PER_TURN);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
  }
});

test("交接一直失败：每条用户消息只调用一次模型，旧段不变", () => {
  const w = world(preset({ contextWindow: TINY }));
  for (let round = 1; round <= 5; round++) {
    feed(w, userInput(`第 ${round} 条消息`));
    const r = runTurn(w, () => ({ usage: 5, stopReason: "error", errorMessage: "过载" }));
    assert.equal(r.calls, 1);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: { error: "交接失败：过载" } });
    assert.equal(w.p.segment.seq, 1);
    assert.equal(current(w).length, round);
  }
});

test("模型一直要求调用工具，中途多次换段：步数用完时结束本轮", () => {
  const W = 48_000;
  const w = world(preset({ contextWindow: W }));
  feed(w, userInput("一直干下去"));
  let id = 0;
  const r = runTurn(
    w,
    (purpose) => {
      const used = contextUsed(w.p, current(w));
      return purpose === "handoff" ? { usage: used + 300, text: "交接说明：继续干" } : { usage: used + 200, calls: [call(`c${id++}`)] };
    },
    codeText(2_000),
  );
  assert.equal(r.calls, STEPS_PER_TURN);
  assert.ok(r.handoffs >= 2, `只换了 ${r.handoffs} 次段`);
  assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
});

// 第 4 步：换段阈值的空档。最坏情况：用量 U < T 时调用模型，回复写满输出上限，带 40 个工具调用，结果都超过字节上限。
const WINDOWS = [65_536, 64_000, 128_000, 200_000, 1_000_000];
/** 像源代码的大结果和大消息：带换行、引号和中文，都超过字节上限。 */
const HUGE = codeText(2 * MESSAGE_MAX_BYTES);
const BIG = codeText(MESSAGE_MAX_BYTES + 100, "u");
const I = tokens(utf8Bytes(HANDOFF_INSTRUCTION));

/** `n` 个读大文件的工具调用，ID 由 `id` 给出。 */
const manyCalls = (n: number, id: (i: number) => string = (i) => `c${i}`) => Array.from({ length: n }, (_, i) => call(id(i), "read", { path: `big${i}.ts` }));

/**
 * 上一次回复之后用量是 `used`（先走 `pad` 步小的工具调用），然后这次调用的回复用量是 `used + outputMax`，带 `calls`。
 * 回复被写入时，返回时进程在等第一个工具。
 */
function worstReply(W: number, used: number, pad = 0, calls = manyCalls(40)): World {
  const w = world(preset({ contextWindow: W }));
  feed(w, userInput("开始"));
  reply(w, assistant({ usage: used - tokens(utf8Bytes("继续")), text: "好的" }));
  feed(w, userInput("继续"));
  if (pad === 0) assert.equal(contextUsed(w.p, current(w)), used);
  for (let i = 0; i < pad; i++) {
    reply(w, assistant({ usage: 1_000, calls: [call(`p${i}`)] }));
    toolDone(w, "好");
  }
  assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "turn");
  reply(w, assistant({ usage: used + outputMax(w.p.preset), calls }));
  return w;
}

/**
 * 进程在等交接说明。交接请求的用量 + 指令 + 交接说明的输出 ≤ W − MARGIN + I + S，并且放得进窗口。
 * S 是锚点之后、除了那个完整工具结果的正文以外的所有字节：补的结果、ID 和名称。
 */
function assertBound(w: World, label: string, full: string | null): number {
  assert.equal(w.p.phase.tag === "awaitingModel" && w.p.phase.purpose, "handoff", label);
  const seg = current(w);
  const kept = seg.slice(0, tailStart(seg));
  const anchor = kept.findLastIndex((m) => m.role === "assistant" && usageOf(m) > 0);
  const after = kept.slice(anchor + 1).reduce((n, m) => n + messageBytes(m), 0);
  const S = tokens(after - (full === null ? 0 : utf8Bytes(full)));
  const used = contextUsed(w.p, kept);
  const { contextWindow: W } = w.p.preset;
  const need = used + I + outputMax(w.p.preset);
  assert.ok(need <= W - MARGIN_TOKENS + I + S, `${label}：交接请求 ${used} + 指令 ${I} + 输出 ${outputMax(w.p.preset)} = ${need}，超过 ${W} − ${MARGIN_TOKENS} + ${I} + ${S}`);
  assert.ok(need <= W, `${label}：${need} 放不进窗口 ${W}`);
  assert.equal(buildContext(w.p, seg).messages.length, kept.length + 1, label);
  return used;
}

test("一条回复带很多工具调用、每个结果都超过字节上限：交接请求和交接说明放得进窗口", (t) => {
  for (const W of WINDOWS) {
    const T = handoffThreshold(preset({ contextWindow: W }));
    for (const used of [Math.floor(0.1 * T), Math.floor(0.5 * T), T - 1]) {
      const label = `窗口 ${W}，回复前用量 ${used}`;
      const w = worstReply(W, used);
      let ran = 0;
      while (w.p.phase.tag === "awaitingTool") {
        toolDone(w, HUGE);
        ran++;
        assert.ok(contextUsed(w.p, current(w)) <= W, `${label}：第 ${ran} 个结果之后超过窗口`);
      }
      assert.ok(ran >= 1 && ran < 40, `${label}：执行了 ${ran} 个工具`);
      const full = textOfLastFull(w);
      const req = assertBound(w, label, full);
      t.diagnostic(`${label}：执行 ${ran} 个，交接请求 ${req}（${((100 * req) / W).toFixed(1)}%）`);

      reply(w, assistant({ usage: req + I + 2_000, text: codeText(4_000, "note") }));
      assert.equal(w.p.segment.seq, 2, label);
      assert.ok(contextUsed(w.p, current(w)) <= W, label);
      assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: [] }, purpose: "turn" }, label);
    }
  }
});

/** 段里最后一个不是补出来的工具结果的正文：它是唯一一个可能写满字节上限的结果。 */
function textOfLastFull(w: World): string {
  const results = current(w).filter((m) => m.role === "toolResult" && !m.isError);
  const last = results.at(-1);
  assert.ok(last?.role === "toolResult");
  return last.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

test("等工具时停止，排队一条大消息，再发一条大消息：交接请求不带这两条", () => {
  for (const W of WINDOWS) {
    const w = worstReply(W, handoffThreshold(preset({ contextWindow: W })) - 1);
    feed(w, userInput(BIG));
    feed(w, stopInput());
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stopped" });
    feed(w, userInput(BIG));
    assertBound(w, `窗口 ${W}`, null);
    assert.equal(current(w).length - tailStart(current(w)), 2);
  }
});

test("刚过阈值时步数用完，排队一条大消息，再发一条大消息：交接请求不带这两条", () => {
  for (const W of WINDOWS) {
    const w = worstReply(W, handoffThreshold(preset({ contextWindow: W })) - 1, STEPS_PER_TURN - 1);
    feed(w, userInput(BIG));
    toolDone(w, HUGE);
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "stepLimit" });
    feed(w, userInput(BIG));
    assertBound(w, `窗口 ${W}`, textOfLastFull(w));
    assert.equal(current(w).length - tailStart(current(w)), 2);
  }
});

test("交接失败 10 次，每次之后发一条大消息：交接请求每次都一样，都放得进窗口", () => {
  for (const W of WINDOWS) {
    const w = worstReply(W, handoffThreshold(preset({ contextWindow: W })) - 1);
    toolDone(w, HUGE);
    const full = textOfLastFull(w);
    const first = buildContext(w.p, current(w));
    for (let i = 1; i <= 10; i++) {
      reply(w, assistant({ usage: 0, stopReason: "error", errorMessage: "超出窗口" }));
      feed(w, userInput(BIG));
      assert.deepEqual(buildContext(w.p, current(w)), first, `窗口 ${W}，第 ${i} 次`);
      assertBound(w, `窗口 ${W}，第 ${i} 次`, full);
    }
    assert.equal(current(w).length - tailStart(current(w)), 10);
  }
});

/** pi-ai 里真实的 ID 形状：Anthropic 是 30 字节；openai-responses 拼成 `${call_id}|${item.id}`，81 字节。 */
const ID_SHAPES: [string, number, (i: number) => string][] = [
  ["Anthropic", 30, (i) => `toolu_${String(i).padStart(24, "0")}`],
  ["openai-responses", 81, (i) => `call_${String(i).padStart(24, "0")}|fc_${String(i).padStart(48, "0")}`],
];

test("一条回复的工具调用多到补的结果放不进余量：不写入这条回复；刚好放得进时交接请求放得进窗口", () => {
  for (const [shape, bytes, id] of ID_SHAPES) {
    assert.equal(utf8Bytes(id(0)), bytes);
    // 能写入的最多调用数：二分，lo 个能写入，hi 个不能。
    const accepted = (n: number) => worstReply(65_536, 1_000, 0, manyCalls(n, id)).p.phase.tag === "awaitingTool";
    let [lo, hi] = [40, 1_000];
    assert.ok(accepted(lo), `${shape}：${lo} 个调用应该能写入`);
    assert.ok(!accepted(hi), `${shape}：${hi} 个调用应该被拒绝`);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (accepted(mid)) lo = mid;
      else hi = mid;
    }
    for (const W of WINDOWS) {
      const T = handoffThreshold(preset({ contextWindow: W }));
      const w = worstReply(W, T - 1, 0, manyCalls(lo, id));
      toolDone(w, HUGE);
      assertBound(w, `${shape}，窗口 ${W}，${lo} 个调用`, textOfLastFull(w));

      for (const stopReason of ["toolUse", "stop"] as const) {
        const label = `${shape}，窗口 ${W}，${hi} 个调用，${stopReason}`;
        const x = world(preset({ contextWindow: W }));
        feed(x, userInput("开始"));
        const before = current(x);
        reply(x, assistant({ usage: T - 1 + outputMax(x.p.preset), stopReason, calls: manyCalls(hi, id) }));
        assert.deepEqual(x.p.phase, { tag: "idle", ended: { error: "一次回复的工具调用太多" } }, label);
        assert.deepEqual(current(x), before, `${label}：被拒绝的回复没有写入`);
      }
    }
  }
});
