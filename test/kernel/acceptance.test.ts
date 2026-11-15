// 执行清单第 1 步的两条验收：换段不能无限循环；一条助手消息带很多大结果时，工作段不超过窗口。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { effectOf } from "../../src/kernel/decide.ts";
import { BYTES_PER_TOKEN, contextUsed, HANDOFF_RATIO, STEPS_PER_TURN, TOOL_RESULT_MAX_BYTES, utf8Bytes } from "../../src/kernel/derive.ts";
import { assistant, call, codeText, current, feed, preset, reply, toolDone, userInput, world } from "./helpers.ts";
import type { ReplySpec, World } from "./helpers.ts";

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
  // 窗口小到系统提示词和工具定义本身就超过阈值，所以每个新段都立即要求换段。
  const w = world(preset({ contextWindow: 10 }));
  for (let round = 1; round <= 3; round++) {
    const seq = w.p.segment.seq;
    feed(w, userInput(`第 ${round} 条消息`));
    assert.ok(contextUsed(w.p, current(w)) >= HANDOFF_RATIO * 10);
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
  const w = world(preset({ contextWindow: 10 }));
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
  const W = 20_000;
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

test("一条助手消息带很多工具调用、每个结果都超过字节上限：工作段不超过窗口", (t) => {
  // 真实的大结果：像源代码，带换行、引号和中文，每个都是字节上限的两倍。
  const huge = codeText(2 * TOOL_RESULT_MAX_BYTES);
  const instruction = Math.ceil(utf8Bytes(HANDOFF_INSTRUCTION) / BYTES_PER_TOKEN);
  for (const W of [64_000, 128_000, 200_000]) {
    const T = HANDOFF_RATIO * W;
    for (const startAt of [0.1 * W, 0.5 * W, Math.ceil(T) - 1]) {
      const label = `窗口 ${W}，回复用量 ${Math.floor(startAt)}`;
      const w = world(preset({ contextWindow: W }));
      feed(w, userInput("把这些文件都读一遍"));
      const calls = Array.from({ length: 40 }, (_, i) => call(`c${i}`, "read", { path: `big${i}.ts` }));
      reply(w, assistant({ usage: Math.floor(startAt), calls }));
      let ran = 0;
      let maxResult = 0;
      let used = contextUsed(w.p, current(w));
      while (w.p.phase.tag === "awaitingTool") {
        toolDone(w, huge);
        ran++;
        const now = contextUsed(w.p, current(w));
        maxResult = Math.max(maxResult, now - used);
        used = now;
        assert.ok(used <= W, `${label}：第 ${ran} 个结果之后用量 ${used} 超过窗口`);
      }
      assert.ok(ran >= 1 && ran < calls.length, `${label}：执行了 ${ran} 个工具`);
      // 设计稿第 5.4 节第 4 条：阈值给一个工具结果的上限和交接指令留出空间。
      assert.ok((1 - HANDOFF_RATIO) * W >= maxResult + instruction, `${label}：阈值之上只剩 ${(1 - HANDOFF_RATIO) * W}，一个结果就占 ${maxResult}`);
      assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 2, queued: [] }, purpose: "handoff" }, label);
      assert.ok(used + instruction <= W, `${label}：交接请求 ${used + instruction} 放不进窗口`);
      t.diagnostic(`${label}：执行 ${ran} 个，最高用量 ${used}（${((100 * used) / W).toFixed(1)}%），一个结果约 ${maxResult} token`);

      reply(w, assistant({ usage: used + instruction + 2_000, text: codeText(4_000, "note") }));
      assert.equal(w.p.segment.seq, 2, label);
      assert.ok(contextUsed(w.p, current(w)) <= W, label);
      assert.deepEqual(w.p.phase, { tag: "awaitingModel", turn: { steps: 3, queued: [] }, purpose: "turn" }, label);
    }
  }
});
