// 设计稿第 6 节：执行器的开始、完成、中止、失败上报、启动恢复，以及执行清单第 2 步的竞态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import { loadProcess, loadSegment, openDb } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { effectRows, fakeMemory, gated, mailbox, PRESET, say, scripted, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import type { Gate } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const okTool = () => ({ text: "ok", isError: false });

test("开始：一个事务标记 running，提交后同步开始动作；完成：删行，结果进信箱", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const actions = gated(() => say("你好"), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  const done = exec.startNext();
  // startNext 返回时动作已经开始：登记中止开关和开始动作之间没有让出。
  assert.equal(actions.gates.length, 1);
  assert.deepEqual(actions.gates[0]?.job.effect, { kind: "callModel", n: 1, purpose: "turn" });
  assert.deepEqual(actions.gates[0]?.job.segment.map((m) => m.role), ["user"]);
  assert.deepEqual(effectRows(db), [{ id: "p1", n: 1, status: "running" }]);
  assert.equal(exec.startNext(), null);
  assertStoreInvariants(db);
  actions.gates[0]?.finish();
  await done;
  assert.deepEqual(effectRows(db), []);
  assert.deepEqual(mailbox(db), [{ id: "p1", input: { kind: "modelResult", n: 1, outcome: { status: "ok", message: say("你好") } } }]);
  assertStoreInvariants(db);
});

test("动作同步抛出时，模型上报 stopReason 为 error 的助手消息", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, {
    callModel() {
      throw new Error("模型目录里没有 faux/model-1");
    },
    runTool: async () => okTool(),
  });
  startProcess(db, memory, "p1", PRESET, "a", 0);
  await settle(db, memory, exec);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: { error: "模型目录里没有 faux/model-1" } });
});

test("工具的 promise 被拒绝时，上报 isError 的工具结果", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, { ...scripted([use(toolCall("c1", "read", { path: "a" })), say("好")]), runTool: () => Promise.reject(new Error("磁盘坏了")) });
  startProcess(db, memory, "p1", PRESET, "a", 0);
  await settle(db, memory, exec);
  const result = loadSegment(db, loadProcess(db, "p1")!).find((m) => m.role === "toolResult");
  assert.deepEqual(result?.role === "toolResult" && [result.isError, result.content], [true, [{ type: "text", text: "工具执行失败：磁盘坏了" }]]);
});

test("中止：停止删掉 running 行，执行器中止动作，结果被丢弃", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const actions = gated(() => say("你好"), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  const done = exec.startNext();
  send(db, "p1", { kind: "stop" });
  const h = handleNext(db, memory, 0);
  assert.equal(h?.abort, 1);
  exec.abort("p1", 1);
  assert.equal(actions.gates[0]?.signal.aborted, true);
  await done;
  assert.deepEqual(mailbox(db), []);
  assert.deepEqual(effectRows(db), []);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "stopped" });
  exec.abort("p1", 1); // 已经结束的动作：什么都不做
});

