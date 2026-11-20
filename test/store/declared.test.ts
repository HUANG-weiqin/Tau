// D64 第 10 组：工具定义在结果里声明库内动作。handleNext 在 decide 之前、同一个事务里执行；永不抛错。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Actions } from "../../src/executor/executor.ts";
import { textContent } from "../../src/kernel/types.ts";
import type { Input, PresetSnapshot, ToolResultContent } from "../../src/kernel/types.ts";
import { loadProcess, loadProcesses, openDb, putMail } from "../../src/store/db.ts";
import { handleNext, removeProcess, send, startProcess } from "../../src/store/inputs.ts";
import { spawnId } from "../../src/store/instore.ts";
import { allMessages, effectRows, fakeMemory, mailbox, PRESET, say, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import type { FakeMemory } from "./fixtures.ts";
import { textOfResult } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

/** 预设里没有 agents，也没有 memory：声明照样执行。 */
const DECL: PresetSnapshot = { ...PRESET, id: "boss", tools: ["read"], toolDefs: [{ name: "decl", description: "声明动作", parameters: { type: "object" }, command: "x", timeout: 60, output: "content" }] };
const KID: PresetSnapshot = { ...PRESET, id: "kid", tools: ["read"] };
const readPreset = (id: string): PresetSnapshot => {
  if (id === "kid") return KID;
  throw new Error(`找不到预设：${id}`);
};

type Declared = { name: string; arguments: Record<string, unknown> };
const call = (name: string, args: Record<string, unknown> = {}): Declared => ({ name, arguments: args });

/** 让进程 `id` 停在等工具：第一轮模型回复调用 decl。返回这次的副作用编号。库里的 effects 行已删（像执行器完成了它）。 */
function waiting(db: DatabaseSync, memory: FakeMemory, id = "boss", preset = DECL): number {
  startProcess(db, memory, id, preset, "开始", 0);
  handleNext(db, memory, 0);
  putMail(db, id, { kind: "modelResult", n: 1, outcome: { status: "ok", message: use(toolCall("c1", "decl")) } });
  handleNext(db, memory, 0);
  const p = loadProcess(db, id)!;
  assert.equal(p.phase.tag, "awaitingTool");
  db.prepare("DELETE FROM effects WHERE process_id = ?").run(id);
  return p.lastEffect;
}

const result = (n: number, calls: Declared[] | undefined, content: ToolResultContent = { content: textContent("ok"), isError: false }): Input => ({ kind: "toolResult", n, outcome: { status: "ok", content, ...(calls ? { calls } : {}) } });

/** 处理一条输入，返回这个进程段里最后一条工具结果的文本和 isError。 */
function handleResult(db: DatabaseSync, memory: FakeMemory, id: string, input: Input) {
  putMail(db, id, input);
  const h = handleNext(db, memory, 5, readPreset);
  assert.ok(h);
  const m = h.segment.findLast((x) => x.role === "toolResult");
  assert.ok(m && m.role === "toolResult");
  return { text: textOfResult({ content: m.content, isError: m.isError }), isError: m.isError, h };
}

const FROM = { kind: "process", id: "boss", preset: "boss" };

test("没有声明：结果照旧，不读也不写别的东西", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, undefined));
  assert.deepEqual({ text: r.text, isError: r.isError }, { text: "ok", isError: false });
  assert.deepEqual(memory.calls.filter((c) => c !== "view"), []);
});

test("post：信和工具结果同一个事务；发信人是这个进程，跳数是这一轮加一，reply 带 replyTo；文字接在工具文本后面、隔一个空行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("post", { to: "b", text: "几点", reply: true }), call("post", { to: "b", text: "随便" })]));
  assert.deepEqual(r.text, "ok\n\n[post] 已寄给 b。它处理这封信的那一轮结束时会给你回信，之后的几轮不会。\n\n[post] 已寄给 b。");
  assert.equal(r.isError, false);
  const letters = mailbox(db).filter((m) => m.input.kind === "letter");
  assert.deepEqual(letters.map((m) => m.input), [
    { kind: "letter", letter: { from: FROM, content: textContent("几点"), hops: 1, replyTo: "boss" } },
    { kind: "letter", letter: { from: FROM, content: textContent("随便"), hops: 1 } },
  ]);
  assertStoreInvariants(db);
});

