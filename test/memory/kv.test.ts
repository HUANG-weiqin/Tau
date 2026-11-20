// 记忆的键值实现（真库）：版本号、上限、检查顺序、视图格式；以及第 4 步关于记忆的验收。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { start } from "../../src/kernel/decide.ts";
import { utf8Bytes } from "../../src/kernel/derive.ts";
import { MEMORY_BRIEF_MAX_BYTES, MEMORY_VALUE_MAX_BYTES, MEMORY_VIEW_MAX_BYTES } from "../../src/kernel/tools.ts";
import type { Memory } from "../../src/kernel/types.ts";
import { sqliteMemory, utcDate } from "../../src/memory/kv.ts";
import { runInStore } from "../../src/store/instore.ts";
import { PRESET, tempDb, toolCall } from "../store/fixtures.ts";
import { plain } from "../plain.ts";

const NS = PRESET.id;
/** 测试里的写入时刻：视图里的日期取它的 UTC 日期。 */
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
type Plain = ReturnType<typeof plain>;

/** 用满值的行：128 字节的键、200 字节的摘要、1000 字节的值。一行连同换行是 358 字节。 */
const MAX_KEY = "k".repeat(128);
const MAX_BRIEF = "摘".repeat(66) + "aa"; // 66 × 3 + 2 = 200 字节
const LINE = utf8Bytes(`"${MAX_KEY}" | ${utcDate(NOW)} | 1000 B | "${MAX_BRIEF}"`) + 1;

function setup(t: TestContext): { db: DatabaseSync; memory: Memory; set: (key: string, value: string, version?: number, brief?: string, id?: string) => Plain } {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  const set = (key: string, value: string, version?: number, brief = "摘要", id = "p1") =>
    plain(runInStore(db, memory, start(id, PRESET, { now: 0, memoryView: "" }), [], toolCall("c", "memory_set", version === undefined ? { key, value, brief } : { key, value, brief, version }), 0));
  return { db, memory, set };
}

const rows = (db: DatabaseSync) => db.prepare("SELECT version, ns, key, value, brief, updated FROM memory ORDER BY version").all();
const over = (text: string): Plain => ({ text: `超出上限，没有写入：${text}`, isError: true });

/** 用满长度的行（128 字节的键、200 字节的摘要、1000 字节的值）把视图填到离上限不到一行那么多。 */
function bulk(memory: Memory): void {
  for (let i = 0; MEMORY_VIEW_MAX_BYTES - utf8Bytes(memory.view(NS)) >= LINE; i++) {
    assert.equal(memory.set(NS, `${String(i).padStart(3, "0")}${"k".repeat(125)}`, { value: "x".repeat(1000), brief: MAX_BRIEF, now: NOW }, null).ok, true);
  }
}

/** 补最后一行，正好到上限：值由参数给，键用 128 字节，摘要的长度按剩下多少字节算出来。返回键和版本号。 */
function fillLast(memory: Memory, value = "x".repeat(9), prefix = "k"): { key: string; version: number } {
  const room = MEMORY_VIEW_MAX_BYTES - utf8Bytes(memory.view(NS));
  const d = String(utf8Bytes(value)).length;
  // 一行 = JSON 键 + 三个 " | "（9）+ 日期（10）+ ` B`（2）+ 字节数的位数 + JSON 摘要；前面还有一个换行。
  for (let n = 128; n >= prefix.length && n >= 1; n--) {
    const key = prefix + "k".repeat(n - prefix.length);
    if (utf8Bytes(key.toWellFormed()) > 128) continue;
    const brief = room - 24 - utf8Bytes(JSON.stringify(key.toWellFormed())) - d;
    if (brief < 0 || brief > MEMORY_BRIEF_MAX_BYTES) continue;
    const r = memory.set(NS, key, { value, brief: "b".repeat(brief), now: NOW }, null);
    assert.ok(r.ok, `补最后一行被拒绝 ${JSON.stringify(r)}`);
    assert.equal(utf8Bytes(memory.view(NS)), MEMORY_VIEW_MAX_BYTES);
    return { key, version: r.version };
  }
  assert.fail(`没有长度能正好补满剩下的 ${room} 字节`);
}

