// 会话配置（D71）在存储层：`reconfigure` 是信箱里的一种输入，由 `send` 放进去；`fresh`（开段视图）只在该算的输入上算；崩溃后信箱里的 `reconfigure` 照常处理。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import { start } from "../../src/kernel/decide.ts";
import { userLetter } from "../../src/kernel/types.ts";
import type { Input, Memory, PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { loadProcess, loadSegment, openDb, putMail, tx } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { freshFor, runInStore } from "../../src/store/instore.ts";
import { plain } from "../plain.ts";
import { effectRows, fakeMemory, gated, mailbox, PRESET, say, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const P: PresetSnapshot = { ...PRESET, tools: ["read"], contextWindow: 100_000 };
const NEW: PresetSnapshot = { ...P, model: "faux/other", prompt: "新提示词。", tools: ["read", "memory"], contextWindow: 64_000, input: ["text", "image"] };
const rc = (preset: PresetSnapshot): Extract<Input, { kind: "reconfigure" }> => ({ kind: "reconfigure", preset });
const model = (n: number, message: ReturnType<typeof say>): Input => ({ kind: "modelResult", n, outcome: { status: "ok", message } });
const views = (memory: ReturnType<typeof fakeMemory>) => memory.calls.filter((c) => c === "view").length;

function drain(db: DatabaseSync, memory: Memory): void {
  while (handleNext(db, memory, 1)) continue;
}

/** 一轮正常结束、段里有助手消息的空闲进程 a。 */
function idleWithReply(db: DatabaseSync, memory: Memory, preset = P): void {
  startProcess(db, memory, "a", preset, "你好", 0);
  drain(db, memory);
  putMail(db, "a", model(1, say("好的")));
  drain(db, memory);
  assert.deepEqual(loadProcess(db, "a")?.phase, { tag: "idle", ended: "done" });
}

/** 段里没有助手消息的空闲进程 a：这一轮被停止了。 */
function idleWithoutReply(db: DatabaseSync, memory: Memory, preset = P): void {
  startProcess(db, memory, "a", preset, "你好", 0);
  drain(db, memory);
  send(db, "a", { kind: "stop" });
  drain(db, memory);
  assert.deepEqual(loadProcess(db, "a")?.phase, { tag: "idle", ended: "stopped" });
}

/** 进程在等的副作用编号：库里只有一行 pending 的副作用。 */
function waitingFor(db: DatabaseSync): number {
  const rows = effectRows(db);
  assert.equal(rows.length, 1);
  return rows[0]!.n;
}

const marked = { ...userLetter("换段后处理"), letter: { ...userLetter("换段后处理").letter, handoff: true as const } };

test("reconfigure 事务：send 只把它放进信箱，进程记录不动；进程不存在时报错，什么都不写", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  idleWithReply(db, memory);
  const before = loadProcess(db, "a");
  send(db, "a", rc(NEW));
  assert.deepEqual(mailbox(db), [{ id: "a", input: rc(NEW) }]);
  assert.deepEqual(loadProcess(db, "a"), before);
  assert.throws(() => send(db, "nope", rc(NEW)), /没有这个进程/);
  assert.equal(mailbox(db).length, 1);
  assertStoreInvariants(db);
});

test("处理 reconfigure：不写消息、不动副作用表；结构性字段存进 next，调用参数立即换", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  idleWithReply(db, memory);
  const seg = loadSegment(db, loadProcess(db, "a")!);
  send(db, "a", rc({ ...NEW, thinking: "high", handoff: 20_000 }));
  const h = handleNext(db, memory, 5);
  assert.equal(h?.abort, null);
  assert.deepEqual(h?.appended.messages, []);
  assert.deepEqual(mailbox(db), []);
  assert.deepEqual(effectRows(db), []);
  const p = loadProcess(db, "a")!;
  assert.deepEqual(p.next, { ...NEW, thinking: "high", handoff: 20_000 });
  assert.deepEqual(p.preset, { ...P, thinking: "high", handoff: 20_000 });
  assert.deepEqual(loadSegment(db, p), seg);
  assertStoreInvariants(db);
});

