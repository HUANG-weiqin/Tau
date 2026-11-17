// writeMemory（D64 第 6 组）：整批一个事务，第一个失败整批回滚；顺序有关；失败形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryOp } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { writeMemory } from "../../src/store/inputs.ts";
import { tempDb } from "./fixtures.ts";

const set = (ns: string, key: string, value: string, expected: number | null = null): MemoryOp => ({ kind: "set", ns, key, value, expected });
const del = (ns: string, key: string, expected: number): MemoryOp => ({ kind: "delete", ns, key, expected });

test("writeMemory：成功时按顺序给每一项的版本，删除是 null；跨 ns", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), set("b", "k", "2")]), { ok: true, versions: [1, 2] });
  assert.deepEqual(writeMemory(db, memory, [del("a", "k", 1), set("b", "k", "3", 2)]), { ok: true, versions: [null, 3] });
  assert.deepEqual(memory.entries("b"), [{ key: "k", value: "3", version: 3 }]);
  assert.deepEqual(memory.entries("a"), []);
});

test("writeMemory：第一个失败整批回滚，前面成功的也撤销，版本号序列不前进；失败带下标和 Memory 的失败形状", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  memory.set("a", "old", "旧", null);
  const r = writeMemory(db, memory, [set("a", "x", "1"), set("a", "y", "2"), set("a", "old", "新", 99), set("a", "z", "3")]);
  assert.deepEqual(r, { ok: false, index: 2, result: { ok: false, current: { value: "旧", version: 1 } } });
  assert.deepEqual(memory.entries("a"), [{ key: "old", value: "旧", version: 1 }]);
  assert.deepEqual(writeMemory(db, memory, [set("a", "n", "1")]), { ok: true, versions: [2] }, "回滚的写入没有占用版本号");
  assert.equal(db.isTransaction, false);
});

test("writeMemory：删除失败也整批回滚；超限的失败带 over 和字节数", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), del("a", "none", 5)]), { ok: false, index: 1, result: { ok: false, current: null } });
  assert.deepEqual(memory.entries("a"), []);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "x".repeat(4097))]), { ok: false, index: 0, result: { ok: false, over: "value", bytes: 4097 } });
});

test("writeMemory：顺序有关。库满时先删后写成功，先写后删在写那一项失败，什么都不变", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  for (const k of ["k1", "k2", "k3", "k4"]) memory.set("a", k, "x".repeat(4000), null);
  const before = memory.entries("a");
  const r = writeMemory(db, memory, [set("a", "k5", "x".repeat(4000)), del("a", "k1", 1)]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.index, 0);
  assert.equal(!r.ok && "over" in r.result && r.result.over, "view");
  assert.deepEqual(memory.entries("a"), before);
  const ok = writeMemory(db, memory, [del("a", "k1", 1), set("a", "k5", "x".repeat(4000))]);
  assert.equal(ok.ok, true);
  assert.deepEqual(memory.entries("a").map((e) => e.key), ["k2", "k3", "k4", "k5"]);
});

test("writeMemory：同一批里同一个键可以连写，后一项用前一项给的版本", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), set("a", "k", "2", 1), del("a", "k", 2)]), { ok: true, versions: [1, 2, null] });
  assert.deepEqual(memory.entries("a"), []);
});
