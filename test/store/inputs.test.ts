// 设计稿第 4.4 节：启动、收命令、处理一条输入，以及同步待办副作用表。
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../../src/kernel/decide.ts";
import { handoffThreshold } from "../../src/kernel/derive.ts";
import { createExecutor } from "../../src/executor/executor.ts";
import { loadProcess, loadSegment, tx } from "../../src/store/db.ts";
import { runInStore } from "../../src/store/instore.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { countReads, effectRows, fakeMemory, gated, mailbox, PRESET, reply, say, scripted, settle, tempDb, toolCall, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

test("启动进程：写入 idle 的进程记录，第一条消息进信箱；ID 重复时什么都不写", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "p1", PRESET, "你好", 5);
  const p = loadProcess(db, "p1");
  assert.deepEqual(p?.phase, { tag: "idle" });
  assert.equal(p?.createdAt, 5);
  assert.deepEqual(mailbox(db), [{ id: "p1", input: { kind: "userMessage", text: "你好" } }]);
  assert.throws(() => startProcess(db, memory, "p1", PRESET, "再来", 6));
  assert.equal(mailbox(db).length, 1);
  assertStoreInvariants(db);
});

test("启动进程时冻结记忆视图；预设没有 memory 时不读记忆库", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  memory.set(PRESET.id, "name", "tau", null);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  assert.equal(loadProcess(db, "p1")?.segment.memoryView, memory.view(PRESET.id));
  memory.calls.length = 0;
  startProcess(db, memory, "p2", { ...PRESET, id: "tmp", tools: ["read"] }, "b", 0);
  assert.equal(loadProcess(db, "p2")?.segment.memoryView, "");
  assert.deepEqual(memory.calls, []);
});

test("收命令：进程不存在时报错，什么都不写", (t) => {
  const db = tempDb(t);
  assert.throws(() => send(db, "nope", { kind: "stop" }), /没有这个进程/);
  assert.deepEqual(mailbox(db), []);
});

test("信箱空时 handleNext 返回 null", (t) => {
  assert.equal(handleNext(tempDb(t), fakeMemory(), 0), null);
});

test("用户消息：进入 awaitingModel，插入 pending 行，删除这条输入", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "p1", PRESET, "你好", 0);
  const h = handleNext(db, memory, 1);
  assert.equal(h?.process.phase.tag, "awaitingModel");
  assert.equal(h?.abort, null);
  assert.deepEqual(effectRows(db), [{ id: "p1", n: 1, status: "pending" }]);
  assert.deepEqual(mailbox(db), []);
  assert.deepEqual(loadSegment(db, h!.process), [{ role: "user", content: "你好", timestamp: 1 }]);
  assertStoreInvariants(db);
});

test("库外工具：插入 pending 行", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "read", { path: "a" }))]));
  startProcess(db, memory, "p1", PRESET, "读 a", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  assert.equal(handleNext(db, memory, 0)?.process.phase.tag, "awaitingTool");
  assert.deepEqual(effectRows(db), [{ id: "p1", n: 2, status: "pending" }]);
  assertStoreInvariants(db);
});

test("库内工具：在同一个事务里执行，结果进信箱，不进副作用表", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "memory_set", { key: "k", value: "v" })), say("好了")]));
  startProcess(db, memory, "p1", PRESET, "记住", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  handleNext(db, memory, 0);
  assert.deepEqual(effectRows(db), []);
  assert.deepEqual(mailbox(db), [{ id: "p1", input: { kind: "toolResult", n: 2, outcome: { status: "ok", content: { text: "已写入 k，版本 1。", isError: false } } } }]);
  assert.deepEqual(memory.get(PRESET.id, "k"), { value: "v", version: 1 });
  assertStoreInvariants(db);
  await settle(db, memory, exec);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "done" });
  assert.deepEqual(memory.calls.filter((c) => c === "set"), ["set"]);
});

test("不认识的工具、预设里没有的工具：错误结果在事务里直接进信箱", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, scripted([use(toolCall("c1", "bash", { command: "ls" }), toolCall("c2", "nope")), say("好")]));
  startProcess(db, memory, "p1", PRESET, "跑", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  handleNext(db, memory, 0);
  assert.deepEqual(effectRows(db), []);
  const [first] = mailbox(db);
  assert.equal(first?.input.kind === "toolResult" && first.input.outcome.status === "ok" && first.input.outcome.content.isError, true);
  assertStoreInvariants(db);
  await settle(db, memory, exec);
  const results = loadSegment(db, loadProcess(db, "p1")!).filter((m) => m.role === "toolResult");
  assert.deepEqual(results.map((m) => [m.toolCallId, m.isError, m.content[0]?.type === "text" && m.content[0].text]), [
    ["c1", true, "工具 bash 不存在，或者预设里没有它。"],
    ["c2", true, "工具 nope 不存在，或者预设里没有它。"],
  ]);
});

test("停止：删掉 pending 行时不用中止；删掉 running 行时返回它的编号", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, gated(() => say("好"), () => ({ text: "", isError: false })));
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  send(db, "p1", { kind: "stop" });
  assert.equal(handleNext(db, memory, 0)?.abort, null);
  assert.deepEqual(effectRows(db), []);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "stopped" });

  startProcess(db, memory, "p2", PRESET, "b", 0);
  handleNext(db, memory, 0);
  void exec.startNext();
  send(db, "p2", { kind: "stop" });
  assert.equal(handleNext(db, memory, 0)?.abort, 1);
  assert.deepEqual(effectRows(db), []);
  assertStoreInvariants(db);
});

