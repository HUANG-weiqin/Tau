// 记忆的键值实现（真库）：版本号、上限、检查顺序、视图格式；以及第 4 步关于记忆的验收。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { start } from "../../src/kernel/decide.ts";
import { utf8Bytes } from "../../src/kernel/derive.ts";
import type { Memory } from "../../src/kernel/types.ts";
import { sqliteMemory } from "../../src/memory/kv.ts";
import { runInStore } from "../../src/store/instore.ts";
import { PRESET, tempDb, toolCall } from "../store/fixtures.ts";
import { plain } from "../plain.ts";

const NS = PRESET.id;
type Plain = ReturnType<typeof plain>;

function setup(t: TestContext): { db: DatabaseSync; memory: Memory; set: (key: string, value: string, version?: number, id?: string) => Plain } {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  const set = (key: string, value: string, version?: number, id = "p1") =>
    plain(runInStore(db, memory, start(id, PRESET, { now: 0, memoryView: "" }), [], toolCall("c", "memory_set", version === undefined ? { key, value } : { key, value, version }), 0));
  return { db, memory, set };
}

const rows = (db: DatabaseSync) => db.prepare("SELECT version, ns, key, value FROM memory ORDER BY version").all();
const over = (text: string): Plain => ({ text: `超出上限，没有写入：${text}`, isError: true });

test("键、值或整个视图超出上限：给出确切的文本，库不变，版本号不前进", (t) => {
  const { db, memory, set } = setup(t);
  assert.deepEqual(set("a", "1"), { text: "已写入 a，版本 1。", isError: false });
  assert.deepEqual(set("k".repeat(128), "v"), { text: `已写入 ${"k".repeat(128)}，版本 2。`, isError: false }, "128 字节的键可以写");
  assert.deepEqual(set("v", "x".repeat(4096)), { text: "已写入 v，版本 3。", isError: false }, "4096 字节的值可以写");
  const before = rows(db);

  assert.deepEqual(set("键".repeat(43), "v"), over("键有 129 字节，上限 128 字节。"));
  assert.deepEqual(set("b", "x".repeat(4097)), over("值有 4097 字节，上限 4096 字节。"));
  for (const k of ["c", "d"]) assert.equal(set(k, "x".repeat(4096)).isError, false);
  const filled = rows(db);
  const viewBytes = utf8Bytes(memory.view(NS));
  const expected = viewBytes + 1 + utf8Bytes(`"f": "${"x".repeat(4000)}"`);
  assert.deepEqual(set("f", "x".repeat(4000)), over(`写入后记忆视图有 ${expected} 字节，上限 16384 字节。先删掉或缩短不需要的键。`));
  assert.deepEqual(memory.set(NS, "f", "x".repeat(4000), null), { ok: false, over: "view", bytes: expected });
  assert.deepEqual(memory.set(NS, "k".repeat(129), "v", null), { ok: false, over: "key", bytes: 129 });
  assert.deepEqual(memory.set(NS, "b", "值".repeat(1366), null), { ok: false, over: "value", bytes: 4098 });

  assert.deepEqual(rows(db), filled, "被拒绝的写入什么都没改");
  assert.deepEqual(filled.slice(0, before.length), before);
  const max = Math.max(...filled.map((r) => r.version as number));
  assert.deepEqual(memory.set(NS, "g", "小", null), { ok: true, version: max + 1 }, "被拒绝的写入没有用掉版本号");
});

test("视图正好 16384 字节可以写，16385 字节拒绝；在上限处用同样长的值覆盖可以写", (t) => {
  const { memory } = setup(t);
  // 每行是 `"k1": "xxx…"`，比值多 8 字节；四行之间三个换行。
  for (const k of ["k1", "k2", "k3"]) assert.equal(memory.set(NS, k, "x".repeat(4096), null).ok, true);
  const v4 = memory.set(NS, "k4", "x".repeat(16384 - 3 * 4104 - 3 - 8), null);
  assert.equal(v4.ok, true);
  assert.equal(utf8Bytes(memory.view(NS)), 16384);
  const version = v4.ok ? v4.version : 0;
  assert.deepEqual(memory.set(NS, "k4", "x".repeat(16384 - 3 * 4104 - 3 - 8 + 1), version), { ok: false, over: "view", bytes: 16385 });
  assert.deepEqual(memory.set(NS, "k5", "", null), { ok: false, over: "view", bytes: 16384 + 1 + utf8Bytes(`"k5": ""`) });
  const same = memory.set(NS, "k4", "y".repeat(16384 - 3 * 4104 - 3 - 8), version);
  assert.equal(same.ok, true, "旧的那一行不算在内");
  assert.equal(utf8Bytes(memory.view(NS)), 16384);
});