test("键、值或摘要超出上限：给出确切的文本，库不变，版本号不前进", (t) => {
  const { db, memory, set } = setup(t);
  assert.deepEqual(set("a", "1"), { text: "已写入 a，版本 1。", isError: false });
  assert.deepEqual(set(MAX_KEY, "v"), { text: `已写入 ${MAX_KEY}，版本 2。`, isError: false }, "128 字节的键可以写");
  assert.deepEqual(set("v", "x".repeat(4096)), { text: "已写入 v，版本 3。", isError: false }, "4096 字节的值可以写");
  assert.deepEqual(set("b", "短", undefined, "b".repeat(200)), { text: "已写入 b，版本 4。", isError: false }, "200 字节的摘要可以写");
  const before = rows(db);

  assert.deepEqual(set("键".repeat(43), "v"), over("键有 129 字节，上限 128 字节。"));
  assert.deepEqual(set("c", "x".repeat(4097)), over("值有 4097 字节，上限 4096 字节。一个汉字占 3 字节。把内容拆成几个键，或者写进文件。"));
  assert.deepEqual(set("c", "v", undefined, "b".repeat(201)), over("摘要有 201 字节，上限 200 字节。"));
  assert.deepEqual(memory.set(NS, "c", { value: "v", brief: "b".repeat(201), now: NOW }, null), { ok: false, over: "brief", bytes: 201 });
  assert.deepEqual(memory.set(NS, "k".repeat(129), { value: "v", brief: "摘要", now: NOW }, null), { ok: false, over: "key", bytes: 129 });
  assert.deepEqual(memory.set(NS, "c", { value: "值".repeat(1366), brief: "摘要", now: NOW }, null), { ok: false, over: "value", bytes: 4098 });

  assert.deepEqual(rows(db), before, "被拒绝的写入什么都没改");
  const max = Math.max(...before.map((r) => r.version as number));
  assert.deepEqual(memory.set(NS, "g", { value: "小", brief: "摘要", now: NOW }, null), { ok: true, version: max + 1 }, "被拒绝的写入没有用掉版本号");
});

test(`视图正好 ${MEMORY_VIEW_MAX_BYTES} 字节可以写，多 1 字节拒绝：视图的上限量的是渲染后的索引`, (t) => {
  const { db, memory, set } = setup(t);
  bulk(memory);
  const { key, version } = fillLast(memory);
  const filled = rows(db);
  const brief = memory.get(NS, key)!.brief;

  // 值从 9 字节变成 10 字节：字节数多一位，行也长 1 字节。
  const tooBig = MEMORY_VIEW_MAX_BYTES + 1;
  assert.deepEqual(memory.set(NS, key, { value: "x".repeat(10), brief, now: NOW }, version), { ok: false, over: "view", bytes: tooBig });
  assert.deepEqual(set(key, "x".repeat(10), version, brief), over(`写入后记忆视图有 ${tooBig} 字节，上限 ${MEMORY_VIEW_MAX_BYTES} 字节。先删掉不需要的键，或缩短键和摘要。`));
  assert.deepEqual(rows(db), filled, "被拒绝的写入什么都没改");
  assert.equal(memory.set(NS, key, { value: "x".repeat(9), brief, now: NOW }, version).ok, true, "旧的那一行不算在内：同样长的值覆盖可以写");
  assert.equal(utf8Bytes(memory.view(NS)), MEMORY_VIEW_MAX_BYTES);

  // 再加一个键也放不下。
  assert.deepEqual(memory.set(NS, "另一个", { value: "", brief: "", now: NOW }, null), { ok: false, over: "view", bytes: MEMORY_VIEW_MAX_BYTES + utf8Bytes('\n"另一个" | 2026-11-19 | 0 B | ""') });
});

