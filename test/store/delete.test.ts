// 三个删除事务（D59）：pruneSegments、removeProcess、sweepBlobs。拒绝什么都不留；每个事务之后存储层不变量成立。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../../src/executor/actions.ts";
import { checkImages } from "../../src/images.ts";
import type { Image } from "../../src/images.ts";
import { userLetter } from "../../src/kernel/types.ts";
import type { Content, Input, Letter, Message, PresetSnapshot, Process, Turn } from "../../src/kernel/types.ts";
import { putBlobs, readBlob } from "../../src/store/blobs.ts";
import { loadProcess, loadSegment, putMail, saveProcess } from "../../src/store/db.ts";
import { forkProcess, handleNext, pruneSegments, removeProcess, send, startProcess, sweepBlobs } from "../../src/store/inputs.ts";
import { png } from "../images.ts";
import { assertStoreInvariants } from "./invariants.ts";
import { fakeMemory, mailbox, PRESET, say, tempDb, toolCall, use } from "./fixtures.ts";

const VISION: PresetSnapshot = { ...PRESET, input: ["text", "image"] };
const memory = fakeMemory();
/** 每张图单独检查：一个请求最多两张，这里只要哈希和字节。 */
const images = (...bufs: Buffer[]): Image[] => bufs.flatMap((b) => checkImages([b.toString("base64")]));

/** 整个库：全部进程、全部消息、信箱、副作用、blobs。拒绝以后必须和之前逐字节相同。 */
const dump = (db: DatabaseSync): string =>
  JSON.stringify(["SELECT * FROM processes ORDER BY id", "SELECT * FROM segment_messages ORDER BY process_id, segment_seq, seq", "SELECT * FROM mailbox ORDER BY seq", "SELECT * FROM effects", "SELECT hash FROM blobs ORDER BY hash", "SELECT * FROM memory ORDER BY version"].map((q) => db.prepare(q).all()));

const model = (n: number, message: ReturnType<typeof say>): Input => ({ kind: "modelResult", n, outcome: { status: "ok", message } });
const tool = (n: number, text: string): Input => ({ kind: "toolResult", n, outcome: { status: "ok", content: { content: [{ type: "text", text }], isError: false } } });
const user = (...content: Content[]): Message => ({ role: "user", content, timestamp: 0 });
const ref = (hash: string): Content => ({ type: "image", data: `blob:${hash}`, mimeType: "image/png" });
const blobCount = (db: DatabaseSync): number => db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n as number;
const segments = (db: DatabaseSync, id: string): number[] => db.prepare("SELECT DISTINCT segment_seq FROM segment_messages WHERE process_id = ? ORDER BY segment_seq").all(id).map((r) => r.segment_seq as number);

function drain(db: DatabaseSync): void {
  while (handleNext(db, memory, 1)) continue;
}

/** 回到 idle 的进程：一轮，段里是 u a。 */
function idle(db: DatabaseSync, id: string, text = "问", preset = PRESET, imgs: Image[] = []): void {
  startProcess(db, memory, id, preset, text, 0, imgs);
  drain(db);
  putMail(db, id, model(1, say("答")));
  drain(db);
}

/** 在等模型 #1 的进程：段里是 u。 */
function running(db: DatabaseSync, id: string, preset = PRESET, imgs: Image[] = []): void {
  startProcess(db, memory, id, preset, "问", 0, imgs);
  drain(db);
}

/** 把进程的当前段挪到第 `current` 段，1 到 current-1 段各放两条消息，模拟换过段。 */
function rise(db: DatabaseSync, id: string, current: number): void {
  const p = loadProcess(db, id)!;
  db.prepare("UPDATE segment_messages SET segment_seq = ? WHERE process_id = ?").run(current, id);
  saveProcess(db, { ...p, segment: { ...p.segment, seq: current } });
  for (let s = 1; s < current; s++) oldSegment(db, id, s, [user({ type: "text", text: `旧${s}` }), user({ type: "text", text: `答${s}` })]);
}

function oldSegment(db: DatabaseSync, id: string, seg: number, messages: Message[]): void {
  messages.forEach((m, i) => db.prepare("INSERT INTO segment_messages (process_id, segment_seq, seq, message_json) VALUES (?, ?, ?, ?)").run(id, seg, i, JSON.stringify(m)));
}

const letter = (replyTo?: string): Letter => ({ from: { kind: "user" }, content: [{ type: "text", text: "信" }], hops: 0, ...(replyTo === undefined ? {} : { replyTo }) });
/** 运行中的进程，本轮的 turn 改一部分。 */
function withTurn(p: Process, patch: Partial<Turn>): Process {
  if (p.phase.tag === "idle") throw new Error("进程是空闲的，没有 turn");
  return { ...p, phase: { ...p.phase, turn: { ...p.phase.turn, ...patch } } };
}

