// 设计稿第 6 节：执行器的开始、完成、中止、失败上报、启动恢复，以及执行清单第 2 步的竞态。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { createActions } from "../../src/executor/actions.ts";
import { createExecutor } from "../../src/executor/executor.ts";
import { start } from "../../src/kernel/decide.ts";
import { clip } from "../../src/kernel/derive.ts";
import { userLetter } from "../../src/kernel/types.ts";
import type { Message, PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { loadProcess, loadSegment, openDb } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { effectRows, fakeMemory, gated, mailbox, PRESET, say, scripted, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import type { Gate } from "./fixtures.ts";
import { plain, res } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

const okTool = () => res("ok");

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
  send(db, "p1", userLetter("插一句"));
  await finishLast(actions.gates, tool);
  assert.deepEqual(mailbox(db).map((m) => m.input.kind), ["letter", "toolResult"]);
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
  const actions = gated(() => (replies++ === 0 ? use(toolCall("c1", "memory_set", { key: "k", value: "v", brief: "摘要" })) : say("好")), okTool);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "a", 0);
  handleNext(db, memory, 0);
  await finishLast(actions.gates, exec.startNext());
  send(db, "p1", userLetter("插一句"));
  handleNext(db, memory, 0); // 模型结果：在事务里执行 memory_set
  assert.deepEqual(mailbox(db).map((m) => m.input.kind), ["letter", "toolResult"]);
  handleNext(db, memory, 0); // 用户消息：排队，编号不变
  assert.deepEqual(effectRows(db), []);
  assert.equal(memory.calls.filter((c) => c === "set").length, 1);
  assertStoreInvariants(db);
  await settle(db, memory, exec, actions.gates);
  assert.equal(memory.calls.filter((c) => c === "set").length, 1);
  assert.deepEqual(loadProcess(db, "p1")?.phase, { tag: "idle", ended: "done" });
});

test("调用模型时 maxTokens 取模型的上限和窗口的 1/8 中较小的，交接调用也一样", async () => {
  const cases: [number, number][] = [
    [65_536, 8_192],
    [64_000, 8_192],
    [128_000, 16_384],
    [200_000, 64_000],
    [1_000_000, 128_000],
    [1_048_576, 65_536],
  ];
  const faux = fauxProvider({ models: cases.map(([w, m]) => ({ id: `m${w}`, contextWindow: w, maxTokens: m })) });
  const models = createModels();
  models.setProvider(faux.provider);
  const actions = createActions(models, () => {}, "test-pipe", () => undefined);
  const segment: Message[] = [{ role: "user", content: "你好", timestamp: 0 }];
  for (const [w, m] of cases) {
    for (const purpose of ["turn", "handoff"] as const) {
      let seen: number | undefined;
      faux.setResponses([
        (_context, options) => {
          seen = options?.maxTokens;
          return fauxAssistantMessage("好");
        },
      ]);
      const preset = { ...PRESET, model: `${faux.getModel().provider}/m${w}`, contextWindow: w };
      const process: Process = { ...start("p1", preset, { now: 0, memoryView: "" }), lastEffect: 1, phase: { tag: "awaitingModel", turn: { steps: 1, queued: [], hops: 0, replyTo: [] }, purpose } };
      await actions.callModel({ process, segment, effect: { kind: "callModel", n: 1, purpose } }, new AbortController().signal);
      assert.equal(seen, Math.min(m, Math.floor(w / 8)), `${w}/${m}，${purpose}`);
    }
  }
});

test("库外工具的 null 参数：可选当作没填，必填报错，不会把 \"null\" 写进文件", async (t) => {
  const workdir = tempDir(t);
  const preset: PresetSnapshot = { ...PRESET, workdir, tools: ["read", "write", "edit"] };
  const process: Process = start("p1", preset, { now: 0, memoryView: "" });
  const actions = createActions(createModels(), () => {}, "test-pipe", () => undefined);
  const run = async (name: string, args: JsonObject) => {
    const call = toolCall("c1", name, args);
    return plain(await actions.runTool({ process, segment: [], effect: { kind: "runTool", n: 1, call } }, call, new AbortController().signal, new AbortController().signal));
  };
  assert.deepEqual(await run("edit", { path: "a.txt", old: "x", new: null }), { text: '参数错误：new 是 null，必填（空的写 ""）。edit 的参数：path（字符串，必填）、old（字符串，必填）、new（字符串，必填）、replaceAll（布尔值，可选）。照这样调用：edit({"path": …, "old": …, "new": …})', isError: true });
  assert.deepEqual(await run("write", { path: "a.txt", content: 123 }), { text: `已写入 3 字节：${join(workdir, "a.txt").replaceAll("\\", "/")}`, isError: false }, "数字和布尔照旧转成字符串");
  assert.equal(await readFile(join(workdir, "a.txt"), "utf8"), "123");
  assert.deepEqual(await run("read", { path: "a.txt", offset: null }), { text: "     1\t123", isError: false }, "可选的 null 当作没填");
  assert.deepEqual(await run("bash", { command: "ls" }), { text: '工具 "bash" 不存在，或者预设里没有它。可用的工具：read、write、edit、self、handoff。工具名要从这里照抄，一字不差。列表外的工具都调不通，不要再调用它。要结束这一轮或者提问，直接写回复，不调用工具。', isError: true }, "不认识的工具名带上能用的");
});

