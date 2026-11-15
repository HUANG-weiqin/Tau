// 长跑：很多轮对话，周期性换段。进程记录和当前段的大小都有上界。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_INSTRUCTION } from "../../src/kernel/context.ts";
import { effectOf, start } from "../../src/kernel/decide.ts";
import { BYTES_PER_TOKEN, contextUsed, tokens, utf8Bytes } from "../../src/kernel/derive.ts";
import { unreachable } from "../../src/kernel/types.ts";
import type { Env } from "../../src/kernel/types.ts";
import { assistant, call, codeText, current, feed, modelOk, preset, toolOk, usage, userInput, world } from "./helpers.ts";

test("3000 轮对话：周期性换段，进程记录和当前段的大小不随轮数增长", (t) => {
  const W = 64_000;
  const TURNS = 3_000;
  const pr = preset({ contextWindow: W });
  let now = 0;
  const e = (): Env => ({ now: (now += 1_000), memoryView: `turn: ${Math.floor(now / 1e6)}` });
  const w = world(pr, e());
  const base = JSON.stringify(start("p1", pr, e())).length;
  const instruction = tokens(utf8Bytes(HANDOFF_INSTRUCTION));
  let ids = 0;
  let maxRecord = 0;
  let maxLength = 0;
  let maxBytes = 0;
  let maxUsed = 0;
  let firstHandoffTurn = 0;

  for (let turn = 1; turn <= TURNS; turn++) {
    feed(w, userInput(`第 ${turn} 轮：${codeText(200, "u")}`), e());
    let replies = 0;
    for (let guard = 0; w.p.phase.tag !== "idle"; guard++) {
      assert.ok(guard < 100, `第 ${turn} 轮停不下来`);
      const eff = effectOf(w.p, current(w));
      assert.ok(eff !== null);
      const used = contextUsed(w.p, current(w));
      switch (eff.kind) {
        case "callModel": {
          const out = 150;
          const m =
            eff.purpose === "handoff"
              ? assistant({ usage: usage(used + instruction + 400, { input: used + instruction, output: 400 }), text: `交接说明：${codeText(1_200, "h")}` })
              : replies++ === 0
                ? assistant({ usage: usage(used + out, { input: used, output: out }), text: "我先看两个文件。", calls: [call(`c${ids++}`), call(`c${ids++}`, "bash", { command: "dir" })] })
                : assistant({ usage: usage(used + out, { input: used, output: out }), text: `第 ${turn} 轮做完了。${codeText(300, "a")}` });
          feed(w, modelOk(eff.n, m), e());
          break;
        }
        case "runTool":
          // 每 10 轮在工具运行时插一条消息，本轮结束时合并进来，再多走一步。
          if (turn % 10 === 0 && w.p.phase.tag === "awaitingTool" && w.p.phase.turn.queued.length === 0) feed(w, userInput("顺便看下日志"), e());
          feed(w, toolOk(eff.n, codeText(2_000, "r")), e());
          break;
        default:
          unreachable(eff);
      }
      const seg = current(w);
      maxRecord = Math.max(maxRecord, JSON.stringify(w.p).length);
      maxLength = Math.max(maxLength, seg.length);
      maxBytes = Math.max(maxBytes, utf8Bytes(JSON.stringify(seg)));
      maxUsed = Math.max(maxUsed, contextUsed(w.p, seg));
    }
    assert.deepEqual(w.p.phase, { tag: "idle", ended: "done" }, `第 ${turn} 轮`);
    if (firstHandoffTurn === 0 && w.p.segment.seq > 1) firstHandoffTurn = turn;
    // 只留当前段：处理输入只读当前段，旧段不需要在内存里。
    for (const seq of w.segments.keys()) if (seq !== w.p.segment.seq) w.segments.delete(seq);
  }

  const segments = w.p.segment.seq;
  t.diagnostic(`换段 ${segments - 1} 次；进程记录最多 ${maxRecord} 字节（初始 ${base}）；当前段最多 ${maxLength} 条、${maxBytes} 字节；用量最多 ${maxUsed}/${W}`);
  assert.ok(firstHandoffTurn > 0 && firstHandoffTurn < TURNS / 10, `第一次换段在第 ${firstHandoffTurn} 轮`);
  assert.ok(segments - 1 >= TURNS / firstHandoffTurn / 2, `只换了 ${segments - 1} 次段`);
  // 进程记录只多出数字位数和本轮排队的消息。
  assert.ok(maxRecord <= base + 256, `进程记录最多 ${maxRecord} 字节`);
  // 当前段被换段阈值限制住：用量不超过窗口，字节数和条数不超过一段能装下的量。
  assert.ok(maxUsed <= W, `用量最多 ${maxUsed}`);
  assert.ok(maxBytes <= 2 * W * BYTES_PER_TOKEN, `当前段最多 ${maxBytes} 字节`);
  assert.ok(maxLength <= 20 * firstHandoffTurn, `当前段最多 ${maxLength} 条`);
});