test("运行中收到用户消息：在等的编号不变，副作用表不动", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const exec = createExecutor(db, gated(() => say("好"), () => ({ text: "", isError: false })));
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  void exec.startNext();
  send(db, "p1", { kind: "userMessage", text: "再说一句" });
  const h = handleNext(db, memory, 0);
  assert.equal(h?.abort, null);
  assert.deepEqual(h?.process.phase, { tag: "awaitingModel", purpose: "turn", turn: { steps: 1, queued: ["再说一句"] } });
  assert.deepEqual(effectRows(db), [{ id: "p1", n: 1, status: "running" }]);
  assertStoreInvariants(db);
});

test("self：投影写成文字，带本地时间、时区和运行中的兄弟进程", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const actions = gated((job) => (job.process.id === "p2" ? use(toolCall("c1", "self")) : say("好")), () => ({ text: "", isError: false }));
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  startProcess(db, memory, "p2", PRESET, "b", 60_000);
  handleNext(db, memory, 0);
  handleNext(db, memory, 0);
  const done = [exec.startNext(), exec.startNext()];
  actions.gates.find((g) => g.job.process.id === "p2")?.finish();
  await done[1 - actions.gates.findIndex((g) => g.job.process.id === "p1")];
  handleNext(db, memory, 3_725_000);
  const [result] = mailbox(db);
  assert.ok(result?.input.kind === "toolResult" && result.input.outcome.status === "ok");
  const text = result.input.outcome.content.text;
  assert.match(text, new RegExp(`（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`));
  assert.match(text, /进程：p2，预设 helper，模型 faux\/model-1，已运行 1 小时 1 分/);
  assert.match(text, /阶段：等工具结果，本轮第 1 步/);
  assert.match(text, /工作段：第 1 段/);
  assert.match(text, /- p1：等模型回复，本轮第 1 步，排队消息 0 条，已运行 1 小时 2 分/);
});

test("记忆工具：读、写、冲突时带最新值、删除、参数错误", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = start("p1", PRESET, { now: 0, memoryView: "" });
  const run = (name: string, args: Parameters<typeof toolCall>[2]) => runInStore(db, memory, p, [], toolCall("c", name, args), 0);
  assert.deepEqual(run("memory_get", { key: "k" }), { text: "键 k 不存在。", isError: false });
  assert.deepEqual(run("memory_set", { key: "k", value: "1" }), { text: "已写入 k，版本 1。", isError: false });
  assert.deepEqual(run("memory_set", { key: "k", value: "2" }), { text: "版本冲突，没有写入。现在的值是 k（版本 1）：\n1", isError: true });
  assert.deepEqual(run("memory_set", { key: "k", value: "2", version: 1 }), { text: "已写入 k，版本 2。", isError: false });
  assert.deepEqual(run("memory_get", { key: "k" }), { text: "k（版本 2）：\n2", isError: false });
  assert.equal(run("memory_delete", { key: "k", version: 1 }).isError, true);
  assert.deepEqual(run("memory_delete", { key: "k", version: 2 }), { text: "已删除 k。", isError: false });
  assert.deepEqual(run("memory_set", { key: "k", value: "3", version: 2 }), { text: "版本冲突，没有写入。键 k 现在不存在。", isError: true });
  assert.equal(memory.get(PRESET.id, "k"), null);
  for (const [name, args] of [
    ["memory_get", {}],
    ["memory_set", { key: "k", value: 1 }],
    ["memory_set", { key: "k", value: "v", version: 1.5 }],
    ["memory_delete", { key: "k" }],
  ] as const) {
    assert.match(run(name, args).text, /^参数错误/, name);
  }
});

test("处理一条输入只读当前段：旧段不加载，查询走 (process_id, segment_seq)", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const preset = { ...PRESET, contextWindow: 32_000 };
  const exec = createExecutor(db, scripted([reply("toolUse", [toolCall("c1", "read", { path: "a" })], handoffThreshold(preset)), say("交接说明"), say("完成"), say("又完成")]));
  startProcess(db, memory, "p1", preset, "a", 0);
  await settle(db, memory, exec);
  const p = loadProcess(db, "p1")!;
  assert.equal(p.segment.seq, 2);
  const current = loadSegment(db, p).length;

  // 旧段塞进 1000 行坏数据：读到任何一行都会解析失败。
  const insert = db.prepare("INSERT INTO segment_messages (process_id, segment_seq, seq, message_json) VALUES ('p1', 1, ?, 'not json')");
  tx(db, () => {
    for (let i = 100; i < 1100; i++) insert.run(i);
  });
  send(db, "p1", { kind: "userMessage", text: "b" });
  const seen = countReads(db);
  handleNext(db, memory, 0);
  // 信箱 1 行 + 进程记录 1 行 + 当前段。
  assert.equal(seen.rows, 2 + current);
  const segmentSql = seen.sql.find((s) => s.includes("FROM segment_messages"));
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${segmentSql}`).all("p1", 2).map((r) => String(r.detail));
  assert.match(plan.join("\n"), /SEARCH segment_messages USING INDEX \S+ \(process_id=\? AND segment_seq=\?\)/);
});
