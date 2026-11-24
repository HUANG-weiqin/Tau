// D109 对进程之间的工具和 handoff、self 的兜底：带参数的 handoff 照做；没有进程、写给自己的话给出能照抄的下一步。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Actions } from "../../src/executor/executor.ts";
import { start } from "../../src/kernel/decide.ts";
import type { PresetSnapshot, Process } from "../../src/kernel/types.ts";
import { loadProcess, tx } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { runInStore } from "../../src/store/instore.ts";
import { fakeMemory, mailbox, PRESET, say, settle, tempDb, toolCall, use } from "./fixtures.ts";
import type { FakeMemory } from "./fixtures.ts";
import { res, plain } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

const BOSS: PresetSnapshot = { ...PRESET, id: "boss", tools: ["agents", "memory"] };
const KID: PresetSnapshot = { ...PRESET, id: "kid", tools: ["read"] };
const readPreset = (id: string): PresetSnapshot => {
  if (id === "kid") return KID;
  throw new Error(`找不到预设：${id}`);
};

function asking(db: DatabaseSync, memory: FakeMemory, over: Partial<Process> = {}, replyTo: string[] = []): Process {
  startProcess(db, memory, "a", BOSS, "开始", 0);
  db.exec("DELETE FROM mailbox");
  return { ...loadProcess(db, "a")!, lastEffect: 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo } }, ...over };
}
const run = (db: DatabaseSync, memory: FakeMemory, p: Process, name: string, args: Parameters<typeof toolCall>[2]) => plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", name, args), 0, readPreset)));

test("handoff 带了参数：照做换段，结果加注；以前这样的调用一直被拒，模型重发到步数上限", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  let calls = 0;
  const actions: Actions = {
    async callModel(job) {
      calls++;
      if (calls > 20) throw new Error("打转了");
      return job.effect.kind === "callModel" && job.effect.purpose === "handoff" ? say("交接说明") : job.process.segment.seq === 1 ? use(toolCall("h", "handoff", { summary: "做到第 3 步" })) : say("好");
    },
    async runTool() {
      return res("");
    },
  };
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", PRESET, "开始", 0);
  await settle(db, memory, exec);
  const p = loadProcess(db, "p1")!;
  assert.equal(p.segment.seq, 2, "换到了第 2 段");
  assert.equal(calls, 3, "模型只被调用 3 次");
  assert.deepEqual(p.phase, { tag: "idle", ended: "done" });
  assertStoreInvariants(db);
});

test("self、handoff 的结果加注：多余的参数丢掉；参数的 JSON 坏了照常执行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  assert.deepEqual(run(db, memory, p, "handoff", { summary: "总结" }), { text: "将在这批工具结果之后换段。\n注：没用上参数 summary。", isError: false });
  assert.match(run(db, memory, p, "self", { verbose: true }).text, /\n注：没用上参数 verbose。$/);
  const broken = { type: "toolCall", id: "c", name: "handoff", arguments: {}, argumentsError: "Tool arguments must be a JSON object" } as never;
  assert.deepEqual(plain(tx(db, () => runInStore(db, memory, p, [], broken, 0))), { text: "将在这批工具结果之后换段。\n注：参数不是合法的 JSON，没用上。", isError: false });
});

test("post 的 reply 认 yes、1、True；多余的、对不上别名的参数拒绝，什么都不寄", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const p = asking(db, memory);
  db.exec("DELETE FROM mailbox");
  assert.equal(run(db, memory, p, "post", { to: "b", text: "x", reply: "Yes" }).isError, false);
  assert.equal(run(db, memory, p, "post", { to: "b", text: "x", reply: 1 }).isError, false);
  assert.deepEqual(mailbox(db).map((m) => m.input.kind === "letter" && m.input.letter.replyTo), ["a", "a"]);
  db.exec("DELETE FROM mailbox");
  assert.match(run(db, memory, p, "post", { to: "b", subject: "周报" }).text, /^参数错误：不认识参数 subject；缺少 text。/);
  assert.match(run(db, memory, p, "post", { to: "b", text: "x", replyTo: "a" }).text, /^参数错误：不认识参数 replyTo。post 的参数：/);
  assert.deepEqual(run(db, memory, p, "post", { to: "b", message: "hi" }), { text: "已寄给 b。\n注：参数 message 当作 text。", isError: false });
  assert.deepEqual(mailbox(db).length, 1);
});

test("没有这个进程：说要写进程 ID、去哪找；post 有父进程时给出父进程 ID，stop_process 不给", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  const base = "没有进程 \"chief\"。这里写进程 ID，不是预设名，也不带“进程”二字：信头“（来自进程 X，预设 Y）”和 spawn 的结果“已建进程 X”里的 X。self 只列同预设、同工作目录和你的子进程里正在运行的那些。";
  assert.deepEqual(run(db, memory, p, "post", { to: "chief", text: "x" }), { text: base, isError: true });
  assert.deepEqual(run(db, memory, { ...p, parent: "boss1" }, "post", { to: "chief", text: "x" }), { text: `${base}你的父进程是 boss1。`, isError: true });
  assert.deepEqual(run(db, memory, { ...p, parent: "boss1" }, "stop_process", { process: "chief" }), { text: base, isError: true });
  assert.deepEqual(mailbox(db), []);
});

test("post 写给自己：有进程在等回信就说是谁、直接回复；没人在等就说寄给别的进程要写它的 ID", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const alone = asking(db, memory);
  const waiting = { ...alone, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: ["c0ffee01"] } } } as Process;
  assert.deepEqual(run(db, memory, waiting, "post", { to: "a", text: "x" }), { text: "不能给自己寄信（a 是你自己）。等你回信的是 c0ffee01：直接写最终回复、结束这一轮，回信会自动寄出。", isError: true });
  assert.deepEqual(run(db, memory, alone, "post", { to: "a", text: "x" }), { text: "不能给自己寄信（a 是你自己）。现在没有进程在等你回信；要寄给别的进程，to 写它的进程 ID。", isError: true });
  assert.deepEqual(mailbox(db), []);
});

test("spawn 的预设通不过启动检查：说清再调用也一样", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  const tiny: PresetSnapshot = { ...KID, contextWindow: 1_000 };
  const r = plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", { preset: "kid", text: "x" }), 0, () => tiny)));
  assert.equal(r.isError, true);
  assert.match(r.text, /。原样再调用结果一样：换一个预设或 workdir，或者在回复里说明建不了。$/);
  assert.deepEqual(mailbox(db), []);
});

test("spawn 缺 text、给了 prompt（Claude Code 的写法）：按别名照做", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  const r = run(db, memory, p, "spawn", { preset: "kid", prompt: "开工" });
  assert.equal(r.isError, false);
  assert.match(r.text, /\n注：参数 prompt 当作 text。$/);
  assert.deepEqual(start("x", KID, { now: 0, memoryView: "" }).preset.id, "kid");
});
