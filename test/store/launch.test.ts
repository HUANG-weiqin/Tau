// 设计稿 5.6 启动检查：固定部分加记忆的上界要低于阈值，`start` 和 `spawn` 都查；不通过什么都不建。
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedTokens, handoffThreshold, startError } from "../../src/kernel/derive.ts";
import type { PresetSnapshot, Process, ToolDef } from "../../src/kernel/types.ts";
import { loadProcess, loadProcesses, tx } from "../../src/store/db.ts";
import { startProcess } from "../../src/store/inputs.ts";
import { runInStore } from "../../src/store/instore.ts";
import { fakeMemory, mailbox, PRESET, tempDb, toolCall } from "./fixtures.ts";
import { plain } from "../plain.ts";

/** 固定部分 + 记忆的上界刚好够和刚好不够的两个窗口。 */
function edge(tools: PresetSnapshot["tools"]): { ok: PresetSnapshot; bad: PresetSnapshot } {
  const base: PresetSnapshot = { ...PRESET, id: "edge", tools };
  let W = 20_000;
  while (startError({ ...base, contextWindow: W }) !== null) W++;
  return { ok: { ...base, contextWindow: W }, bad: { ...base, contextWindow: W - 1 } };
}

test("startError：刚好够的窗口通过，少 1 个 token 的窗口挡住；报出固定部分、记忆的上界和阈值", () => {
  const { ok, bad } = edge(["read", "memory"]);
  assert.equal(startError(ok), null);
  const m = /固定部分 (\d+) token，记忆的上界 (\d+) token，换段阈值 (\d+) token/.exec(startError(bad) ?? "");
  assert.ok(m);
  assert.equal(Number(m[3]), handoffThreshold(bad));
  assert.ok(Number(m[2]) > 8_000, "记忆的上界是 16 KiB 的 token 数加标题");
  assert.ok(Number(m[1]) + Number(m[2]) >= Number(m[3]));
  // 没有 memory 工具，记忆的上界是 0。
  const plainEdge = edge(["read"]);
  assert.match(startError(plainEdge.bad) ?? "", /记忆的上界 0 token/);
  assert.ok(plainEdge.ok.contextWindow < ok.contextWindow);
});

test("阈值不大于 0 的小窗口也被挡住；收图片的预设阈值更低，要更大的窗口", () => {
  assert.ok(startError({ ...PRESET, contextWindow: 20_000 }) !== null);
  const text = edge(["read", "memory"]).ok;
  const seen = edge(["read", "memory"]);
  assert.equal(startError({ ...seen.ok, input: ["text", "image"] }) === null, false);
  assert.equal(startError({ ...text, input: ["text", "image"], contextWindow: text.contextWindow + 14_000 }), null);
});

test("start：检查不通过就抛错，信箱和进程表都是空的；通过就照常", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { ok, bad } = edge(["read", "memory"]);
  assert.throws(() => startProcess(db, memory, "p1", bad, "你好", 0), /窗口太小.*固定部分 \d+ token，记忆的上界 \d+ token，换段阈值 \d+ token/);
  assert.equal(loadProcesses(db).length, 0);
  assert.equal(mailbox(db).length, 0);
  startProcess(db, memory, "p1", ok, "你好", 0);
  assert.equal(loadProcesses(db).length, 1);
  assert.equal(mailbox(db).length, 1);
});

test("spawn：预设通不过检查就是错误结果，不建进程、不寄信；通得过就建", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { ok, bad } = edge(["read", "memory"]);
  const boss: PresetSnapshot = { ...PRESET, id: "boss", tools: ["agents"] };
  startProcess(db, memory, "a", boss, "开始", 0);
  db.exec("DELETE FROM mailbox");
  const p: Process = { ...loadProcess(db, "a")!, lastEffect: 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } };
  const readPreset = (id: string): PresetSnapshot => (id === "bad" ? bad : ok);
  const spawn = (preset: string) => plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", { preset, text: "做" }), 0, readPreset)));
  const r = spawn("bad");
  assert.equal(r.isError, true);
  assert.match(r.text, /窗口太小.*固定部分 \d+ token，记忆的上界 \d+ token，换段阈值 \d+ token/);
  assert.equal(loadProcesses(db).length, 1, "只有 a");
  assert.equal(mailbox(db).length, 0);
  assert.equal(spawn("ok").isError, false);
  assert.equal(loadProcesses(db).length, 2);
  assert.equal(mailbox(db).length, 1);
});