test("键里有 U+0000 或孤立的代理项：在上限处写满、用同样长的值覆盖都可以，超一字节就拒绝", (t) => {
  for (const key of ["kk", "k\u0000", "k\uD800"]) {
    const { memory } = setup(t);
    for (const k of ["k1", "k2", "k3"]) assert.equal(memory.set(NS, k, "x".repeat(4096), null).ok, true);
    const empty = memory.set(NS, key, "", null);
    assert.ok(empty.ok);
    // 值是 n 个 ASCII 字符时，视图正好 16384 字节。
    const n = 16384 - utf8Bytes(memory.view(NS));
    const full = memory.set(NS, key, "x".repeat(n), empty.version);
    assert.ok(full.ok, `${JSON.stringify(key)}：写满到上限被拒绝 ${JSON.stringify(full)}`);
    assert.equal(utf8Bytes(memory.view(NS)), 16384);
    assert.deepEqual(memory.set(NS, key, "x".repeat(n + 1), full.version), { ok: false, over: "view", bytes: 16385 });
    assert.equal(memory.set(NS, key, "y".repeat(n), full.version).ok, true, `${JSON.stringify(key)}：同样长的值覆盖被拒绝`);
    assert.equal(memory.view(NS).split("\n").length, 4);
  }
});

test("U+0000 原样存取：memory_get 给完整的值，只差在 U+0000 之后的两个键是两行", (t) => {
  const { db, memory, set } = setup(t);
  assert.deepEqual(set("cfg", "line1\u0000line2"), { text: "已写入 cfg，版本 1。", isError: false });
  const got = runInStore(db, memory, start("p1", PRESET, { now: 0, memoryView: "" }), [], toolCall("c", "memory_get", { key: "cfg" }), 0);
  assert.equal(plain(got).text, "cfg（版本 1）：\nline1\u0000line2");
  assert.equal(memory.set(NS, "a", "1", null).ok, true);
  assert.equal(memory.set(NS, "a\u0000b", "2", null).ok, true);
  assert.deepEqual(memory.get(NS, "a\u0000b"), { value: "2", version: 3 });
  assert.equal(memory.view(NS), ['"a": "1"', '"a\\u0000b": "2"', '"cfg": "line1\\u0000line2"'].join("\n"));
});

test("孤立的代理项按替换字符存：视图的上限按存下的文本算", (t) => {
  const { memory } = setup(t);
  for (const k of ["k1", "k2"]) assert.equal(memory.set(NS, k, "x".repeat(4096), null).ok, true);
  assert.deepEqual(memory.set(NS, "v", "\uD800".repeat(1365), null), { ok: true, version: 3 });
  assert.deepEqual(memory.get(NS, "v"), { value: "�".repeat(1365), version: 3 });
  assert.equal(utf8Bytes(memory.view(NS)), 2 * 4104 + 2 + utf8Bytes(`"v": "${"�".repeat(1365)}"`));
  assert.deepEqual(memory.set(NS, "\uD800", "1", null), { ok: true, version: 4 });
  assert.deepEqual(memory.set(NS, "\uDBFF", "2", null), { ok: false, current: { value: "1", version: 4 } }, "两个孤立的代理项是同一个键");
});

test("视图：每行一个键，键和值按 JSON 字符串写，按 UTF-8 字节排序；memory_get 给原值", (t) => {
  const { db, memory, set } = setup(t);
  const key = "项目: 进度\n第二行";
  const value = "第一行\n第二行: 完成 \"引号\"";
  for (const [k, v] of [["中", "3"], ["b", "2"], [key, value], ["Z", "1"]] as const) assert.equal(memory.set(NS, k, v, null).ok, true);
  assert.equal(
    memory.view(NS),
    [`"Z": "1"`, `"b": "2"`, `"中": "3"`, `${JSON.stringify(key)}: ${JSON.stringify(value)}`].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join("\n"),
  );
  assert.equal(memory.view(NS).split("\n").length, 4, "换行和冒号不会多出一行");
  assert.equal(memory.view("别的预设"), "");
  const got = runInStore(db, memory, start("p1", PRESET, { now: 0, memoryView: "" }), [], toolCall("c", "memory_get", { key }), 0);
  assert.equal(plain(got).text, `${key}（版本 3）：\n${value}`);
  assert.equal(set(key, "新", 3).isError, false);
});

