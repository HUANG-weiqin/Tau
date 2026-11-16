// 设计稿 5.3：回信由 decide 的 out 给出，handleNext 在同一个事务里放进收件人的信箱。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor } from "../../src/executor/executor.ts";
import { textContent } from "../../src/kernel/types.ts";
import type { Letter } from "../../src/kernel/types.ts";
import { loadProcess, loadSegment } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { fakeMemory, mailbox, PRESET, say, scripted, settle, tempDb, toolCall, use } from "./fixtures.ts";
import { assertStoreInvariants } from "./invariants.ts";

/** a 寄给 b、要回信的信。 */
const ask = (text: string, hops = 1): Letter => ({ from: { kind: "process", id: "a", preset: "helper" }, content: textContent(text), hops, replyTo: "a" });

/** 一个进程的段里全部用户消息的文本。 */
const saidBy = (db: Parameters<typeof loadSegment>[0], id: string): string[] =>
  loadSegment(db, loadProcess(db, id)!).flatMap((m) => (m.role === "user" ? [String(m.content)] : []));

/** 两个空闲的进程：a 在等别的事，b 收到 a 的信。b 的信已经在信箱里，还没处理。 */
function twoProcesses(t: Parameters<typeof tempDb>[0]) {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "a", PRESET, "开始", 0);
  startProcess(db, memory, "b", PRESET, "开始", 0);
  return { db, memory };
}

test("b 处理完 a 的信：回信在 b 的结束那个事务里进 a 的信箱，a 随后被唤醒", async (t) => {
  const { db, memory } = twoProcesses(t);
  const exec = createExecutor(db, scripted([say("a 好"), say("b 好"), say("答案"), say("收到")]));
  await settle(db, memory, exec);
  send(db, "b", { kind: "letter", letter: ask("几点了") });
  // 一步一步走：b 的信变成等模型，模型回复进信箱，处理这条回复的那一次 handleNext 同时投递回信。
  assert.ok(handleNext(db, memory, 1));
  await exec.startNext();
  assert.deepEqual(mailbox(db).map((m) => [m.id, m.input.kind]), [["b", "modelResult"]]);
  const h = handleNext(db, memory, 2);
  assert.deepEqual(h?.process.phase, { tag: "idle", ended: "done" });
  const box = mailbox(db);
  assert.equal(box.length, 1);
  assert.equal(box[0]!.id, "a");
  assert.deepEqual(box[0]!.input, {
    kind: "letter",
    letter: { from: { kind: "process", id: "b", preset: "helper", reply: { ended: "done" } }, content: textContent("答案"), hops: 2 },
  });
  assertStoreInvariants(db);
  await settle(db, memory, exec);
  assert.deepEqual(saidBy(db, "a"), ["开始", "（进程 b 的回信，这一轮正常结束）\n答案"]);
  assert.deepEqual(mailbox(db), []);
});

test("事务回滚：投递回信之后同一个事务里失败，回信、进程记录、信箱的输入都没有变", async (t) => {
  const { db, memory } = twoProcesses(t);
  const exec = createExecutor(db, scripted([say("a 好"), say("b 好"), say("答案")]));
  await settle(db, memory, exec);
  send(db, "b", { kind: "letter", letter: ask("几点了") });
  handleNext(db, memory, 1);
  await exec.startNext();
  const before = { box: mailbox(db), b: loadProcess(db, "b") };
  // 回信已经 INSERT 以后，删信箱行时失败。
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (sql.startsWith("DELETE FROM mailbox")) throw new Error("注入的失败");
    return prepare(sql);
  };
  assert.throws(() => handleNext(db, memory, 2), /注入的失败/);
  db.prepare = prepare;
  assert.deepEqual(mailbox(db), before.box);
  assert.deepEqual(loadProcess(db, "b"), before.b);
  // 重试：和没失败过一样。
  const h = handleNext(db, memory, 2);
  assert.equal(h?.process.phase.tag, "idle");
  assert.deepEqual(mailbox(db).map((m) => m.id), ["a"]);
});

test("同一轮处理了同一个进程的两封信：只回一封", async (t) => {
  const { db, memory } = twoProcesses(t);
  const exec = createExecutor(db, scripted([say("a 好"), say("b 好"), use(toolCall("c1", "self")), say("合在一起的答案")]));
  await settle(db, memory, exec);
  send(db, "b", { kind: "letter", letter: ask("一") });
  assert.ok(handleNext(db, memory, 1)); // b 的信，开一轮，等模型
  await exec.startNext(); // 模型要调用 self
  send(db, "b", { kind: "letter", letter: ask("二", 4) }); // 运行中到的信，排队，在安全点并入
  await settle(db, memory, exec);
  assert.deepEqual(saidBy(db, "a").slice(1), ["（进程 b 的回信，这一轮正常结束）\n合在一起的答案"]);
  assert.ok(saidBy(db, "b").some((s) => s.includes("二")));
  assertStoreInvariants(db);
});