test("进程在跑时改调用参数：已发出的请求和副作用编号不变，下一次调用起用新值", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  let calls = 0;
  const actions = gated(
    () => (calls++ === 0 ? use(toolCall("c1", "read", { path: "a" })) : say("完")),
    (_job, call) => ({ content: [{ type: "text", text: `out:${call.id}` }], isError: false }),
  );
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "a", P, "你好", 0);
  handleNext(db, memory, 0);
  const done = exec.startNext();
  assert.ok(done);
  assert.deepEqual(effectRows(db), [{ id: "a", n: 1, status: "running" }]);
  send(db, "a", rc({ ...P, thinking: "high", options: { temperature: 0.1 } }));
  const h = handleNext(db, memory, 1);
  assert.equal(h?.abort, null, "改调用参数不中止在途的调用");
  assert.deepEqual(effectRows(db), [{ id: "a", n: 1, status: "running" }]);
  assert.equal(loadProcess(db, "a")?.phase.tag, "awaitingModel");
  assert.equal(loadProcess(db, "a")?.lastEffect, 1);
  actions.gates[0]!.finish();
  await done;
  await settle(db, memory, exec, actions.gates);
  assert.deepEqual(loadProcess(db, "a")?.phase, { tag: "idle", ended: "done" });
  const jobs = actions.gates.map((g) => g.job);
  assert.equal(jobs[0]!.process.preset.thinking, undefined, "第一次调用是在改之前拿的记录");
  assert.ok(jobs.length >= 3);
  for (const job of jobs.slice(1)) assert.deepEqual([job.process.preset.thinking, job.process.preset.options], ["high", { temperature: 0.1 }]);
  assertStoreInvariants(db);
});

test("空闲、段里没有助手消息：直接采用，两个视图在这个事务里读；之后的输入不再读", (t) => {
  const db = tempDb(t);
  const dir = tempDir(t);
  const work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "AGENTS.md"), "规矩一");
  const memory = fakeMemory();
  memory.set("helper", "k", "v", null);
  idleWithoutReply(db, memory);
  assert.equal(loadProcess(db, "a")?.segment.memoryView, "", "旧快照没有 memory 工具");
  send(db, "a", rc({ ...NEW, workdir: work, context: ["AGENTS.md"] }));
  memory.calls.length = 0;
  handleNext(db, memory, 5);
  const p = loadProcess(db, "a")!;
  assert.deepEqual(p.preset, { ...NEW, workdir: work, context: ["AGENTS.md"] });
  assert.equal("next" in p, false);
  assert.equal(p.segment.seq, 1);
  assert.equal(p.segment.memoryView, "k: v");
  assert.match(p.segment.contextView ?? "", /AGENTS\.md[\s\S]*规矩一/);
  assert.equal(views(memory), 1, "给新快照读了一次记忆视图");
  assertStoreInvariants(db);
});

test("fresh 只在该算的时候算：reconfigure 和接受交接的那条模型结果；别的输入不读记忆视图也不读文件", (t) => {
  const db = tempDb(t);
  const dir = tempDir(t);
  const work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "AGENTS.md"), "旧内容");
  const memory = fakeMemory();
  memory.set("helper", "k", "v", null);
  // 旧快照没有 memory 工具：处理输入的 envFor 不读记忆视图，所以读到的每一次都是 fresh 的。
  idleWithReply(db, memory);
  const next = { ...NEW, workdir: work, context: ["AGENTS.md"] };
  memory.calls.length = 0;
  send(db, "a", rc(next));
  handleNext(db, memory, 2);
  assert.equal(views(memory), 1, "reconfigure：算一次");
  assert.deepEqual(loadProcess(db, "a")?.next, next);
  writeFileSync(join(work, "AGENTS.md"), "新内容");

  // 一轮普通的对话：信、模型结果、工具调用和结果。不算 fresh。
  send(db, "a", userLetter("读一下"));
  drain(db, memory);
  putMail(db, "a", model(waitingFor(db), use(toolCall("c1", "read", { path: "x" }))));
  drain(db, memory);
  putMail(db, "a", { kind: "toolResult", n: waitingFor(db), outcome: { status: "ok", content: { content: [{ type: "text", text: "内容" }], isError: false } } });
  drain(db, memory);
  putMail(db, "a", model(waitingFor(db), say("读完了")));
  drain(db, memory);
  assert.deepEqual(loadProcess(db, "a")?.phase, { tag: "idle", ended: "done" });
  send(db, "a", { kind: "stop" });
  drain(db, memory);
  assert.equal(views(memory), 1, "这些输入都不算 fresh");
  const mid = loadProcess(db, "a")!;
  assert.deepEqual(mid.next, next, "待换配置原样在");
  assert.equal(mid.segment.contextView, undefined, "当前段的上下文视图是开段时的，不重读");

  // 换段：交接请求的模型结果被接受，才给 next 算一次。
  send(db, "a", marked);
  drain(db, memory);
  const phase = loadProcess(db, "a")!.phase;
  assert.ok(phase.tag === "awaitingModel" && phase.purpose === "handoff", JSON.stringify(phase));
  const calls = views(memory);
  putMail(db, "a", model(waitingFor(db), say("交接说明")));
  drain(db, memory);
  assert.equal(views(memory), calls + 1, "接受交接：算一次");
  const p = loadProcess(db, "a")!;
  assert.equal(p.segment.seq, 2);
  assert.deepEqual(p.preset, next);
  assert.equal("next" in p, false);
  assert.equal(p.segment.memoryView, "k: v");
  assert.match(p.segment.contextView ?? "", /AGENTS\.md[\s\S]*新内容/);
  assertStoreInvariants(db);
});