test("检查顺序：键、值、版本、视图", (t) => {
  const { memory } = setup(t);
  for (const k of ["k1", "k2", "k3", "k4"]) memory.set(NS, k, "x".repeat(4000), null);
  const current = memory.get(NS, "k1");
  assert.deepEqual(memory.set(NS, "k".repeat(200), "x".repeat(5000), 99), { ok: false, over: "key", bytes: 200 });
  assert.deepEqual(memory.set(NS, "k1", "x".repeat(5000), 99), { ok: false, over: "value", bytes: 5000 }, "值太大且版本不对：报值的错");
  assert.deepEqual(memory.set(NS, "k5", "x".repeat(4000), 99), { ok: false, current: null }, "视图超出且版本不对：报冲突");
  assert.deepEqual(memory.set(NS, "k1", "x".repeat(4096), 99), { ok: false, current }, "冲突时带最新值");
});

test("两个进程写同一个键：后写的得到冲突和最新值，重试后成功", (t) => {
  const { set } = setup(t);
  assert.equal(set("城市", "北京").text, "已写入 城市，版本 1。");
  // 两个进程都读到版本 1。
  assert.deepEqual(set("城市", "上海", 1, "p1"), { text: "已写入 城市，版本 2。", isError: false });
  assert.deepEqual(set("城市", "杭州", 1, "p2"), { text: "版本冲突，没有写入。现在的值是 城市（版本 2）：\n上海", isError: true });
  assert.deepEqual(set("城市", "杭州", 2, "p2"), { text: "已写入 城市，版本 3。", isError: false });
});

test("库里还有别的键，被删的键持有最大的版本号：删掉再重建，拿旧版本号写入一定失败", (t) => {
  const { memory } = setup(t);
  memory.set(NS, "别的", "1", null);
  const top = memory.set(NS, "k", "旧", null);
  assert.deepEqual(top, { ok: true, version: 2 });
  assert.deepEqual(memory.delete(NS, "k", 2), { ok: true });
  assert.deepEqual(memory.set(NS, "k", "新", null), { ok: true, version: 3 });
  assert.deepEqual(memory.set(NS, "k", "拿旧版本号", 2), { ok: false, current: { value: "新", version: 3 } });
});

test("entries：按键的 UTF-8 字节序排，带值和版本；只给这个 ns；空库给空数组", (t) => {
  const { memory } = setup(t);
  assert.deepEqual(memory.entries(NS), []);
  memory.set(NS, "b", "2", null);
  memory.set(NS, "\u{1F600}", "表情", null); // U+1F600：UTF-8 字节序里排在 U+FF5E 之后，UTF-16 码元序里排在前面
  memory.set(NS, "～", "全角", null);
  memory.set(NS, "a", "1", null);
  memory.set("other", "z", "别的", null);
  assert.deepEqual(memory.entries(NS), [
    { key: "a", value: "1", version: 4 },
    { key: "b", value: "2", version: 1 },
    { key: "～", value: "全角", version: 3 },
    { key: "\u{1F600}", value: "表情", version: 2 },
  ]);
});

test("entries 和 namespaces：值和键里的 U+0000 不被截断", (t) => {
  const { memory } = setup(t);
  memory.set(NS, "k\u0000尾", "前\u0000后", null);
  memory.set("n\u0000s", "x", "y", null);
  assert.deepEqual(memory.entries(NS), [{ key: "k\u0000尾", value: "前\u0000后", version: 1 }]);
  assert.deepEqual(memory.namespaces(), [NS, "n\u0000s"]);
});

test("namespaces：只列有键的 ns，去重，按字节序；键删光以后不再出现；空库给空数组", (t) => {
  const { memory } = setup(t);
  assert.deepEqual(memory.namespaces(), []);
  memory.set("zeta", "a", "1", null);
  memory.set("alpha", "a", "1", null);
  memory.set("alpha", "b", "2", null);
  assert.deepEqual(memory.namespaces(), ["alpha", "zeta"]);
  memory.delete("zeta", "a", 1);
  assert.deepEqual(memory.namespaces(), ["alpha"]);
});