// pruneSegments

test("pruneSegments：删段号小于 before 的旧段，当前段不动；before 等于当前段号也行", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  rise(db, "a", 4);
  assert.deepEqual(segments(db, "a"), [1, 2, 3, 4]);
  const current = loadSegment(db, loadProcess(db, "a")!);
  const other = (idle(db, "b"), rise(db, "b", 2), JSON.stringify(db.prepare("SELECT * FROM segment_messages WHERE process_id = 'b' ORDER BY segment_seq, seq").all()));
  const proc = JSON.stringify(loadProcess(db, "a"));

  pruneSegments(db, "a", 3);
  assert.deepEqual(segments(db, "a"), [3, 4]);
  assertStoreInvariants(db);
  pruneSegments(db, "a", 4);
  assert.deepEqual(segments(db, "a"), [4]);
  assertStoreInvariants(db);
  assert.deepEqual(loadSegment(db, loadProcess(db, "a")!), current);
  assert.equal(JSON.stringify(loadProcess(db, "a")), proc, "进程记录不变");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM segment_messages WHERE process_id = 'b' ORDER BY segment_seq, seq").all()), other, "别的进程不受影响");
  // 再删一次：旧段已经没有，成功，什么都不变。
  const before = dump(db);
  pruneSegments(db, "a", 4);
  assert.equal(dump(db), before);
});

test("pruneSegments：before 大于当前段号被拒，什么都不删", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  rise(db, "a", 3);
  const before = dump(db);
  assert.throws(() => pruneSegments(db, "a", 4), /当前段/);
  assert.throws(() => pruneSegments(db, "a", 100), /当前段/);
  assert.equal(dump(db), before);
  assertStoreInvariants(db);
});

test("pruneSegments：before 不大于 1 成功，什么都不删", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  rise(db, "a", 3);
  const before = dump(db);
  pruneSegments(db, "a", 1);
  pruneSegments(db, "a", 0);
  assert.equal(dump(db), before);
  assertStoreInvariants(db);
});

test("pruneSegments：没有这个进程，抛错", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  const before = dump(db);
  assert.throws(() => pruneSegments(db, "zz", 1), /没有这个进程/);
  assert.equal(dump(db), before);
});

test("pruneSegments：进程在运行时也能删，之后照常处理输入", (t) => {
  const db = tempDb(t);
  running(db, "a");
  rise(db, "a", 3);
  assertStoreInvariants(db);
  const effects = JSON.stringify(db.prepare("SELECT * FROM effects").all());
  pruneSegments(db, "a", 3);
  assert.deepEqual(segments(db, "a"), [3]);
  assert.equal(loadProcess(db, "a")!.phase.tag, "awaitingModel");
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM effects").all()), effects, "不碰副作用表");
  assertStoreInvariants(db);
  // 运行中到一封信，再把模型结果送回：照常排队、并段、结束。
  send(db, "a", userLetter("插话"));
  putMail(db, "a", model(1, say("答")));
  drain(db);
  putMail(db, "a", model(2, say("再答")));
  drain(db);
  const p = loadProcess(db, "a")!;
  assert.equal(p.phase.tag, "idle");
  assert.equal(p.segment.seq, 3);
  assertStoreInvariants(db);
});

// removeProcess

test("removeProcess：删记录和全部段；记忆和 blobs 不动，别的进程不动", (t) => {
  const db = tempDb(t);
  const [img] = images(png(10, 10, 1));
  idle(db, "a", "看图", VISION, [img!]);
  rise(db, "a", 3);
  idle(db, "b");
  // 记忆库的 ns 是预设 ID，不是进程 ID：一行属于要删的进程 a 的预设，一行作对照。
  db.prepare("INSERT INTO memory (ns, key, value) VALUES (?, ?, ?)").run(VISION.id, "k", "v");
  db.prepare("INSERT INTO memory (ns, key, value) VALUES (?, ?, ?)").run("other", "k", "v");
  const mem = JSON.stringify(db.prepare("SELECT * FROM memory ORDER BY version").all());
  assert.ok(mem.includes('"k"'));
  const bRows = JSON.stringify(db.prepare("SELECT * FROM segment_messages WHERE process_id = 'b'").all());
  const bProc = JSON.stringify(loadProcess(db, "b"));
  const blobs = blobCount(db);

  removeProcess(db, "a");
  assert.equal(loadProcess(db, "a"), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM segment_messages WHERE process_id = 'a'").get()?.n, 0);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM memory ORDER BY version").all()), mem, "记忆不动");
  assert.equal(blobCount(db), blobs, "blobs 不动，要清用 sweepBlobs");
  assert.equal(JSON.stringify(loadProcess(db, "b")), bProc);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM segment_messages WHERE process_id = 'b'").all()), bRows);
  assertStoreInvariants(db);
  // 删了以后这个 ID 又能用。
  idle(db, "a");
  assertStoreInvariants(db);
});