test("键里有 U+0000 或孤立的代理项：在上限处写满、用同样长的值覆盖都可以，超一字节就拒绝", (t) => {
  for (const prefix of ["kk", "k\u0000", "k\uD800"]) {
    const { memory } = setup(t);
    bulk(memory);
    const lines = memory.view(NS).split("\n").length;
    const { key, version } = fillLast(memory, "x".repeat(9), prefix);
    const brief = memory.get(NS, key)!.brief;
    assert.deepEqual(memory.set(NS, key, { value: "x".repeat(10), brief, now: NOW }, version), { ok: false, over: "view", bytes: MEMORY_VIEW_MAX_BYTES + 1 });
    assert.equal(memory.set(NS, key, { value: "x".repeat(9), brief, now: NOW }, version).ok, true, `${JSON.stringify(prefix)}：同样长的值覆盖被拒绝`);
    assert.equal(memory.view(NS).split("\n").length, lines + 1);
  }
});

test("视图是索引：每行一个键，键和摘要按 JSON 字符串写，按 UTF-8 字节排序；没有值", (t) => {
  const { memory } = setup(t);
  const key = '项目: 进度\n第二行"引号"';
  const value = "第一行\n第二行: 完成";
  for (const [k, v, b] of [["中", "杭州", "数字"], ["b", "两行", "乙"], [key, value, "进度"], ["Z", "一条", "甲"]] as const) {
    assert.equal(memory.set(NS, k, { value: v, brief: b, now: NOW }, null).ok, true);
  }
  const line = (k: string, v: string, b: string) => `${JSON.stringify(k)} | ${utcDate(NOW)} | ${utf8Bytes(v)} B | ${JSON.stringify(b)}`;
  assert.equal(memory.view(NS), [line("Z", "一条", "甲"), line("b", "两行", "乙"), line("中", "杭州", "数字"), line(key, value, "进度")].join("\n"));
  assert.equal(memory.view(NS).split("\n").length, 4, "键和摘要里的换行不会多出一行");
  for (const v of ["杭州", "两行", "一条", "第一行"]) assert.equal(memory.view(NS).includes(v), false, `视图里没有值 ${JSON.stringify(v)}`);
  assert.equal(memory.view("别的预设"), "");
});

test("字节数是值的 UTF-8 字节数；日期是 put.now 的 UTC 日期", (t) => {
  const { memory } = setup(t);
  memory.set(NS, "城市", { value: "住在上海", brief: "住在哪", now: Date.UTC(2026, 10, 19, 23, 59, 59, 999) }, null);
  assert.equal(memory.view(NS), `"城市" | 2026-11-19 | 12 B | "住在哪"`);
  const v = memory.set(NS, "城市", { value: "住在上海", brief: "住在哪", now: Date.UTC(2026, 10, 20, 0, 0, 0) }, 1);
  assert.equal(v.ok, true);
  assert.equal(memory.view(NS), `"城市" | 2026-11-20 | 12 B | "住在哪"`, "日期换成新的 now，值的字节数不变");
});

test("值从 999 字节变成 1000 字节：视图多 1 字节，上限处的检查按新的一行算", (t) => {
  const { memory } = setup(t);
  const small = memory.set(NS, "k", { value: "x".repeat(999), brief: "摘要", now: NOW }, null);
  assert.ok(small.ok);
  const at999 = utf8Bytes(memory.view(NS));
  const big = memory.set(NS, "k", { value: "x".repeat(1000), brief: "摘要", now: NOW }, small.version);
  assert.equal(big.ok, true);
  assert.equal(utf8Bytes(memory.view(NS)), at999 + 1, "字节数多一位，行也长 1 字节");

  // 在上限处：最后一行是 999 字节的值，改成 1000 字节就多 1 字节，被拒绝。
  const { memory: full } = setup(t);
  bulk(full);
  const { key, version } = fillLast(full, "x".repeat(999));
  const brief = full.get(NS, key)!.brief;
  assert.deepEqual(full.set(NS, key, { value: "x".repeat(1000), brief, now: NOW }, version), { ok: false, over: "view", bytes: MEMORY_VIEW_MAX_BYTES + 1 });
  assert.equal(full.set(NS, key, { value: "x".repeat(999), brief, now: NOW }, version).ok, true, "同样长的值覆盖可以写");
});

