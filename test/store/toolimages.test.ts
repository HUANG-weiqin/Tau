// 带图的工具结果（设计稿 5.5、5.6）：图片在执行器上报结果的事务里插入 blobs，和结果同生同死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { createExecutor } from "../../src/executor/executor.ts";
import type { ToolOutput } from "../../src/executor/executor.ts";
import { checkImages } from "../../src/images.ts";
import type { PresetSnapshot } from "../../src/kernel/types.ts";
import { BLOB_PREFIX, readBlob } from "../../src/store/blobs.ts";
import { loadProcess, loadSegment, openDb } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { png } from "../images.ts";
import { effectRows, fakeMemory, gated, mailbox, PRESET, say, tempDir, toolCall, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

const VISION: PresetSnapshot = { ...PRESET, input: ["text", "image"] };
const [image] = checkImages([png(12, 12, 7).toString("base64")]);
const withImage: ToolOutput = { content: [{ type: "text", text: "图在这" }, { type: "image", data: BLOB_PREFIX + image!.hash, mimeType: "image/png" }], isError: false, images: [image!] };
const blobCount = (db: DatabaseSync): number => db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n as number;
/** 临时目录和库路径；开过的库在测试结束时关掉。 */
function store(t: TestContext): { path: string; open(): DatabaseSync } {
  const dbs: DatabaseSync[] = [];
  const path = join(tempDir(t, dbs), "tau.db");
  return { path, open: () => (dbs[dbs.push(openDb(path)) - 1] as DatabaseSync) };
}
const model = (job: { process: { phase: { tag: string } }; effect: { n: number } }) => (job.effect.n === 1 ? use(toolCall("c1", "read", { path: "a" })) : say("好"));

test("上报结果的事务：上报之前 blobs 里没有图片，上报之后结果和图片一起在，images 字段不进信箱", async (t) => {
  const db = store(t).open();
  const memory = fakeMemory();
  const actions = gated(model, () => withImage);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", VISION, "看", 0);
  handleNext(db, memory, 0);
  const first = exec.startNext()!;
  actions.gates[0]!.finish();
  await first;
  handleNext(db, memory, 0);
  const tool = exec.startNext()!;
  assert.equal(blobCount(db), 0, "结果还没上报，图片不能先进库");
  actions.gates[1]!.finish();
  await tool;
  assert.equal(blobCount(db), 1);
  assert.equal(JSON.stringify(mailbox(db)).includes("images"), false);
  assertStoreInvariants(db);
});

test("工具运行中被杀：结果和图片都没有写，恢复送回 interrupted，blobs 不动", async (t) => {
  const { path, open } = store(t);
  const memory = fakeMemory();
  const db1 = open();
  const actions = gated(model, () => withImage);
  const exec1 = createExecutor(db1, actions);
  startProcess(db1, memory, "p1", VISION, "看", 0);
  handleNext(db1, memory, 0);
  const first = exec1.startNext()!;
  actions.gates[0]!.finish();
  await first;
  handleNext(db1, memory, 0);
  const running = exec1.startNext()!; // 工具开始了，还没完成
  assert.deepEqual(effectRows(db1).map((r) => r.status), ["running"]);
  db1.close(); // 杀
  const db2 = open();
  createExecutor(db2, gated(model, () => withImage));
  actions.gates[1]!.finish(); // 旧动作这时才结束：写不进关掉的库
  await assert.rejects(running, /not open/);
  assert.equal(blobCount(db2), 0);
  assert.deepEqual(mailbox(db2).map((m) => m.input), [{ kind: "toolResult", n: 2, outcome: { status: "interrupted" } }]);
  assertStoreInvariants(db2);
});

test("上报之后被杀：结果和图片都在，引用完整，引用的字节读得回来", async (t) => {
  const { path, open } = store(t);
  const memory = fakeMemory();
  const db1 = open();
  const actions = gated(model, () => withImage);
  const exec1 = createExecutor(db1, actions);
  startProcess(db1, memory, "p1", VISION, "看", 0);
  handleNext(db1, memory, 0);
  const first = exec1.startNext()!;
  actions.gates[0]!.finish();
  await first;
  handleNext(db1, memory, 0);
  const tool = exec1.startNext()!;
  actions.gates[1]!.finish();
  await tool;
  db1.close(); // 杀：结果已提交
  const db2 = open();
  createExecutor(db2, gated(model, () => withImage));
  assert.equal(blobCount(db2), 1);
  const [mail] = mailbox(db2);
  assert.ok(mail?.input.kind === "toolResult" && mail.input.outcome.status === "ok");
  assert.deepEqual(mail.input.outcome.content, { content: withImage.content, isError: false });
  assert.deepEqual(readBlob(db2, image!.hash), image!.bytes);
  assertStoreInvariants(db2);
  handleNext(db2, memory, 0);
  const seg = loadSegment(db2, loadProcess(db2, "p1")!);
  assert.deepEqual(seg.find((m) => m.role === "toolResult")?.content, withImage.content);
});

test("动作结束时进程已停止：结果丢弃，图片也不写", async (t) => {
  const db = store(t).open();
  const memory = fakeMemory();
  const actions = gated(model, () => withImage);
  const exec = createExecutor(db, actions);
  startProcess(db, memory, "p1", VISION, "看", 0);
  handleNext(db, memory, 0);
  const first = exec.startNext()!;
  actions.gates[0]!.finish();
  await first;
  handleNext(db, memory, 0);
  const tool = exec.startNext()!;
  send(db, "p1", { kind: "stop" });
  handleNext(db, memory, 0); // 删掉 running 行
  actions.gates[1]!.finish(); // 没有人中止它：结果到了，行已经不在
  await tool;
  assert.equal(blobCount(db), 0);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});
