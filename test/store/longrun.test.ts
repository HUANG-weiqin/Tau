// 真库上的长跑：很多轮对话，周期性换段。进程记录、当前段和处理一条输入读取的行数都有上界，不随段数增长。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Job } from "../../src/executor/executor.ts";
import { userLetter } from "../../src/kernel/types.ts";
import { res } from "../plain.ts";
import { loadProcess, loadSegment } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { countReads, fakeMemory, PRESET, reply, say, settle, tempDb, toolCall } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

/** 每轮先读一个文件再回答；段里每多一条助手消息，用量多 400。大约四轮换一次段。 */
function model(job: Job) {
  const e = job.effect;
  if (e.kind === "callModel" && e.purpose === "handoff") return say("交接说明：继续回答下一条消息。");
  const usage = 400 * (job.segment.filter((m) => m.role === "assistant").length + 1);
  if (job.segment.at(-1)?.role === "toolResult") return reply("stop", [{ type: "text", text: `第 ${e.n} 次回答` }], usage);
  return reply("toolUse", [toolCall(`c${e.n}`, "read", { path: "a" })], usage);
}

test("长跑：200 轮、几十次换段，每条用户消息读取的行数按段周期重复，不随段数增长", async (t) => {
  const db = tempDb(t);
  // 这里不测落盘；几千次提交每次都等磁盘太慢。
  db.exec("PRAGMA synchronous = OFF");
  const memory = fakeMemory();
  const exec = createExecutor(db, {
    callModel: async (job) => model(job),
    runTool: async (_job, call) => res(`out:${call.id}`),
  });
  const seen = countReads(db);
  /** 每段里依次处理的用户消息各读了多少行。 */
  const reads = new Map<number, number[]>();
  let maxRecord = 0;
  let maxSegment = 0;
  startProcess(db, memory, "p1", { ...PRESET, contextWindow: 32_000 }, "开始", 0);
  for (let i = 0; i < 200; i++) {
    if (i > 0) send(db, "p1", userLetter(`第 ${i} 条消息`));
    const seq = loadProcess(db, "p1")!.segment.seq;
    seen.rows = 0;
    handleNext(db, memory, i);
    reads.set(seq, [...(reads.get(seq) ?? []), seen.rows]);
    await settle(db, memory, exec);
    const p = loadProcess(db, "p1")!;
    assert.deepEqual(p.phase, { tag: "idle", ended: "done" });
    maxRecord = Math.max(maxRecord, JSON.stringify(p).length);
    maxSegment = Math.max(maxSegment, loadSegment(db, p).length);
  }
  assertStoreInvariants(db);
  const last = loadProcess(db, "p1")!.segment.seq;
  assert.ok(last > 20, `只换了 ${last - 1} 次段`);
  assert.deepEqual(reads.get(last - 1), reads.get(2));
  assert.ok(Math.max(...[...reads.values()].flat()) <= 2 + maxSegment);
  assert.ok(maxSegment <= 20, `当前段最多 ${maxSegment} 条消息`);
  assert.ok(maxRecord <= 1000, `进程记录最大 ${maxRecord} 字节`);
});