test("U+0000 原样存取：memory_get 给完整的值和摘要；只差在 U+0000 之后的两个键是两行", (t) => {
  const { db, memory, set } = setup(t);
  assert.deepEqual(set("cfg", "line1\u0000line2", undefined, "配置\u0000说明"), { text: "已写入 cfg，版本 1。", isError: false });
  const got = runInStore(db, memory, start("p1", PRESET, { now: 0, memoryView: "" }), [], toolCall("c", "memory_get", { key: "cfg" }), 0);
  assert.equal(plain(got).text, "cfg（版本 1，更新 1970-01-01）：\n摘要：配置\u0000说明\nline1\u0000line2");
  assert.equal(memory.set(NS, "a", { value: "1", brief: "甲", now: NOW }, null).ok, true);
  assert.equal(memory.set(NS, "a\u0000b", { value: "2", brief: "乙", now: NOW }, null).ok, true);
  assert.deepEqual(memory.get(NS, "a\u0000b"), { value: "2", brief: "乙", updated: NOW, version: 3 });
  assert.equal(memory.view(NS), ['"a" | 2026-11-19 | 1 B | "甲"', '"a\\u0000b" | 2026-11-19 | 1 B | "乙"', '"cfg" | 1970-01-01 | 11 B | "配置\\u0000说明"'].join("\n"));
});

test("孤立的代理项按替换字符存：值、摘要、键都是；量的和存的是同一份文本", (t) => {
  const { memory } = setup(t);
  assert.deepEqual(memory.set(NS, "v", { value: "\uD800".repeat(1365), brief: "\uD800".repeat(66), now: NOW }, null), { ok: true, version: 1 });
  assert.deepEqual(memory.get(NS, "v"), { value: "�".repeat(1365), brief: "�".repeat(66), updated: NOW, version: 1 });
  assert.equal(memory.view(NS), `"v" | 2026-11-19 | 4095 B | "${"�".repeat(66)}"`);
  assert.deepEqual(memory.set(NS, "\uD800", { value: "1", brief: "甲", now: NOW }, null), { ok: true, version: 2 });
  assert.deepEqual(memory.set(NS, "\uDBFF", { value: "2", brief: "乙", now: NOW }, null), { ok: false, current: { value: "1", brief: "甲", updated: NOW, version: 2 } }, "两个孤立的代理项是同一个键");
});

test("get 和 entries 带摘要和更新时间；entries 按键的 UTF-8 字节序排，只给这个 ns，空库给空数组", (t) => {
  const { memory } = setup(t);
  assert.deepEqual(memory.entries(NS), []);
  memory.set(NS, "b", { value: "2", brief: "乙", now: 20 }, null);
  memory.set(NS, "\u{1F600}", { value: "表情", brief: "笑脸", now: 21 }, null); // U+1F600：UTF-8 字节序里排在 U+FF5E 之后，UTF-16 码元序里排在前面
  memory.set(NS, "～", { value: "全角", brief: "波浪", now: 22 }, null);
  memory.set("other", "z", { value: "别的", brief: "丙", now: 23 }, null);
  assert.deepEqual(memory.get(NS, "b"), { value: "2", brief: "乙", updated: 20, version: 1 });
  assert.deepEqual(memory.entries(NS), [
    { key: "b", value: "2", brief: "乙", updated: 20, version: 1 },
    { key: "～", value: "全角", brief: "波浪", updated: 22, version: 3 },
    { key: "\u{1F600}", value: "表情", brief: "笑脸", updated: 21, version: 2 },
  ]);
  assert.equal(memory.view(NS), memory.entries(NS).map((e) => `${JSON.stringify(e.key)} | ${utcDate(e.updated)} | ${utf8Bytes(e.value)} B | ${JSON.stringify(e.brief)}`).join("\n"));
});