test("没有待换配置的换段：上下文视图重读，快照不变", (t) => {
  const db = tempDb(t);
  const dir = tempDir(t);
  const work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "AGENTS.md"), "第一版");
  const memory = fakeMemory();
  const preset = { ...P, workdir: work, context: ["AGENTS.md"] };
  idleWithReply(db, memory, preset);
  assert.match(loadProcess(db, "a")?.segment.contextView ?? "", /第一版/);
  writeFileSync(join(work, "AGENTS.md"), "第二版");
  send(db, "a", marked);
  drain(db, memory);
  assert.match(loadProcess(db, "a")?.segment.contextView ?? "", /第一版/, "换段以前还是开段时的");
  putMail(db, "a", model(waitingFor(db), say("交接说明")));
  drain(db, memory);
  const p = loadProcess(db, "a")!;
  assert.equal(p.segment.seq, 2);
  assert.deepEqual(p.preset, preset);
  assert.match(p.segment.contextView ?? "", /第二版/);
  assert.doesNotMatch(p.segment.contextView ?? "", /第一版/);
});

test("freshFor：只对 reconfigure 和接受交接的模型结果返回视图；有 next 给 next 算，没有给 preset 算", () => {
  const memory = fakeMemory();
  memory.set("helper", "k", "v", null);
  const idle = start("a", { ...P, tools: ["read", "memory"] }, { now: 0, memoryView: "" });
  const handing = (over: Partial<Process> = {}): Process => ({ ...idle, lastEffect: 3, phase: { tag: "awaitingModel", purpose: "handoff", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } }, ...over });
  const ok = (n: number): Input => model(n, say("交接说明"));
  memory.calls.length = 0;

  assert.equal(freshFor(memory, idle, userLetter("hi"), 0), undefined);
  assert.equal(freshFor(memory, idle, { kind: "stop" }, 0), undefined);
  assert.equal(freshFor(memory, handing(), { kind: "toolResult", n: 3, outcome: { status: "interrupted" } }, 0), undefined);
  const turn = handing({ phase: { tag: "awaitingModel", purpose: "turn", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } });
  assert.equal(freshFor(memory, turn, ok(3), 0), undefined, "用途是 turn 的模型结果不算");
  assert.equal(freshFor(memory, handing(), ok(2), 0), undefined, "编号不对的被丢弃，不算");
  assert.equal(freshFor(memory, handing(), { kind: "modelResult", n: 3, outcome: { status: "interrupted" } }, 0), undefined, "被中断的不算");
  assert.equal(freshFor(memory, idle, ok(3), 0), undefined, "不在等模型");
  assert.equal(views(memory), 0, "上面都没有读记忆视图");

  assert.deepEqual(freshFor(memory, idle, rc({ ...P, tools: ["read", "memory"] }), 0), { memoryView: "k: v", contextView: "" });
  assert.deepEqual(freshFor(memory, idle, rc(P), 0), { memoryView: "", contextView: "" }, "没有 memory 工具时记忆视图为空");
  assert.deepEqual(freshFor(memory, handing(), ok(3), 0), { memoryView: "k: v", contextView: "" }, "没有 next：给 preset 算");
  assert.deepEqual(freshFor(memory, handing({ next: P }), ok(3), 0), { memoryView: "", contextView: "" }, "有 next：给 next 算");
  assert.equal(views(memory), 2, "只有带 memory 工具的快照读记忆视图");
});