// 启动检查算上工具定义：工具描述在固定部分里（设计稿 5.5、5.6）。

const bigDef = (name: string, chars: number): ToolDef => ({ name, description: "字".repeat(chars), parameters: { type: "object" }, command: "echo", timeout: 120, output: "text" });

/** 窗口刚好够和刚好不够的两个预设：多出来的是工具定义。 */
function defEdge(): { ok: PresetSnapshot; bad: PresetSnapshot; without: PresetSnapshot } {
  const base: PresetSnapshot = { ...PRESET, id: "defs", tools: ["read"], toolDefs: [bigDef("a", 5000), bigDef("b", 5000)] };
  let W = 20_000;
  while (startError({ ...base, contextWindow: W }) !== null) W++;
  return { ok: { ...base, contextWindow: W }, bad: { ...base, contextWindow: W - 1 }, without: { ...base, toolDefs: [], contextWindow: W - 1 } };
}

test("startError：工具定义大到让固定部分到阈值，就挡住；同样的窗口不带定义能通过", () => {
  const { ok, bad, without } = defEdge();
  assert.equal(startError(ok), null);
  assert.match(startError(bad) ?? "", /窗口太小/);
  assert.equal(startError(without), null, "挡住它的是工具定义");
  assert.ok(fixedTokens(bad) - fixedTokens(without) >= 2 * 5000 * 3 / 2, "固定部分多了两个定义的 token");
});

test("start：工具定义让检查不通过就抛错，什么都不建", (t) => {
  const db = tempDb(t);
  const { ok, bad } = defEdge();
  assert.throws(() => startProcess(db, fakeMemory(), "p1", bad, "你好", 0), /窗口太小/);
  assert.equal(loadProcesses(db).length, 0);
  assert.equal(mailbox(db).length, 0);
  startProcess(db, fakeMemory(), "p1", ok, "你好", 0);
  assert.equal(loadProcesses(db).length, 1);
});

test("spawn：工具定义让检查不通过就是错误结果，什么都不建", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const { ok, bad } = defEdge();
  startProcess(db, memory, "a", { ...PRESET, id: "boss", tools: ["agents"] }, "开始", 0);
  db.exec("DELETE FROM mailbox");
  const p: Process = { ...loadProcess(db, "a")!, lastEffect: 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: 0, replyTo: [] } } };
  const readPreset = (id: string): PresetSnapshot => (id === "bad" ? bad : ok);
  const spawn = (preset: string) => plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", "spawn", { preset, text: "做" }), 0, readPreset)));
  const r = spawn("bad");
  assert.equal(r.isError, true);
  assert.match(r.text, /窗口太小/);
  assert.equal(loadProcesses(db).length, 1);
  assert.equal(mailbox(db).length, 0);
  assert.equal(spawn("ok").isError, false);
  assert.equal(loadProcess(db, loadProcesses(db).find((x) => x.parent === "a")!.id)?.preset.toolDefs.length, 2, "子进程的快照冻结了定义");
});

test("预设的 handoff：冻结进库里的快照；低到放不下固定部分，start 抛错，什么都不建", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const base: PresetSnapshot = { ...PRESET, id: "low", tools: ["read"], contextWindow: 200_000 };
  startProcess(db, memory, "p1", { ...base, handoff: 50_000 }, "你好", 0);
  assert.equal(loadProcess(db, "p1")?.preset.handoff, 50_000);
  assert.throws(() => startProcess(db, memory, "p2", { ...base, handoff: fixedTokens(base) }, "你好", 0), new RegExp(`窗口太小.*换段阈值 ${fixedTokens(base)} token`));
  assert.equal(loadProcess(db, "p2"), undefined);
  assert.equal(loadProcesses(db).length, 1);
});