test("检查顺序：键、值、摘要、版本、视图", (t) => {
  const { memory } = setup(t);
  for (const k of ["k1", "k2", "k3", "k4"]) memory.set(NS, k, { value: "x".repeat(4000), brief: "摘要", now: NOW }, null);
  const current = memory.get(NS, "k1");
  assert.deepEqual(memory.set(NS, "k".repeat(200), { value: "x".repeat(5000), brief: "b".repeat(300), now: NOW }, 99), { ok: false, over: "key", bytes: 200 });
  assert.deepEqual(memory.set(NS, "k1", { value: "x".repeat(5000), brief: "b".repeat(300), now: NOW }, 99), { ok: false, over: "value", bytes: 5000 }, "值太大且版本不对：报值的错");
  assert.deepEqual(memory.set(NS, "k1", { value: "v", brief: "b".repeat(201), now: NOW }, 99), { ok: false, over: "brief", bytes: 201 }, "摘要太大且版本不对：报摘要的错");
  assert.deepEqual(memory.set(NS, "k5", { value: "x".repeat(4000), brief: "摘要", now: NOW }, 99), { ok: false, current: null }, "视图超出且版本不对：报冲突");
  assert.deepEqual(memory.set(NS, "k1", { value: "x".repeat(4096), brief: "摘要", now: NOW }, 99), { ok: false, current }, "冲突时带最新值");
});

test("两个进程写同一个键：后写的得到冲突和最新值，重试后成功", (t) => {
  const { set } = setup(t);
  assert.equal(set("城市", "北京", undefined, "首都").text, "已写入 城市，版本 1。");
  // 两个进程都读到版本 1。
  assert.deepEqual(set("城市", "上海", 1, "现在住的地方", "p1"), { text: "已写入 城市，版本 2。", isError: false });
  assert.deepEqual(set("城市", "杭州", 1, "现在住的地方", "p2"), { text: "版本冲突，没有写入。现在的值是 城市（版本 2，更新 1970-01-01）：\n摘要：现在住的地方\n上海\n要覆盖，带 version=2 再写一次。", isError: true });
  assert.deepEqual(set("城市", "杭州", 2, "现在住的地方", "p2"), { text: "已写入 城市，版本 3。", isError: false });
});

test("库里还有别的键，被删的键持有最大的版本号：删掉再重建，拿旧版本号写入一定失败", (t) => {
  const { memory } = setup(t);
  memory.set(NS, "别的", { value: "1", brief: "甲", now: NOW }, null);
  const top = memory.set(NS, "k", { value: "旧", brief: "乙", now: NOW }, null);
  assert.deepEqual(top, { ok: true, version: 2 });
  assert.deepEqual(memory.delete(NS, "k", 2), { ok: true });
  assert.deepEqual(memory.set(NS, "k", { value: "新", brief: "丙", now: NOW }, null), { ok: true, version: 3 });
  assert.deepEqual(memory.set(NS, "k", { value: "拿旧版本号", brief: "丁", now: NOW }, 2), { ok: false, current: { value: "新", brief: "丙", updated: NOW, version: 3 } });
});

test("entries 和 namespaces：值和键里的 U+0000 不被截断", (t) => {
  const { memory } = setup(t);
  memory.set(NS, "k\u0000尾", { value: "前\u0000后", brief: "中\u0000段", now: NOW }, null);
  memory.set("n\u0000s", "x", { value: "y", brief: "摘要", now: NOW }, null);
  assert.equal(memory.entries(NS)[0]?.value, "前\u0000后");
  assert.equal(memory.entries(NS)[0]?.brief, "中\u0000段");
  assert.deepEqual(memory.namespaces(), [NS, "n\u0000s"]);
});

test("namespaces：只列有键的 ns，去重，按字节序；键删光以后不再出现；空库给空数组", (t) => {
  const { memory } = setup(t);
  assert.deepEqual(memory.namespaces(), []);
  memory.set("zeta", "a", { value: "1", brief: "甲", now: NOW }, null);
  memory.set("alpha", "a", { value: "1", brief: "甲", now: NOW }, null);
  memory.set("alpha", "b", { value: "2", brief: "乙", now: NOW }, null);
  assert.deepEqual(memory.namespaces(), ["alpha", "zeta"]);
  memory.delete("zeta", "a", 1);
  assert.deepEqual(memory.namespaces(), ["alpha"]);
});

test("utcDate：UTC 的 YYYY-MM-DD，差 1 毫秒差一天", () => {
  assert.equal(utcDate(0), "1970-01-01");
  assert.equal(utcDate(Date.parse("2026-11-19T23:59:59.999Z")), "2026-11-19");
  assert.equal(utcDate(Date.parse("2026-11-20T00:00:00.000Z")), "2026-11-20");
});
