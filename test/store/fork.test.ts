// forkProcess：一个事务读源进程和当前段、建新进程和复制的消息。拒绝和失败都什么都不留，源进程完全不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { checkImages } from "../../src/images.ts";
import { start } from "../../src/kernel/decide.ts";
import type { Input, Message, PresetSnapshot } from "../../src/kernel/types.ts";
import { userLetter } from "../../src/kernel/types.ts";
import { loadProcess, loadProcesses, loadSegment, putMail } from "../../src/store/db.ts";
import { forkProcess, handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { png } from "../images.ts";
import { effectRows, fakeMemory, mailbox, PRESET, say, tempDb, toolCall, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const VISION: PresetSnapshot = { ...PRESET, input: ["text", "image"] };
const memory = fakeMemory();

/** 一切归零后的整个库：进程、全部消息、信箱、副作用、blobs。 */
const dump = (db: DatabaseSync): string =>
  JSON.stringify(["SELECT * FROM processes ORDER BY id", "SELECT * FROM segment_messages ORDER BY process_id, segment_seq, seq", "SELECT * FROM mailbox ORDER BY seq", "SELECT * FROM effects", "SELECT hash FROM blobs ORDER BY hash"].map((q) => db.prepare(q).all()));

const model = (n: number, message: ReturnType<typeof say>): Input => ({ kind: "modelResult", n, outcome: { status: "ok", message } });
const tool = (n: number, text: string): Input => ({ kind: "toolResult", n, outcome: { status: "ok", content: { content: [{ type: "text", text }], isError: false } } });

function drain(db: DatabaseSync): void {
  while (handleNext(db, memory, 1)) continue;
}

/** 两轮之后回到 idle 的进程 a：段里是 u a u a。 */
function idleSource(db: DatabaseSync, preset = PRESET): void {
  startProcess(db, memory, "a", preset, "问一", 0);
  drain(db);
  putMail(db, "a", model(1, say("答一")));
  drain(db);
  send(db, "a", userLetter("问二"));
  drain(db);
  putMail(db, "a", model(2, say("答二")));
  drain(db);
}

/** 运行中的进程 a：段里是 u asst(c1) tr(c1) u(插话)，在等模型 #3。 */
function runningSource(db: DatabaseSync): void {
  startProcess(db, memory, "a", PRESET, "读一下", 0);
  drain(db);
  putMail(db, "a", model(1, use(toolCall("c1", "read", { path: "x" }))));
  drain(db);
  send(db, "a", userLetter("插话"));
  drain(db);
  putMail(db, "a", tool(2, "内容"));
  drain(db);
}

test("fork 不带 before：新进程和复制的消息写进库，源进程不变，没有信箱和副作用的行", (t) => {
  const db = tempDb(t);
  idleSource(db);
  const src = loadProcess(db, "a")!;
  const seg = loadSegment(db, src);
  assert.equal(seg.length, 4);
  const before = dump(db);
  const h = forkProcess(db, "b", "a", undefined, 500);
  const p = loadProcess(db, "b")!;
  assert.deepEqual(p, h.process);
  assert.deepEqual(p, { id: "b", preset: src.preset, createdAt: 500, segment: { seq: 1, memoryView: src.segment.memoryView }, lastEffect: 0, phase: { tag: "idle", ended: "done" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  assert.deepEqual(loadSegment(db, p), seg);
  assert.deepEqual(h.segment, seg);
  assert.deepEqual(loadProcess(db, "a"), src);
  assert.deepEqual(loadSegment(db, src), seg);
  assert.equal(mailbox(db).length, 0);
  assert.deepEqual(effectRows(db), []);
  assertStoreInvariants(db);
  // 去掉新进程的行，库和之前逐字节相同：fork 只加不改。
  db.prepare("DELETE FROM processes WHERE id = 'b'").run();
  db.prepare("DELETE FROM segment_messages WHERE process_id = 'b'").run();
  assert.equal(dump(db), before);
});

test("fork 带 before：前缀，idle 不带结束原因；之后 send 一封信能开新一轮，库里的数据只增", (t) => {
  const db = tempDb(t);
  idleSource(db);
  const seg = loadSegment(db, loadProcess(db, "a")!);
  forkProcess(db, "b", "a", 2, 0);
  const b = loadProcess(db, "b")!;
  assert.deepEqual(b.phase, { tag: "idle" });
  assert.deepEqual(loadSegment(db, b), seg.slice(0, 2));
  assertStoreInvariants(db);
  send(db, "b", userLetter("改问"));
  drain(db);
  assert.deepEqual(loadSegment(db, loadProcess(db, "b")!).map((m: Message) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(effectRows(db), [{ id: "b", n: 1, status: "pending" }]);
  assertStoreInvariants(db);
  assert.deepEqual(loadSegment(db, loadProcess(db, "a")!), seg);
});

test("反例：源进程在运行时，不带 before 被拒；带 before 在并入的信之前切，前缀以工具结果结尾", (t) => {
  const db = tempDb(t);
  runningSource(db);
  const src = loadProcess(db, "a")!;
  assert.equal(src.phase.tag, "awaitingModel");
  const seg = loadSegment(db, src);
  assert.deepEqual(seg.map((m) => m.role), ["user", "assistant", "toolResult", "user"]);
  const before = dump(db);
  assert.throws(() => forkProcess(db, "b", "a", undefined, 0), /正在运行/);
  assert.equal(dump(db), before);
  forkProcess(db, "b", "a", 3, 0);
  const b = loadProcess(db, "b")!;
  assert.deepEqual(loadSegment(db, b), seg.slice(0, 3));
  assert.equal(loadSegment(db, b).at(-1)?.role, "toolResult");
  assert.deepEqual(effectRows(db), [{ id: "a", n: 3, status: "pending" }], "源进程的副作用行不动，新进程没有");
  assertStoreInvariants(db);
  send(db, "b", userLetter("接着"));
  drain(db);
  assert.equal(loadProcess(db, "b")!.phase.tag, "awaitingModel");
  assertStoreInvariants(db);
});

test("拒绝：没有这个进程、before 越界、不是用户消息；什么都不建", (t) => {
  const db = tempDb(t);
  idleSource(db);
  const before = dump(db);
  assert.throws(() => forkProcess(db, "b", "nope", undefined, 0), /没有这个进程：nope/);
  assert.throws(() => forkProcess(db, "b", "a", 4, 0), /没有第 4 条/);
  assert.throws(() => forkProcess(db, "b", "a", 1, 0), /不是用户消息/);
  assert.throws(() => forkProcess(db, "b", "a", 3, 0), /不是用户消息/);
  assert.equal(dump(db), before);
  assert.equal(loadProcesses(db).length, 1);
});

test("启动检查不通过：什么都不建", (t) => {
  const db = tempDb(t);
  // 一个窗口太小的快照：直接写进库，模拟常量调严以后的老进程。
  const tiny: PresetSnapshot = { ...PRESET, id: "tiny", contextWindow: 20_000 };
  db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run("a", JSON.stringify(start("a", tiny, { now: 0, memoryView: "" })));
  const before = dump(db);
  assert.throws(() => forkProcess(db, "b", "a", undefined, 0), /窗口太小/);
  assert.equal(dump(db), before);
});

test("事务失败时什么都不留：新 ID 已经被占用，复制的消息也一起回滚", (t) => {
  const db = tempDb(t);
  idleSource(db);
  startProcess(db, memory, "b", PRESET, "占着", 0);
  drain(db);
  const before = dump(db);
  assert.throws(() => forkProcess(db, "b", "a", undefined, 0), /constraint|UNIQUE/i);
  assert.equal(dump(db), before);
  // 消息写到一半失败：让第二条消息的主键冲突（预先放一行假消息）。
  db.prepare("INSERT INTO segment_messages (process_id, segment_seq, seq, message_json) VALUES ('c', 1, 1, '{}')").run();
  const mid = dump(db);
  assert.throws(() => forkProcess(db, "c", "a", undefined, 0), /constraint|UNIQUE/i);
  assert.equal(dump(db), mid);
  assert.equal(loadProcess(db, "c"), undefined);
});

test("带图片引用的段复制后存储层不变量成立，blobs 不增", (t) => {
  const db = tempDb(t);
  startProcess(db, memory, "a", VISION, "看图", 0, checkImages([png(10, 20, 1).toString("base64")]));
  drain(db);
  putMail(db, "a", model(1, say("看到了")));
  drain(db);
  const blobs = () => db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n;
  assert.equal(blobs(), 1);
  forkProcess(db, "b", "a", undefined, 0);
  forkProcess(db, "c", "a", 0, 0);
  assert.equal(blobs(), 1);
  const copied = loadSegment(db, loadProcess(db, "b")!)[0];
  assert.equal(copied?.role, "user");
  assert.deepEqual(copied, loadSegment(db, loadProcess(db, "a")!)[0]);
  assert.deepEqual(loadSegment(db, loadProcess(db, "c")!), []);
  assertStoreInvariants(db);
});
