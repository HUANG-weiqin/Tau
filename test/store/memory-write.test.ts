// writeMemory（D64 第 6 组、D81）：整批一个事务，第一个失败整批回滚；顺序有关；失败形状；brief 的缺省和更新时间。
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefOf, utf8Bytes } from "../../src/kernel/derive.ts";
import { MEMORY_VIEW_MAX_BYTES } from "../../src/kernel/tools.ts";
import type { MemoryOp } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { writeMemory } from "../../src/store/inputs.ts";
import { tempDb } from "./fixtures.ts";

const NOW = 1_700_000_000_000;
const set = (ns: string, key: string, value: string, expected: number | null = null, brief?: string): MemoryOp => ({ kind: "set", ns, key, value, expected, ...(brief === undefined ? {} : { brief }) });
const del = (ns: string, key: string, expected: number): MemoryOp => ({ kind: "delete", ns, key, expected });

test("writeMemory：成功时按顺序给每一项的版本，删除是 null；跨 ns；更新时间都是 now", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), set("b", "k", "2")], NOW), { ok: true, versions: [1, 2] });
  assert.deepEqual(writeMemory(db, memory, [del("a", "k", 1), set("b", "k", "3", 2)], NOW), { ok: true, versions: [null, 3] });
  assert.deepEqual(memory.entries("b"), [{ key: "k", value: "3", brief: "3", updated: NOW, version: 3 }]);
  assert.deepEqual(memory.entries("a"), []);
});

test("writeMemory：set 没带 brief 时用 briefOf(value)，带了就用它", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  const long = "x".repeat(300);
  assert.deepEqual(writeMemory(db, memory, [set("a", "长", long), set("a", "短", "值", null, "一句话说明")], NOW), { ok: true, versions: [1, 2] });
  assert.equal(memory.get("a", "长")?.brief, briefOf(long));
  assert.equal(briefOf(long).length, 200);
  assert.equal(memory.get("a", "短")?.brief, "一句话说明");
});

test("writeMemory：第一个失败整批回滚，前面成功的也撤销，版本号序列不前进；失败带下标和 Memory 的失败形状", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  memory.set("a", "old", { value: "旧", brief: "旧的", now: NOW }, null);
  const r = writeMemory(db, memory, [set("a", "x", "1"), set("a", "y", "2"), set("a", "old", "新", 99), set("a", "z", "3")], NOW);
  assert.deepEqual(r, { ok: false, index: 2, result: { ok: false, current: { value: "旧", brief: "旧的", updated: NOW, version: 1 } } });
  assert.deepEqual(memory.entries("a"), [{ key: "old", value: "旧", brief: "旧的", updated: NOW, version: 1 }]);
  assert.deepEqual(writeMemory(db, memory, [set("a", "n", "1")], NOW), { ok: true, versions: [2] }, "回滚的写入没有占用版本号");
  assert.equal(db.isTransaction, false);
});

test("writeMemory：删除失败也整批回滚；超限的失败带 over 和字节数", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), del("a", "none", 5)], NOW), { ok: false, index: 1, result: { ok: false, current: null } });
  assert.deepEqual(memory.entries("a"), []);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "x".repeat(4097))], NOW), { ok: false, index: 0, result: { ok: false, over: "value", bytes: 4097 } });
});

test("writeMemory：brief 超限在第 2 项时整批回滚，第 1 项也没写", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  const r = writeMemory(db, memory, [set("a", "k", "1"), set("a", "k2", "2", null, "b".repeat(201))], NOW);
  assert.deepEqual(r, { ok: false, index: 1, result: { ok: false, over: "brief", bytes: 201 } });
  assert.deepEqual(memory.entries("a"), []);
  assert.equal(db.isTransaction, false);
});

test("writeMemory：顺序有关。库满时先删后写成功，先写后删在写那一项失败，什么都不变", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  // 每行 128 字节的键、200 字节的摘要、4000 字节的值：一行连同换行是 357 + 1 字节，填到只剩不到一行。
  const key = (i: number) => `${String(i).padStart(3, "0")}${"k".repeat(125)}`;
  const line = (i: number) => utf8Bytes(`"${key(i)}" | 1970-01-01 | 4000 B | "${"摘".repeat(66)}aa"`) + 1;
  for (let i = 0; MEMORY_VIEW_MAX_BYTES - utf8Bytes(memory.view("a")) >= line(i); i++) {
    assert.equal(memory.set("a", key(i), { value: "x".repeat(4000), brief: "摘".repeat(66) + "aa", now: NOW }, null).ok, true);
  }
  const last = memory.entries("a").length - 1;
  const before = memory.entries("a");
  const r = writeMemory(db, memory, [set("a", key(last + 1), "x".repeat(4000)), del("a", key(0), 1)], NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.index, 0);
  assert.equal(!r.ok && "over" in r.result && r.result.over, "view");
  assert.deepEqual(memory.entries("a"), before, "整批回滚，删除也没做");
  const ok = writeMemory(db, memory, [del("a", key(0), 1), set("a", key(last + 1), "x".repeat(4000))], NOW);
  assert.equal(ok.ok, true, "先删后写放得下");
  assert.deepEqual(memory.entries("a").map((e) => e.key), [...before.slice(1).map((e) => e.key), key(last + 1)]);
});

test("writeMemory：同一批里同一个键可以连写，后一项用前一项给的版本", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  assert.deepEqual(writeMemory(db, memory, [set("a", "k", "1"), set("a", "k", "2", 1), del("a", "k", 2)], NOW), { ok: true, versions: [1, 2, null] });
  assert.deepEqual(memory.entries("a"), []);
});