/** 每条拒绝：抛错，库逐字节不变。 */
function refused(db: DatabaseSync, id: string, why: RegExp): void {
  const before = dump(db);
  assert.throws(() => removeProcess(db, id), why);
  assert.equal(dump(db), before);
  assertStoreInvariants(db);
}

test("removeProcess 拒绝：没有这个进程", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  refused(db, "zz", /没有这个进程/);
});

test("removeProcess 拒绝：不是 idle", (t) => {
  const db = tempDb(t);
  running(db, "a");
  refused(db, "a", /不是空闲/);
});

test("removeProcess 拒绝：信箱里有它的输入", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  send(db, "a", userLetter("还没处理"));
  assert.equal(mailbox(db).length, 1);
  refused(db, "a", /信箱/);
});

test("removeProcess 拒绝：有进程的 parent 是它", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  idle(db, "b");
  saveProcess(db, { ...loadProcess(db, "b")!, parent: "a" });
  refused(db, "a", /父进程/);
  // 从叶子删起：先删子进程，再删它。
  removeProcess(db, "b");
  removeProcess(db, "a");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM processes").get()?.n, 0);
  assertStoreInvariants(db);
});

test("removeProcess 拒绝：它在别的进程的 turn.replyTo 里", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  running(db, "b");
  saveProcess(db, withTurn(loadProcess(db, "b")!, { replyTo: ["a"] }));
  refused(db, "a", /回信/);
});

test("removeProcess 拒绝：它在排队的信的 replyTo 里（进程记录的 turn.queued）", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  running(db, "b");
  saveProcess(db, withTurn(loadProcess(db, "b")!, { queued: [letter("a")] }));
  refused(db, "a", /回信/);
});

test("removeProcess 拒绝：它在信箱里的信的 replyTo 里（寄给别的进程的信）", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  idle(db, "b");
  putMail(db, "b", { kind: "letter", letter: letter("a") });
  refused(db, "a", /回信/);
});

test("removeProcess：信箱里的信回信给别的进程，不拦", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  idle(db, "b");
  idle(db, "c");
  putMail(db, "b", { kind: "letter", letter: letter("c") });
  removeProcess(db, "a");
  assertStoreInvariants(db);
});

// sweepBlobs

test("sweepBlobs：删没人引用的行，返回行数；段、信箱里引用的留下", (t) => {
  const db = tempDb(t);
  const [inSegment, orphan1, orphan2, inMailbox] = images(png(10, 10, 1), png(10, 10, 2), png(10, 10, 3), png(10, 10, 4));
  idle(db, "a", "看图", VISION, [inSegment!]);
  send(db, "a", userLetter("再看"), [inMailbox!]);
  putBlobs(db, [orphan1!, orphan2!]);
  assert.equal(blobCount(db), 4);
  assert.equal(sweepBlobs(db), 2);
  assert.equal(blobCount(db), 2);
  assert.ok(readBlob(db, inSegment!.hash) && readBlob(db, inMailbox!.hash));
  assert.equal(readBlob(db, orphan1!.hash), undefined);
  assertStoreInvariants(db);
  assert.equal(sweepBlobs(db), 0);
});

/** 假的 Models：记下 streamSimple 收到的上下文，回一句话。 */
function recordingModels(): { models: Models; contexts: { messages: Message[] }[] } {
  const contexts: { messages: Message[] }[] = [];
  const models = {
    getModel: () => ({ id: "model-1", provider: "faux", maxTokens: 4096 }),
    streamSimple(_m: unknown, context: { messages: Message[] }) {
      contexts.push(context);
      return { async *[Symbol.asyncIterator]() {}, result: async () => say("好") };
    },
  } as unknown as Models;
  return { models, contexts };
}

