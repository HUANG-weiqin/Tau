// D64 第 8、9 组：`send` 带 `from`、`reply`（发送者从发信进程的记录构造），`start`、`fork` 遇到已存在的 ID。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import { HOPS_MAX } from "../../src/kernel/derive.ts";
import { textContent, userLetter } from "../../src/kernel/types.ts";
import type { Letter, Process, Turn } from "../../src/kernel/types.ts";
import { loadProcess, saveProcess } from "../../src/store/db.ts";
import { forkProcess, handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { fakeMemory, mailbox, PRESET, say, scripted, settle, tempDb } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const memory = fakeMemory();

/** 库里全部表的内容：拒绝以后必须一字不差。 */
const dump = (db: DatabaseSync): string => JSON.stringify(["processes", "segment_messages", "mailbox", "effects", "blobs"].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));

const lettersFor = (db: DatabaseSync, id: string): Letter[] => mailbox(db).flatMap((m) => (m.id === id && m.input.kind === "letter" ? [m.input.letter] : []));

function twoIdle(t: Parameters<typeof tempDb>[0]): DatabaseSync {
  const db = tempDb(t);
  startProcess(db, memory, "a", PRESET, "开始", 0);
  startProcess(db, memory, "b", PRESET, "开始", 0);
  return db;
}

/** 把 a 改成等模型（或等工具），本轮跳数是 hops。只用来测 `send` 读到的记录，不用于推进。 */
function setTurn(db: DatabaseSync, id: string, tag: "awaitingModel" | "awaitingTool", hops: number): void {
  const p = loadProcess(db, id)!;
  const turn: Turn = { steps: 0, queued: [], hops, replyTo: [] };
  saveProcess(db, { ...p, phase: tag === "awaitingModel" ? { tag, turn, purpose: "turn" } : { tag, turn } } as Process);
}

const noImages = [] as const;

test("send 带 from：发送者、跳数从 a 的记录构造；a 空闲时跳数是 1，不带 replyTo", (t) => {
  const db = twoIdle(t);
  send(db, "b", userLetter("你好"), noImages, { id: "a", reply: false });
  assert.deepEqual(lettersFor(db, "b").at(-1), { from: { kind: "process", id: "a", preset: "helper" }, content: textContent("你好"), hops: 1 });
  assertStoreInvariants(db);
});

test("send 带 from：a 等模型、等工具时跳数是 turn.hops + 1，空闲时是 1", (t) => {
  const db = twoIdle(t);
  setTurn(db, "a", "awaitingModel", 5);
  send(db, "b", userLetter("一"), noImages, { id: "a", reply: false });
  setTurn(db, "a", "awaitingTool", 9);
  send(db, "b", userLetter("二"), noImages, { id: "a", reply: false });
  assert.deepEqual(lettersFor(db, "b").slice(-2).map((l) => l.hops), [6, 10]);
});

test("send 带 from 和 reply：replyTo 是 a，发送者不带 reply", (t) => {
  const db = twoIdle(t);
  send(db, "b", userLetter("问"), noImages, { id: "a", reply: true });
  assert.deepEqual(lettersFor(db, "b").at(-1), { from: { kind: "process", id: "a", preset: "helper" }, content: textContent("问"), hops: 1, replyTo: "a" });
});

test("send 带 from：和 handoff 同时带，两者互不影响", (t) => {
  const db = twoIdle(t);
  send(db, "b", { ...userLetter("换段"), letter: { ...userLetter("换段").letter, handoff: true } }, noImages, { id: "a", reply: true });
  assert.deepEqual(lettersFor(db, "b").at(-1), { from: { kind: "process", id: "a", preset: "helper" }, content: textContent("换段"), hops: 1, replyTo: "a", handoff: true });
});