test("工具自己没有文本时，声明的结果成为唯一的文本块；图片块留在后面", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  const n = waiting(db, memory);
  const content: ToolResultContent = { content: [{ type: "image", data: "blob:" + "a".repeat(64), mimeType: "image/png" }], isError: false };
  putMail(db, "boss", result(n, [call("stop_process", { process: "b" })], content));
  const h = handleNext(db, memory, 5, readPreset)!;
  const m = h.segment.findLast((x) => x.role === "toolResult")!;
  assert.ok(m.role === "toolResult");
  assert.deepEqual(m.content.map((c) => c.type), ["text", "image"]);
  assert.equal(textOfResult({ content: m.content, isError: false }), "[stop_process] 已给 b 发出停止。");
});

test("spawn：ID 照常算；同一批的几个 spawn 靠尝试次数区分；子进程的 parent 和回信对象是这个进程", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("spawn", { preset: "kid", text: "甲" }), call("spawn", { preset: "kid", text: "乙" })]));
  const ids = [spawnId("boss", n, 0), spawnId("boss", n, 1)];
  assert.notEqual(ids[0], ids[1]);
  assert.equal(r.isError, false);
  assert.match(r.text, new RegExp(`\\[spawn\\] 已建进程 ${ids[0]}，预设 kid。[^\\n]*\\n\\n\\[spawn\\] 已建进程 ${ids[1]}，预设 kid。`));
  const kids = loadProcesses(db).filter((p) => p.parent === "boss");
  assert.deepEqual(kids.map((k) => k.id).sort(), [...ids].sort());
  const letters = mailbox(db).filter((m) => m.input.kind === "letter");
  assert.deepEqual(letters.map((m) => [m.id, m.input.kind === "letter" && m.input.letter.replyTo, m.input.kind === "letter" && m.input.letter.hops]), [[ids[0], "boss", 1], [ids[1], "boss", 1]]);
  assertStoreInvariants(db);
});

test("stop_process：往目标的信箱放一个 stop", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("stop_process", { process: "b" })]));
  assert.equal(r.text, "ok\n\n[stop_process] 已给 b 发出停止。");
  assert.deepEqual(mailbox(db), [{ id: "b", input: { kind: "stop" } }]);
});

test("memory_set、memory_get、memory_delete：写这个预设的库；预设没有 memory 也行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r1 = handleResult(db, memory, "boss", result(n, [call("memory_set", { key: "k", value: "v", brief: "摘要" }), call("memory_get", { key: "k" })]));
  assert.equal(r1.isError, false);
  const got = memory.get("boss", "k")!;
  assert.equal(got.value, "v");
  assert.match(r1.text, new RegExp(`\\[memory_set\\] 已写入 k，版本 ${got.version}。\\n\\n\\[memory_get\\] k（版本 ${got.version}，更新 1970-01-01）：\\n摘要：摘要\\nv$`));
  // 提示词里不挂记忆视图：预设没有 memory。
  assert.equal(JSON.stringify(allMessages(db, "boss")).includes("k: v"), false);
});

test("声明的 memory_set 缺 brief：参数错误，库不变", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("memory_set", { key: "k", value: "v" })]));
  assert.equal(r.isError, true);
  assert.match(r.text, /^ok\n\n\[memory_set\] 参数错误：memory_set 缺少 brief（字符串）。收到的参数名：key, value。$/);
  assert.equal(memory.get("boss", "k"), null);
  assert.deepEqual(memory.calls.filter((c) => c === "set"), []);
});

test("memory_delete 带版本号；版本不对就失败，整条 isError", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const v = (memory.set("boss", "k", { value: "v", brief: "摘要", now: 0 }, null) as { version: number }).version;
  const r = handleResult(db, memory, "boss", result(n, [call("memory_delete", { key: "k", version: v + 1 })]));
  assert.equal(r.isError, true);
  assert.match(r.text, /^ok\n\n\[memory_delete\] 版本冲突，没有写入。/);
  assert.equal(memory.get("boss", "k")?.value, "v");
});

test("声明的 memory_edit：只换值里的一段，摘要不带就保持，版本加一", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const v = (memory.set("boss", "k", { value: "甲 乙 丙", brief: "摘要", now: 0 }, null) as { version: number }).version;
  const r = handleResult(db, memory, "boss", result(n, [call("memory_edit", { key: "k", old: "乙", new: "丁", version: v }), call("memory_edit", { key: "k", old: "甲", new: "子", version: v + 1, brief: "换过" })]));
  assert.equal(r.isError, false);
  assert.match(r.text, /^ok\n\n\[memory_edit\] 已写入 k，版本 \d+。\n\n\[memory_edit\] 已写入 k，版本 \d+。$/);
  assert.deepEqual(memory.get("boss", "k"), { value: "子 丁 丙", brief: "换过", updated: 5, version: v + 2 });
});