test("换段采用 next：新快照、视图、下一次调用的记录都是新的；next 去掉", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  memory.set("helper", "k", "v", null);
  idleWithReply(db, memory);
  send(db, "a", rc(NEW));
  send(db, "a", marked);
  drain(db, memory);
  assert.deepEqual(loadProcess(db, "a")?.next, NEW);
  const jobs: Process[] = [];
  const exec = createExecutor(db, {
    callModel: async (job) => {
      jobs.push(job.process);
      return job.effect.kind === "callModel" && job.effect.purpose === "handoff" ? say("交接说明") : say("新段里的回复");
    },
    runTool: async () => ({ content: [], isError: false }),
  });
  await settle(db, memory, exec);
  const p = loadProcess(db, "a")!;
  assert.deepEqual(p.phase, { tag: "idle", ended: "done" });
  assert.equal(p.segment.seq, 2);
  assert.deepEqual(p.preset, NEW);
  assert.equal("next" in p, false);
  assert.equal(p.segment.memoryView, "k: v");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.preset.prompt, P.prompt, "交接调用拿着旧快照");
  assert.equal(jobs[1]!.preset.prompt, "新提示词。", "新段里的调用拿着新快照");
  assert.equal(jobs[1]!.segment.memoryView, "k: v");
  assertStoreInvariants(db);
});

test("采用 next 的检查不通过：丢掉它，进程回到旧快照，不卡住信箱", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  idleWithReply(db, memory);
  send(db, "a", rc({ ...NEW, contextWindow: 28_000 }));
  send(db, "a", marked);
  drain(db, memory);
  putMail(db, "a", model(waitingFor(db), say("交接说明")));
  drain(db, memory);
  const p = loadProcess(db, "a")!;
  assert.equal(p.phase.tag, "idle");
  assert.ok(p.phase.tag === "idle" && typeof p.phase.ended === "object" && p.phase.ended.error.endsWith("；待换的配置已丢弃"));
  assert.equal("next" in p, false);
  assert.deepEqual(p.preset, P);
  assert.equal(p.segment.seq, 1);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

test("崩溃：信箱里的 reconfigure 照常处理（事务要么提交了要么没有）", (t) => {
  const dbs: DatabaseSync[] = [];
  const dir = tempDir(t, dbs);
  const path = join(dir, "tau.db");
  const memory = fakeMemory();
  const db = openDb(path);
  dbs.push(db);
  idleWithReply(db, memory);
  send(db, "a", rc({ ...P, thinking: "low" }));
  send(db, "a", rc(NEW));
  db.close();

  const again = openDb(path);
  dbs.push(again);
  assert.deepEqual(mailbox(again).map((m) => m.input.kind), ["reconfigure", "reconfigure"]);
  assertStoreInvariants(again);
  drain(again, memory);
  const p = loadProcess(again, "a")!;
  assert.deepEqual(mailbox(again), []);
  assert.deepEqual(p.next, NEW);
  assert.equal(p.preset.thinking, undefined, "后处理的赢：第二条没有 thinking，调用参数跟着它");
  assertStoreInvariants(again);
});

test("崩溃：一条 reconfigure 的事务中途失败，整个回滚，信箱里的它还在", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  idleWithReply(db, memory);
  send(db, "a", rc(NEW));
  const before = loadProcess(db, "a");
  // 记忆视图读失败：handleNext 的事务整个回滚，输入留在信箱。
  const broken: Memory = { ...memory, view: () => { throw new Error("坏了"); } };
  assert.throws(() => handleNext(db, broken, 3), /坏了/);
  assert.deepEqual(loadProcess(db, "a"), before);
  assert.deepEqual(mailbox(db), [{ id: "a", input: rc(NEW) }]);
  handleNext(db, memory, 3);
  assert.deepEqual(loadProcess(db, "a")?.next, NEW);
});

test("self：有待换配置时多一行，写明哪些字段、换段时生效；没有时没有这一行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  idleWithReply(db, memory);
  const text = (): string => {
    const p = loadProcess(db, "a")!;
    return plain(tx(db, () => runInStore(db, memory, p, loadSegment(db, p), toolCall("c", "self"), 10_000))).text;
  };
  assert.doesNotMatch(text(), /待换配置/);
  send(db, "a", rc(NEW));
  drain(db, memory);
  const lines = text().split("\n");
  const at = lines.findIndex((l) => l.startsWith("换段阈值："));
  assert.equal(lines[at + 1], "待换配置：model、prompt、tools（换段时生效）");
  assert.ok(lines[at + 2]?.startsWith("累计用量："));
  // 只改调用参数：没有 next，没有这一行。
  send(db, "a", rc({ ...P, thinking: "high" }));
  drain(db, memory);
  assert.doesNotMatch(text(), /待换配置/);
});