test("sweepBlobs：运行中的进程只在 turn.queued 里引用的图片不被清掉；到安全点调用模型，请求里是真字节", async (t) => {
  const db = tempDb(t);
  const [img] = images(png(12, 12, 7));
  running(db, "a", VISION);
  send(db, "a", userLetter("看这张"), [img!]);
  drain(db);
  const a = loadProcess(db, "a")!;
  const queued = a.phase.tag === "idle" ? [] : a.phase.turn.queued;
  assert.equal(queued.length, 1);
  assert.match(JSON.stringify(queued), new RegExp(`blob:${img!.hash}`), "图片只在 turn.queued 里");
  assert.equal(mailbox(db).length, 0);

  assert.equal(sweepBlobs(db), 0);
  assert.ok(readBlob(db, img!.hash));
  assertStoreInvariants(db);

  // 到安全点：工具调用、工具结果之后，排队的信并进段，再调用模型。
  putMail(db, "a", model(1, use(toolCall("c1", "read", { path: "x" }))));
  drain(db);
  putMail(db, "a", tool(2, "内容"));
  drain(db);
  const p = loadProcess(db, "a")!;
  assert.equal(p.phase.tag, "awaitingModel");
  const segment = loadSegment(db, p);
  assert.match(JSON.stringify(segment), new RegExp(`blob:${img!.hash}`));
  assertStoreInvariants(db);

  const { models, contexts } = recordingModels();
  const actions = createActions(models, () => {}, "test-pipe", (hash) => readBlob(db, hash));
  await actions.callModel({ process: p, segment, effect: { kind: "callModel", n: p.lastEffect, purpose: "turn" } }, new AbortController().signal);
  const sent = JSON.stringify(contexts[0]!.messages);
  assert.ok(sent.includes(png(12, 12, 7).toString("base64")), "请求里是图片的真字节");
});

test("sweepBlobs：fork 共用的图片，源进程删掉以后，分叉出来的进程还引用的不被清掉", (t) => {
  const db = tempDb(t);
  const [img] = images(png(10, 10, 5));
  idle(db, "a", "看图", VISION, [img!]);
  forkProcess(db, memory, "b", "a", undefined, 0);
  removeProcess(db, "a");
  assert.equal(sweepBlobs(db), 0);
  assert.ok(readBlob(db, img!.hash));
  assertStoreInvariants(db);
  // 分叉出来的也删了，才没人引用。
  removeProcess(db, "b");
  assert.equal(sweepBlobs(db), 1);
  assert.equal(blobCount(db), 0);
});

test("sweepBlobs：只被旧段引用的图片，prune 掉旧段以后被清掉；当前段引用的留下", (t) => {
  const db = tempDb(t);
  const [now, old] = images(png(10, 10, 1), png(10, 10, 2));
  idle(db, "a", "看图", VISION, [now!]);
  rise(db, "a", 2);
  putBlobs(db, [old!]);
  db.prepare("DELETE FROM segment_messages WHERE process_id = 'a' AND segment_seq = 1").run();
  oldSegment(db, "a", 1, [user({ type: "text", text: "旧图" }, ref(old!.hash))]);
  assertStoreInvariants(db);
  assert.equal(sweepBlobs(db), 0, "旧段还在，引用还在");
  pruneSegments(db, "a", 2);
  assert.equal(sweepBlobs(db), 1);
  assert.equal(readBlob(db, old!.hash), undefined);
  assert.ok(readBlob(db, now!.hash));
  assertStoreInvariants(db);
});

// 不变量的检查本身

test("存储层不变量：旧段有缺口、旧段里引用的图片缺行、没有主的消息，都抓得到", (t) => {
  const db = tempDb(t);
  idle(db, "a");
  rise(db, "a", 4);
  assertStoreInvariants(db);

  db.prepare("DELETE FROM segment_messages WHERE process_id = 'a' AND segment_seq = 2").run();
  assert.throws(() => assertStoreInvariants(db), /旧段/);
  oldSegment(db, "a", 2, [user({ type: "text", text: "补回来" })]);
  assertStoreInvariants(db);

  oldSegment(db, "a", 5, [user({ type: "text", text: "比当前段还大" })]);
  assert.throws(() => assertStoreInvariants(db), /当前段/);
  db.prepare("DELETE FROM segment_messages WHERE segment_seq = 5").run();
  assertStoreInvariants(db);

  db.prepare("UPDATE segment_messages SET process_id = 'ghost' WHERE process_id = 'a' AND segment_seq = 1").run();
  assert.throws(() => assertStoreInvariants(db), /不存在的进程/);
  db.prepare("UPDATE segment_messages SET process_id = 'a' WHERE process_id = 'ghost'").run();
  assertStoreInvariants(db);

  db.prepare("DELETE FROM segment_messages WHERE process_id = 'a' AND segment_seq = 1").run();
  oldSegment(db, "a", 1, [user(ref("f".repeat(64)))]);
  assert.throws(() => assertStoreInvariants(db), /blobs 里没有行/);
});