test("路径的说明接在结果最后一行，和工具名的说明合成一行；干净的调用没有注；截断不被说明挤坏（D109）", async (t) => {
  const workdir = tempDir(t);
  const preset: PresetSnapshot = { ...PRESET, workdir, tools: ["read", "write", "edit"] };
  const process: Process = start("p1", preset, { now: 0, memoryView: "" });
  const actions = createActions(createModels(), () => {}, "test-pipe", () => undefined);
  const run = async (name: string, args: JsonObject) => {
    const call = toolCall("c1", name, args);
    return plain(await actions.runTool({ process, segment: [], effect: { kind: "runTool", n: 1, call } }, call, new AbortController().signal, new AbortController().signal));
  };
  const a = join(workdir, "a.txt").replaceAll("\\", "/");
  await run("write", { path: "a.txt", content: "123" });
  assert.deepEqual(await run("read", { path: " a.txt" }), { text: `     1	123
注：路径 " a.txt" 当作 ${a}。`, isError: false });
  assert.deepEqual(await run("Read", { path: " a.txt" }), { text: `     1	123
注：工具名 "Read" 当作 read；路径 " a.txt" 当作 ${a}。`, isError: false });
  assert.deepEqual(await run("read", { path: "a.txt", offset: 0 }), { text: "     1	123", isError: false }, "offset 0 不加说明");
  const nope = await run("read", { path: "'nope.txt'" });
  assert.equal(nope.isError, true);
  assert.ok(nope.text.split("\n").at(-1)!.startsWith(`注：路径 "'nope.txt'" 当作 `), nope.text);
  for (const r of [await run("read", { path: "a.txt" }), await run("write", { path: "b.txt", content: "x" }), await run("edit", { path: "a.txt", old: "123", new: "456" })]) assert.doesNotMatch(r.text, /注：/);
  // 2 万行的文件，路径带空白：段里（decide 的 clip）只有一个“中间省略”标记，说明还在最后一行。
  await run("write", { path: "big.log", content: Array.from({ length: 20_000 }, (_, i) => `line ${i} 中文`).join("\n") });
  const big = (await run("read", { path: " big.log" })).text;
  assert.equal(clip(big), big);
  assert.equal(big.match(/中间省略/g)?.length, 1);
  assert.ok(big.split("\n").at(-1)!.startsWith("注：路径 "));
});

test("库外工具的参数整体是 null（pi-ai 解析流式 JSON 'null' 的结果）：回参数错误，不是执行失败", async () => {
  const process: Process = start("p1", PRESET, { now: 0, memoryView: "" });
  const actions = createActions(createModels(), () => {}, "test-pipe", () => undefined);
  const call = { type: "toolCall", id: "c1", name: "read", arguments: null } as unknown as ToolCall;
  const got = plain(await actions.runTool({ process, segment: [], effect: { kind: "runTool", n: 1, call } }, call, new AbortController().signal, new AbortController().signal));
  assert.equal(got.isError, true);
  assert.match(got.text, /^参数错误：/);
});

// D104：催。执行器给每个运行中的副作用一个催的开关；hurry(id, n) 拨它；开始时进程已有排队的信就是催过的。
function toolWorld(t: Parameters<typeof tempDb>[0]) {
  const db = tempDb(t);
  const memory = fakeMemory();
  const hurries: AbortSignal[] = [];
  const finishers: (() => void)[] = [];
  const exec = createExecutor(db, {
    callModel: async () => use(toolCall("c1", "read", { path: "a" })),
    runTool: (_job, _call, _signal, hurry) =>
      new Promise((resolve) => {
        hurries.push(hurry);
        finishers.push(() => resolve(okTool()));
      }),
  });
  return { db, memory, exec, hurries, finishers };
}

/** 跑到工具的副作用在等开始：模型回复已处理。 */
async function toToolEffect(w: ReturnType<typeof toolWorld>): Promise<void> {
  startProcess(w.db, w.memory, "p1", PRESET, "a", 0);
  handleNext(w.db, w.memory, 0);
  await w.exec.startNext();
  handleNext(w.db, w.memory, 0);
}

test("催：hurry(id, n) 拨到运行中的工具的开关；别的 n 和不在运行的什么都不做；busy 不受影响", async (t) => {
  const w = toolWorld(t);
  await toToolEffect(w);
  const done = w.exec.startNext();
  assert.equal(w.hurries.length, 1);
  assert.equal(w.hurries[0]?.aborted, false, "进程没有排队的信，开始时不催");
  w.exec.hurry("p1", 99);
  w.exec.hurry("nobody", 2);
  assert.equal(w.hurries[0]?.aborted, false);
  assert.equal(w.exec.busy("p1"), true);
  w.exec.hurry("p1", 2);
  assert.equal(w.hurries[0]?.aborted, true);
  assert.equal(w.exec.busy("p1"), true, "催了不改 busy");
  w.finishers[0]?.();
  await done;
  assert.equal(w.exec.busy("p1"), false);
  w.exec.hurry("p1", 2); // 已经结束：不抛错
});

test("催：开始时进程已经有排队的信，开关一开始就是催过的", async (t) => {
  const w = toolWorld(t);
  await toToolEffect(w);
  send(w.db, "p1", userLetter("插话"));
  handleNext(w.db, w.memory, 0);
  assert.equal(loadProcess(w.db, "p1")?.phase.tag, "awaitingTool");
  const done = w.exec.startNext();
  assert.equal(w.hurries[0]?.aborted, true);
  w.finishers[0]?.();
  await done;
});
