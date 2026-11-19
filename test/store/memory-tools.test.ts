// 记忆工具的接线：模型调用 → 处理输入的事务 → 真库里的 brief、updated；结果文字带摘要和更新日期。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
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

/** 信箱里编号 `n` 的工具结果的文字。 */
const toolText = (db: DatabaseSync, n: number): string => {
  const row = db.prepare("SELECT input_json FROM mailbox ORDER BY seq").all().map((r) => JSON.parse(r.input_json as string) as Input).find((i) => i.kind === "toolResult" && i.n === n);
  assert.ok(row && row.kind === "toolResult" && row.outcome.status === "ok");
  return textOfResult(row.outcome.content);
};

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
  assert.equal(toolText(db, 5), `版本冲突，没有写入。现在的值是 城市（版本 1，更新 ${utcDate(NOW)}）：\n摘要：住在哪\n杭州`);
  assert.deepEqual(memoryRows(db), [{ key: "城市", value: "杭州", brief: "住在哪", updated: NOW, version: 1 }], "冲突没有写入");
});
