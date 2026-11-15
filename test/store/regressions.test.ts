// 审查确认的存储层缺陷的最小反例。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createExecutor } from "../../src/executor/executor.ts";
import { loadProcess, loadSegment } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { fakeMemory, PRESET, say, scripted, settle, tempDb, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

test("库内工具的参数为 null（pi-ai 解析流式 JSON 'null' 的结果）：不抛出，不堵住信箱，回参数错误", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const nullArgs = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: null }) as unknown as ToolCall;
  const exec = createExecutor(db, scripted([use(nullArgs("c1", "self"), nullArgs("c2", "memory_get")), say("好")]));
  startProcess(db, memory, "p1", PRESET, "看看自己", 0);
  await settle(db, memory, exec);
  const p = loadProcess(db, "p1");
  assert.deepEqual(p?.phase, { tag: "idle", ended: "done" });
  const results = loadSegment(db, p!).flatMap((m) => (m.role === "toolResult" ? [m] : []));
  assert.equal(results.length, 2);
  assert.equal(results[0]?.isError, false);
  assert.equal(results[1]?.isError, true);
  assertStoreInvariants(db);
});