test("不看 agents、memory：预设什么都没列，post、spawn、stop_process、memory_* 都能声明（见上面的各条）；handoff、self、别的名字这一项失败", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("handoff"), call("self"), call("read", { path: "a" }), call("nope")]));
  assert.equal(r.isError, true);
  assert.match(r.text, /^ok\n\n\[handoff\] [^\n]+\n\n\[self\] 未执行。\n\n\[read\] 未执行。\n\n\[nope\] 未执行。$/);
  // 每一个不能声明的名字，单独声明时这一项失败，文字说清能声明哪些。
  for (const name of ["handoff", "self", "read", "decl", "nope"]) {
    const db2 = tempDb(t);
    const n2 = waiting(db2, fakeMemory());
    const r2 = handleResult(db2, fakeMemory(), "boss", result(n2, [call(name)]));
    assert.equal(r2.isError, true, name);
    assert.match(r2.text, new RegExp(`^ok\\n\\n\\[${name}\\] 不能在结果里声明这个动作。能声明的有：post、spawn、stop_process、memory_get、memory_set、memory_edit、memory_delete。$`));
  }
  assert.equal(loadProcess(db, "boss")!.phase.tag, "awaitingModel");
});

test("第一个失败后其余写“未执行”：失败的什么都不写，前面成功的不回滚", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("memory_set", { key: "a", value: "1", brief: "甲" }), call("post", { to: "zz", text: "x" }), call("memory_set", { key: "b", value: "2", brief: "乙" }), call("nope")]));
  assert.equal(r.isError, true);
  assert.match(r.text, /^ok\n\n\[memory_set\] 已写入 a，版本 \d+。\n\n\[post\] 没有进程 zz。用 self 查运行中的进程 ID。\n\n\[memory_set\] 未执行。\n\n\[nope\] 未执行。$/);
  assert.equal(memory.get("boss", "a")?.value, "1");
  assert.equal(memory.get("boss", "b"), null);
  assert.deepEqual(mailbox(db), []);
});

test("参数不对：这一项失败，不抛错", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("post", { to: 5 }), call("spawn", {})]));
  assert.equal(r.isError, true);
  assert.match(r.text, /^ok\n\n\[post\] 参数错误：[^\n]+\n\n\[spawn\] 未执行。$/);
});

test("预设读不出时 spawn 失败；不建进程", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  const r = handleResult(db, memory, "boss", result(n, [call("spawn", { preset: "ghost", text: "x" })]));
  assert.equal(r.isError, true);
  assert.match(r.text, /\[spawn\] 预设 ghost 读不出：找不到预设：ghost/);
  assert.equal(loadProcesses(db).length, 1);
});

test("过时的结果不执行：先 stop，再来的同一编号的结果", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  const n = waiting(db, memory);
  send(db, "boss", { kind: "stop" });
  putMail(db, "boss", result(n, [call("post", { to: "b", text: "x" }), call("memory_set", { key: "k", value: "v", brief: "摘要" })]));
  handleNext(db, memory, 5, readPreset); // stop：补一个“被停止”的工具结果，回到空闲
  assert.equal(loadProcess(db, "boss")!.phase.tag, "idle");
  const before = JSON.stringify(allMessages(db, "boss"));
  handleNext(db, memory, 6, readPreset); // 过时的结果
  assert.deepEqual(mailbox(db), []);
  assert.equal(memory.get("boss", "k"), null);
  assert.equal(JSON.stringify(allMessages(db, "boss")), before);
  assert.equal(loadProcess(db, "boss")!.phase.tag, "idle");
});

test("编号对不上的结果不执行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  putMail(db, "boss", result(n + 7, [call("memory_set", { key: "k", value: "v", brief: "摘要" })]));
  handleNext(db, memory, 5, readPreset);
  assert.equal(memory.get("boss", "k"), null);
});

test("被中断的结果没有声明；不是 runTool 在等时的结果也不执行", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const n = waiting(db, memory);
  putMail(db, "boss", { kind: "toolResult", n, outcome: { status: "interrupted" } });
  handleNext(db, memory, 5, readPreset);
  assert.equal(memory.calls.includes("set"), false);
});

