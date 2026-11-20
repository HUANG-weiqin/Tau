// 记忆工具的接线：模型调用 → 处理输入的事务 → 真库里的 brief、updated；结果文字带摘要和更新日期。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Input, ToolCall } from "../../src/kernel/types.ts";
import { sqliteMemory, utcDate } from "../../src/memory/kv.ts";
import { handleNext, startProcess } from "../../src/store/inputs.ts";
import { textOfResult } from "../plain.ts";
import { PRESET, tempDb, toolCall, use } from "./fixtures.ts";

const NOW = Date.UTC(2026, 10, 19, 8, 0, 0);

/** 模型回复带着这些工具调用。 */
const modelCalls = (n: number, calls: ToolCall[]): Input => ({ kind: "modelResult", n, outcome: { status: "ok", message: use(...calls) } });

const memoryRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT CAST(key AS BLOB) AS key, CAST(value AS BLOB) AS value, CAST(brief AS BLOB) AS brief, updated, version FROM memory ORDER BY version")
    .all()
    .map((r) => ({ key: Buffer.from(r.key as Uint8Array).toString("utf8"), value: Buffer.from(r.value as Uint8Array).toString("utf8"), brief: Buffer.from(r.brief as Uint8Array).toString("utf8"), updated: r.updated as number, version: r.version as number }));

/** 信箱里编号 `n` 的工具结果的文字和 isError。 */
const toolResult = (db: DatabaseSync, n: number) => {
  const row = db.prepare("SELECT input_json FROM mailbox ORDER BY seq").all().map((r) => JSON.parse(r.input_json as string) as Input).find((i) => i.kind === "toolResult" && i.n === n);
  assert.ok(row && row.kind === "toolResult" && row.outcome.status === "ok");
  return { text: textOfResult(row.outcome.content), isError: row.outcome.content.isError === true };
};

/** 信箱里编号 `n` 的工具结果的文字。 */
const toolText = (db: DatabaseSync, n: number): string => toolResult(db, n).text;

test("模型调 memory_set：库里那一行的 updated 是这条输入的 now，摘要照写；结果文字是“已写入”", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  startProcess(db, memory, "p1", PRESET, "开始", 0);
  handleNext(db, memory, 0); // 建进程，等模型（副作用 1）
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run("p1", JSON.stringify(modelCalls(1, [toolCall("c1", "memory_set", { key: "城市", value: "杭州", brief: "住在哪" })])));
  // 第一条输入的 now 进 updated；brief 是模型写的。
  handleNext(db, memory, NOW);
  assert.deepEqual(memoryRows(db), [{ key: "城市", value: "杭州", brief: "住在哪", updated: NOW, version: 1 }]);
  assert.equal(toolText(db, 2), "已写入 城市，版本 1。");
});

test("模型调 memory_get 和 memory_set：结果的文字带摘要、更新日期和版本；版本冲突的结果带摘要", (t) => {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  startProcess(db, memory, "p1", PRESET, "开始", 0);
  handleNext(db, memory, 0);
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run("p1", JSON.stringify(modelCalls(1, [toolCall("c1", "memory_set", { key: "城市", value: "杭州", brief: "住在哪" })])));
  handleNext(db, memory, NOW);
  handleNext(db, memory, NOW); // 处理这条工具结果，回到等模型
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run(
    "p1",
    JSON.stringify(modelCalls(3, [toolCall("c2", "memory_get", { key: "城市" }), toolCall("c3", "memory_set", { key: "城市", value: "苏州", brief: "换城市了", version: 99 })])),
  );
  handleNext(db, memory, NOW); // 执行 memory_get
  assert.equal(toolText(db, 4), `城市（版本 1，更新 ${utcDate(NOW)}）：\n摘要：住在哪\n杭州`);
  handleNext(db, memory, NOW); // 处理 memory_get 的结果，执行 memory_set
  assert.equal(toolText(db, 5), `版本冲突，没有写入。现在的值是 城市（版本 1，更新 ${utcDate(NOW)}）：\n摘要：住在哪\n杭州\n要覆盖，带 version=<现在的版本号> 再写一次。`);
  assert.deepEqual(memoryRows(db), [{ key: "城市", value: "杭州", brief: "住在哪", updated: NOW, version: 1 }], "冲突没有写入");
});