test("动作完成时它的行已经不在：丢弃结果", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const actions = gated(() => say("你好"), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  const done = exec.startNext();
  send(db, "p1", { kind: "stop" });
  handleNext(db, memory, 0);
  actions.gates[0]?.finish(); // 调用方没有中止它
  await done;
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

test("启动恢复：running 的行作为 interrupted 送回；pending 的行正常开始；旧的动作写不进库", async (t) => {
  const dbs: DatabaseSync[] = [];
  const path = join(tempDir(t, dbs), "tau.db");
  const memory = fakeMemory();
  dbs.push(openDb(path));
  const db1 = dbs[0]!;
  const old = gated((job) => (job.process.id === "p2" ? use(toolCall("c1", "read", { path: "a" })) : say("好")), okTool);
  const exec1 = createExecutor(db1, old);
  const inflight: Promise<void>[] = [];
  // p1 在等模型（running），p2 在等工具（running），p3 在等模型（pending）。
  startProcess(db1, memory, "p1", PRESET, "a", 0);
  handleNext(db1, memory, 0);
  inflight.push(exec1.startNext()!);
  startProcess(db1, memory, "p2", PRESET, "b", 0);
  handleNext(db1, memory, 0);
  const p2model = exec1.startNext()!;
  old.gates[1]?.finish();
  await p2model;
  handleNext(db1, memory, 0);
  inflight.push(exec1.startNext()!);
  startProcess(db1, memory, "p3", PRESET, "c", 0);
  handleNext(db1, memory, 0);
  assert.deepEqual(effectRows(db1), [
    { id: "p1", n: 1, status: "running" },
    { id: "p2", n: 2, status: "running" },
    { id: "p3", n: 1, status: "pending" },
  ]);

  db1.close(); // 崩溃
  dbs.push(openDb(path));
  const db2 = dbs[1]!;
  const fresh = scripted([say("p3 的回复")]);
  const exec2 = createExecutor(db2, fresh);
  assert.deepEqual(effectRows(db2), [{ id: "p3", n: 1, status: "pending" }]);
  assert.deepEqual(mailbox(db2).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "p1", input: { kind: "modelResult", n: 1, outcome: { status: "interrupted" } } },
    { id: "p2", input: { kind: "toolResult", n: 2, outcome: { status: "interrupted" } } },
  ]);
  assertStoreInvariants(db2);

  // 旧的动作这时才完成：它们拿着关掉的库，写不进去。
  for (const g of old.gates.slice(2)) g.finish();
  old.gates[0]?.finish();
  for (const p of inflight) await assert.rejects(p, /not open/);
  assert.equal(mailbox(db2).length, 2);

  await settle(db2, memory, exec2);
  assert.deepEqual(fresh.log, ["model p3 #1"]);
  assert.deepEqual(loadProcess(db2, "p1")?.phase, { tag: "idle", ended: { error: "服务重启，模型调用被中断" } });
  assert.deepEqual(loadProcess(db2, "p2")?.phase, { tag: "idle", ended: { error: "服务重启，工具被中断" } });
  assert.deepEqual(loadProcess(db2, "p3")?.phase, { tag: "idle", ended: "done" });
  assertStoreInvariants(db2);
});

test("竞态：副作用还是 pending 时收到停止，执行器绝不会再开始它", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const actions = gated(() => say("好"), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  send(db, "p1", { kind: "stop" });
  handleNext(db, memory, 0);
  assert.equal(exec.startNext(), null);
  assert.equal(actions.gates.length, 0);
  assertStoreInvariants(db);
});

/** 让最后开始的那个动作完成，等它的结果写回。 */
async function finishLast(gates: Gate[], done: Promise<void> | null): Promise<void> {
  assert.ok(done);
  gates.at(-1)?.finish();
  await done;
}

test("竞态：库外工具的结果还在信箱里排队时先处理用户消息，工具不会再执行一次", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  let replies = 0;
  const actions = gated(() => (replies++ === 0 ? use(toolCall("c1", "read", { path: "a" })) : say("好")), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  await finishLast(actions.gates, exec.startNext());
  handleNext(db, memory, 0);
  const tool = exec.startNext();
  send(db, "p1", { kind: "userMessage", text: "插一句" });
  await finishLast(actions.gates, tool);
  assert.deepEqual(mailbox(db).map((m) => m.input.kind), ["userMessage", "toolResult"]);
  handleNext(db, memory, 0);
  assert.deepEqual(effectRows(db), []);
  assert.equal(exec.startNext(), null);
  assertStoreInvariants(db);
  await settle(db, memory, exec, actions.gates);
  assert.equal(actions.gates.filter((g) => g.job.effect.kind === "runTool").length, 1);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "done" });
});

test("竞态：库内工具的结果还在信箱里排队时先处理用户消息，工具不会再执行一次", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  let replies = 0;
  const actions = gated(() => (replies++ === 0 ? use(toolCall("c1", "memory_set", { key: "k", value: "v" })) : say("好")), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  await finishLast(actions.gates, exec.startNext());
  send(db, "p1", { kind: "userMessage", text: "插一句" });
  handleNext(db, memory, 0); // 模型结果：在事务里执行 memory_set
  assert.deepEqual(mailbox(db).map((m) => m.input.kind), ["userMessage", "toolResult"]);
  handleNext(db, memory, 0); // 用户消息：排队，编号不变
  assert.deepEqual(effectRows(db), []);
  assert.equal(memory.calls.filter((c) => c === "set").length, 1);
  assertStoreInvariants(db);
  await settle(db, memory, exec, actions.gates);
  assert.equal(memory.calls.filter((c) => c === "set").length, 1);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "done" });
});