test("声明的 post 的目标被 remove：先删，声明失败；先寄，目标删不掉", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  db.exec("DELETE FROM effects");
  db.prepare("UPDATE processes SET state_json = json_set(state_json, '$.phase', json('{\"tag\":\"idle\"}')) WHERE id = 'b'").run();
  const n = waiting(db, memory);
  removeProcess(db, "b");
  const r = handleResult(db, memory, "boss", result(n, [call("post", { to: "b", text: "x" })]));
  assert.equal(r.isError, true);
  assert.match(r.text, /\[post\] 没有进程 b。/);
  assert.deepEqual(mailbox(db), []);

  // 反过来：声明的 post 已经提交，目标的信箱里有信，删除被拒绝。
  startProcess(db, memory, "c", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  db.exec("DELETE FROM effects");
  db.prepare("UPDATE processes SET state_json = json_set(state_json, '$.phase', json('{\"tag\":\"idle\"}')) WHERE id = 'c'").run();
  const n2 = waiting(db, memory, "boss2");
  const r2 = handleResult(db, memory, "boss2", result(n2, [call("post", { to: "c", text: "y" })]));
  assert.equal(r2.isError, false);
  assert.throws(() => removeProcess(db, "c"), /信箱里还有进程 c 的输入/);
});

test("执行器原样转交 calls：结果的输入带着它，内容里没有", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const calls = [call("memory_set", { key: "k", value: "v", brief: "摘要" })];
  const actions: Actions = {
    callModel: async () => use(toolCall("c1", "decl")),
    runTool: async () => ({ content: textContent("好"), isError: false, calls }),
  };
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "boss", DECL, "开始", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  handleNext(db, memory, 0);
  await exec.startNext();
  assert.deepEqual(mailbox(db).map((m) => m.input), [{ kind: "toolResult", n: 2, outcome: { status: "ok", content: { content: textContent("好"), isError: false }, calls } }]);
});

/** 崩溃：重启 = 关库、重开、新建执行器（启动恢复）。 */
const reopen = (db: DatabaseSync, path: string): DatabaseSync => {
  db.close();
  return openDb(path);
};

test("崩溃：结果提交之后、handleNext 之前杀掉；重启后声明恰好执行一次", async (t) => {
  const dbs: DatabaseSync[] = [];
  const dir = tempDir(t, dbs);
  const path = join(dir, "tau.db");
  let db = openDb(path);
  dbs.push(db);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  db.exec("DELETE FROM mailbox");
  db.exec("DELETE FROM effects");
  db.prepare("UPDATE processes SET state_json = json_set(state_json, '$.phase', json('{\"tag\":\"idle\"}')) WHERE id = 'b'").run();
  const calls = [call("post", { to: "b", text: "一次" }), call("memory_set", { key: "k", value: "v", brief: "摘要" })];
  const actions: Actions = { callModel: async () => use(toolCall("c1", "decl")), runTool: async () => ({ content: textContent("好"), isError: false, calls }) };
  let exec = createExecutor(db, actions);
  startProcess(db, memory, "boss", DECL, "开始", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  handleNext(db, memory, 0);
  await exec.startNext(); // 结果已提交进信箱，还没处理
  assert.equal(mailbox(db).filter((m) => m.input.kind === "toolResult").length, 1);
  assert.equal(memory.get("boss", "k"), null);

  db = reopen(db, path);
  dbs.push(db);
  exec = createExecutor(db, { callModel: async () => say("完"), runTool: async () => { throw new Error("不该重做"); } });
  await settle(db, memory, exec, undefined, readPreset);
  assert.equal(memory.get("boss", "k")?.value, "v");
  const toB = allMessages(db, "b").filter((m) => m.role === "user" && JSON.stringify(m.content).includes("一次"));
  assert.equal(toB.length, 1);
  assert.equal(allMessages(db, "boss").filter((m) => m.role === "toolResult").length, 1);
  assert.deepEqual(effectRows(db), []);
  assertStoreInvariants(db);
});

test("崩溃：结果提交之前杀掉（running）；报被中断，声明一个都没做", async (t) => {
  const dbs: DatabaseSync[] = [];
  const dir = tempDir(t, dbs);
  const path = join(dir, "tau.db");
  let db = openDb(path);
  dbs.push(db);
  const memory = fakeMemory();
  const actions: Actions = { callModel: async () => use(toolCall("c1", "decl")), runTool: () => new Promise(() => {}) };
  let exec = createExecutor(db, actions);
  startProcess(db, memory, "boss", DECL, "开始", 0);
  handleNext(db, memory, 0);
  await exec.startNext();
  handleNext(db, memory, 0);
  void exec.startNext(); // 工具开始了，永远不完成
  assert.deepEqual(effectRows(db).map((r) => r.status), ["running"]);
  db = reopen(db, path);
  dbs.push(db);
  exec = createExecutor(db, { callModel: async () => say("完"), runTool: async () => { throw new Error("不该重做"); } });
  await settle(db, memory, exec, undefined, readPreset);
  assert.equal(memory.get("boss", "k"), null);
  assert.equal(memory.calls.includes("set"), false);
  assert.match(JSON.stringify(allMessages(db, "boss")), /被中断/);
});