/** 一条记忆工具的调用走完整的接线：建进程，可选的初始值，模型调用这个工具，返回工具结果的文字和 isError。 */
function callTool(t: TestContext, name: string, args: JsonObject, seed?: { value: string; brief: string }) {
  const db = tempDb(t);
  const memory = sqliteMemory(db);
  startProcess(db, memory, "p1", PRESET, "开始", 0);
  handleNext(db, memory, 0);
  if (seed) assert.equal(memory.set(PRESET.id, "笔记", { ...seed, now: 0 }, null).ok, true);
  db.prepare("INSERT INTO mailbox (process_id, input_json) VALUES (?, ?)").run("p1", JSON.stringify(modelCalls(1, [toolCall("c1", name, args)])));
  handleNext(db, memory, NOW);
  return { db, memory, r: toolResult(db, 2) };
}

test("memory_edit 的参数：old 不能为空，version 必填且是整数，brief 给了必须是字符串，必填是 null 就报 null；都不碰记忆", (t) => {
  const cases: [JsonObject, string][] = [
    [{ key: "笔记", old: "", new: "乙", version: 1 }, "参数错误：old 不能为空。"],
    [{ key: "笔记", old: "甲", new: "乙" }, "参数错误：version 必须是整数。先用 memory_get 读到现在的版本号。"],
    [{ key: "笔记", old: "甲", new: "乙", version: 1.5 }, "参数错误：version 必须是整数。先用 memory_get 读到现在的版本号。"],
    [{ key: "笔记", old: "甲", new: "乙", version: 1, brief: ["x"] }, "参数错误：brief 必须是字符串，或者省略。"],
    [{ key: "笔记", old: "甲", new: null, version: 1 }, "参数 new 是 null，必须给出一个值。"],
    [{ key: "笔记", old: "甲", new: "乙", version: null }, "参数 version 是 null，必须给出一个值。"],
    [{ key: "笔记", old: "甲" }, "参数错误：memory_edit 缺少 new（字符串）。收到的参数名：key, old。"],
  ];
  for (const [args, want] of cases) {
    const { db, r } = callTool(t, "memory_edit", args);
    assert.deepEqual(r, { text: want, isError: true }, JSON.stringify(args));
    assert.deepEqual(memoryRows(db), [], JSON.stringify(args));
  }
});

test("memory_edit：键不存在时让它用 memory_set，不写入", (t) => {
  const { memory, r } = callTool(t, "memory_edit", { key: "笔记", old: "甲", new: "乙", version: 1 });
  assert.deepEqual(r, { text: "键 笔记 不存在。要新建，用 memory_set。", isError: true });
  assert.equal(memory.get(PRESET.id, "笔记"), null);
});

test("memory_edit：版本对不上，和 memory_set 一样报冲突并带最新值，不写入", (t) => {
  const { memory, r } = callTool(t, "memory_edit", { key: "笔记", old: "甲", new: "乙", version: 99 }, { value: "甲", brief: "摘要" });
  assert.deepEqual(r, { text: `版本冲突，没有写入。现在的值是 笔记（版本 1，更新 ${utcDate(0)}）：\n摘要：摘要\n甲`, isError: true });
  assert.deepEqual(memory.get(PRESET.id, "笔记")?.version, 1);
});

test("memory_edit：old 没找到、出现多次都是 isError，不写入", (t) => {
  const miss = callTool(t, "memory_edit", { key: "笔记", old: "丁", new: "乙", version: 1 }, { value: "甲 乙 丙", brief: "摘要" });
  assert.deepEqual(miss.r, { text: "没找到原文，没有写入。old 必须和值逐字一致，包括标点、空格和换行；先用 memory_get 看现在的值。", isError: true });
  assert.deepEqual(miss.memory.get(PRESET.id, "笔记")?.value, "甲 乙 丙");
  const many = callTool(t, "memory_edit", { key: "笔记", old: "甲", new: "乙", version: 1 }, { value: "甲和甲", brief: "摘要" });
  assert.deepEqual(many.r, { text: "原文出现 2 次，必须唯一，没有写入。把 old 写长一点，带上前后的字。", isError: true });
  assert.deepEqual(many.memory.get(PRESET.id, "笔记")?.value, "甲和甲");
});