test("send 带 from：拒绝 a 不存在、a 等于目标、跳数超过 HOPS_MAX，什么都不写", (t) => {
  const db = twoIdle(t);
  const before = dump(db);
  assert.throws(() => send(db, "b", userLetter("x"), noImages, { id: "nobody", reply: false }), /没有这个进程：nobody/);
  assert.throws(() => send(db, "b", userLetter("x"), noImages, { id: "b", reply: true }), /不能给自己寄信/);
  setTurn(db, "a", "awaitingModel", HOPS_MAX);
  const mid = dump(db);
  assert.throws(() => send(db, "b", userLetter("x"), noImages, { id: "a", reply: false }), /跳数到上限/);
  assert.equal(dump(db), mid);
  assert.notEqual(mid, before);
  // 上限以内照常：HOPS_MAX - 1 → HOPS_MAX。
  setTurn(db, "a", "awaitingModel", HOPS_MAX - 1);
  send(db, "b", userLetter("y"), noImages, { id: "a", reply: false });
  assert.equal(lettersFor(db, "b").at(-1)?.hops, HOPS_MAX);
});

test("send 带 from：目标不存在也拒绝；带图片时 blobs 不留", (t) => {
  const db = twoIdle(t);
  const before = dump(db);
  assert.throws(() => send(db, "zz", userLetter("x"), noImages, { id: "a", reply: true }), /没有这个进程：zz/);
  assert.equal(dump(db), before);
});

test("reply 的回信：b 处理完那一轮，回信在同一个事务里进 a 的信箱，a 随后被唤醒", async (t) => {
  const db = twoIdle(t);
  const exec = createExecutor(db, scripted([say("a 好"), say("b 好"), say("答案"), say("收到")]));
  await settle(db, memory, exec);
  send(db, "b", userLetter("几点了"), noImages, { id: "a", reply: true });
  assert.ok(handleNext(db, memory, 1));
  await exec.startNext();
  const h = handleNext(db, memory, 2);
  assert.deepEqual(h?.process.phase, { tag: "idle", ended: "done" });
  assert.deepEqual(mailbox(db).map((m) => m.id), ["a"]);
  assert.deepEqual(lettersFor(db, "a")[0], { from: { kind: "process", id: "b", preset: "helper", reply: { ended: "done" } }, content: textContent("答案"), hops: 2 });
  assertStoreInvariants(db);
  await settle(db, memory, exec);
  assert.deepEqual(mailbox(db), []);
});

test("start、forkProcess 遇到已存在的 ID：抛“进程 ID 已存在”，什么都不写；重试是幂等的", (t) => {
  const db = tempDb(t);
  startProcess(db, memory, "a", PRESET, "开始", 0);
  const before = dump(db);
  assert.throws(() => startProcess(db, memory, "a", PRESET, "再开始", 0), /进程 ID 已存在：a/);
  assert.equal(dump(db), before);
  forkProcess(db, memory, "c", "a", undefined, 0);
  const forked = dump(db);
  assert.throws(() => forkProcess(db, memory, "c", "a", undefined, 0), /进程 ID 已存在：c/);
  assert.throws(() => forkProcess(db, memory, "a", "a", undefined, 0), /进程 ID 已存在：a/);
  assert.equal(dump(db), forked);
  assertStoreInvariants(db);
});

test("存储层不变量能抓到：信箱的输入属于不存在的进程、信的 replyTo 指向不存在的进程、turn.replyTo 或排队的信指向不存在的进程", (t) => {
  const db = twoIdle(t);
  assertStoreInvariants(db);
  const ghost: Letter = { from: { kind: "user" }, content: textContent("x"), hops: 0, replyTo: "ghost" };
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run("ghost", JSON.stringify({ kind: "stop" }));
  assert.throws(() => assertStoreInvariants(db), /不存在的进程 ghost/);
  db.prepare("DELETE FROM mailbox").run();
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run("b", JSON.stringify({ kind: "letter", letter: ghost }));
  assert.throws(() => assertStoreInvariants(db), /要回信给不存在的进程 ghost/);
  db.prepare("DELETE FROM mailbox").run();
  setTurn(db, "a", "awaitingModel", 0);
  const a = loadProcess(db, "a")!;
  assert.ok(a.phase.tag === "awaitingModel");
  saveProcess(db, { ...a, phase: { ...a.phase, turn: { ...a.phase.turn, replyTo: ["ghost"] } } });
  assert.throws(() => assertStoreInvariants(db), /要回信给不存在的进程 ghost/);
  saveProcess(db, { ...a, phase: { ...a.phase, turn: { ...a.phase.turn, queued: [ghost] } } });
  assert.throws(() => assertStoreInvariants(db), /要回信给不存在的进程 ghost/);
});