test("memory_edit：替换后超出上限，走 memory_set 的 over 分支，原值不变", (t) => {
  const long = callTool(t, "memory_edit", { key: "笔记", old: "x".repeat(4000), new: "y".repeat(4100), version: 1 }, { value: "x".repeat(4000), brief: "摘要" });
  assert.deepEqual(long.r, { text: "超出上限，没有写入：值有 4100 字节，上限 4096 字节。一个汉字占 3 字节。把内容拆成几个键，或者写进文件。", isError: true });
  assert.equal(long.memory.get(PRESET.id, "笔记")?.value, "x".repeat(4000));
  assert.equal(long.memory.get(PRESET.id, "笔记")?.version, 1);
  const brief = callTool(t, "memory_edit", { key: "笔记", old: "乙", new: "丁", version: 1, brief: "摘".repeat(70) }, { value: "甲乙丙", brief: "摘要" });
  assert.deepEqual(brief.r, { text: "超出上限，没有写入：摘要有 210 字节，上限 200 字节。", isError: true });
  assert.deepEqual(brief.memory.get(PRESET.id, "笔记")?.value, "甲乙丙");
});

test("memory_edit：成功时版本加一，updated 是这条输入的 now，brief 不传就保持原摘要，传了就换", (t) => {
  const keep = callTool(t, "memory_edit", { key: "笔记", old: "杭州", new: "苏州", version: 1 }, { value: "住在 杭州，喜欢 西湖", brief: "住在哪" });
  assert.deepEqual(keep.r, { text: "已写入 笔记，版本 2。", isError: false });
  assert.deepEqual(memoryRows(keep.db), [{ key: "笔记", value: "住在 苏州，喜欢 西湖", brief: "住在哪", updated: NOW, version: 2 }]);
  const change = callTool(t, "memory_edit", { key: "笔记", old: "西湖", new: "太湖", version: 1, brief: "住在哪，喜欢哪" }, { value: "住在 杭州，喜欢 西湖", brief: "住在哪" });
  assert.deepEqual(change.r, { text: "已写入 笔记，版本 2。", isError: false });
  assert.deepEqual(memoryRows(change.db), [{ key: "笔记", value: "住在 杭州，喜欢 太湖", brief: "住在哪，喜欢哪", updated: NOW, version: 2 }]);
  // 重叠出现按不重叠计数："ababa" 里的 "aba" 算一次（和 split 的语义一致）。
  const overlap = callTool(t, "memory_edit", { key: "笔记", old: "aba", new: "X", version: 1 }, { value: "ababa", brief: "重叠" });
  assert.deepEqual(overlap.r, { text: "已写入 笔记，版本 2。", isError: false });
  assert.equal(overlap.memory.get(PRESET.id, "笔记")?.value, "Xba");
});

test("memory_edit：old 含孤立代理项（切开一个表情）是参数错误，库不变", (t) => {
  const { db, r } = callTool(t, "memory_edit", { key: "笔记", old: "\ud83d", new: "x", version: 1 }, { value: "😀x", brief: "表情" });
  assert.deepEqual(r, { text: "参数错误：old 含不完整的 Unicode 字符。", isError: true });
  assert.deepEqual(memoryRows(db), [{ key: "笔记", value: "😀x", brief: "表情", updated: 0, version: 1 }]);
});

test("memory_edit：new 里的 $& 和 $1 原样写入", (t) => {
  const { memory, r } = callTool(t, "memory_edit", { key: "笔记", old: "10 元", new: "$& 和 $1", version: 1 }, { value: "价格 10 元，共 10 个", brief: "价格" });
  assert.deepEqual(r, { text: "已写入 笔记，版本 2。", isError: false });
  assert.equal(memory.get(PRESET.id, "笔记")?.value, "价格 $& 和 $1，共 10 个");
});
