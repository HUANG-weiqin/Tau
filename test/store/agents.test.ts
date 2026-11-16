// 设计稿 5.3：post、spawn、stop_process 在处理输入的事务里执行，和工具结果一起提交，永不抛错。
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Actions, Job } from "../../src/executor/executor.ts";
import { start } from "../../src/kernel/decide.ts";
import { HOPS_MAX } from "../../src/kernel/derive.ts";
import { textContent } from "../../src/kernel/types.ts";
import type { AssistantMessage, Process, PresetSnapshot } from "../../src/kernel/types.ts";
import { loadProcess, loadProcesses, openDb, putMail, tx } from "../../src/store/db.ts";
import { handleNext, startProcess } from "../../src/store/inputs.ts";
import { runInStore, spawnId } from "../../src/store/instore.ts";
import { allMessages, fakeMemory, mailbox, PRESET, say, settle, tempDb, tempDir, toolCall, use } from "./fixtures.ts";
import type { FakeMemory } from "./fixtures.ts";
import { plain, res } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

/** 能用 agents 的预设，和不能用的子进程预设。 */
const BOSS: PresetSnapshot = { ...PRESET, id: "boss", tools: ["agents", "memory"] };
const KID: PresetSnapshot = { ...PRESET, id: "kid", tools: ["read", "memory"] };
const readPreset = (id: string): PresetSnapshot => {
  if (id === "kid") return KID;
  if (id === "boss") return BOSS;
  throw new Error(`找不到预设：${id}`);
};

/** 一个在等第 `n` 个工具结果的进程，`hops` 是这一轮已有的跳数。库里有它的记录，信箱清空。 */
function asking(db: DatabaseSync, memory: FakeMemory, opts: { id?: string; hops?: number; n?: number } = {}): Process {
  const id = opts.id ?? "a";
  startProcess(db, memory, id, BOSS, "开始", 0);
  db.exec("DELETE FROM mailbox");
  return { ...loadProcess(db, id)!, lastEffect: opts.n ?? 3, phase: { tag: "awaitingTool", turn: { steps: 1, queued: [], hops: opts.hops ?? 0, replyTo: [] } } };
}

/** 直接跑一个库内工具，在一个事务里。 */
function run(db: DatabaseSync, memory: FakeMemory, p: Process, name: string, args: Parameters<typeof toolCall>[2]) {
  return plain(tx(db, () => runInStore(db, memory, p, [], toolCall("c", name, args), 0, readPreset)));
}

test("post：收件人收到一封带头的信；reply 为真时带 replyTo，跳数是这一轮的跳数加一", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const p = asking(db, memory, { hops: 4 });
  db.exec("DELETE FROM mailbox");
  assert.deepEqual(run(db, memory, p, "post", { to: "b", text: "几点", reply: true }), {
    text: "已寄给 b。它处理这封信的那一轮结束时会给你回信，之后的几轮不会。",
    isError: false,
  });
  assert.deepEqual(run(db, memory, p, "post", { to: "b", text: "随便说说" }), { text: "已寄给 b。", isError: false });
  const from = { kind: "process", id: "a", preset: "boss" };
  assert.deepEqual(mailbox(db), [
    { id: "b", input: { kind: "letter", letter: { from, content: textContent("几点"), hops: 5, replyTo: "a" } } },
    { id: "b", input: { kind: "letter", letter: { from, content: textContent("随便说说"), hops: 5 } } },
  ]);
});

test("post 和 stop_process 的失败：收件人不存在、对象是自己、参数不对，都是 isError，什么都不写", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  const bad = (name: string, args: Parameters<typeof toolCall>[2], text: string | RegExp) => {
    const r = run(db, memory, p, name, args);
    assert.equal(r.isError, true, name);
    assert.match(r.text, typeof text === "string" ? new RegExp(`^${text}$`) : text);
  };
  bad("post", { to: "zz", text: "x" }, "没有进程 zz。");
  bad("post", { to: "a", text: "x" }, "不能给自己寄信。");
  bad("post", { to: 1, text: "x" }, /^参数错误/);
  bad("post", { to: "a" }, /^参数错误/);
  bad("post", { to: "zz", text: "x", reply: "yes" }, /^参数错误/);
  bad("stop_process", { process: "zz" }, "没有进程 zz。");
  bad("stop_process", { process: "a" }, "不能停止自己。要结束这一轮，直接回复，不再调用工具。");
  bad("stop_process", {}, /^参数错误/);
  bad("spawn", { preset: "kid" }, /^参数错误/);
  assert.deepEqual(mailbox(db), []);
  assert.equal(loadProcesses(db).length, 1);
});

test("stop_process：往目标的信箱放一个 stop", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const p = asking(db, memory);
  db.exec("DELETE FROM mailbox");
  assert.deepEqual(run(db, memory, p, "stop_process", { process: "b" }), { text: "已给 b 发出停止。", isError: false });
  assert.deepEqual(mailbox(db), [{ id: "b", input: { kind: "stop" } }]);
});

test("spawn：建一个 parent 是自己的新进程，第一封信带 replyTo，跳数加一；记忆视图是子进程的", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  memory.set("kid", "who", "孩子的记忆", null);
  memory.set("boss", "who", "父亲的记忆", null);
  const p = asking(db, memory, { hops: 2, n: 7 });
  const id = spawnId("a", 7, 0);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.deepEqual(run(db, memory, p, "spawn", { preset: "kid", text: "做这个" }), {
    text: `已建进程 ${id}，预设 kid。它这一轮结束时会给你回信，之后的几轮不会。`,
    isError: false,
  });
  const child = loadProcess(db, id)!;
  assert.equal(child.parent, "a");
  assert.equal(child.preset.id, "kid");
  assert.deepEqual(child.phase, { tag: "idle" });
  assert.equal(child.segment.seq, 1);
  assert.match(child.segment.memoryView, /孩子的记忆/);
  assert.doesNotMatch(child.segment.memoryView, /父亲的记忆/);
  assert.deepEqual(child, { ...start(id, KID, { now: 0, memoryView: child.segment.memoryView }), parent: "a" });
  assert.deepEqual(mailbox(db), [
    { id, input: { kind: "letter", letter: { from: { kind: "process", id: "a", preset: "boss" }, content: textContent("做这个"), hops: 3, replyTo: "a" } } },
  ]);
  assertStoreInvariants(db);
});

test("spawn 的 ID：同样的输入算出同样的 ID；撞上已有的 ID，尝试次数加一再算", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory, { n: 5 });
  assert.equal(spawnId("a", 5, 0), spawnId("a", 5, 0));
  assert.notEqual(spawnId("a", 5, 0), spawnId("a", 5, 1));
  assert.notEqual(spawnId("a", 5, 0), spawnId("a", 6, 0));
  assert.notEqual(spawnId("a", 5, 0), spawnId("b", 5, 0));
  startProcess(db, memory, spawnId("a", 5, 0), KID, "占着", 0);
  startProcess(db, memory, spawnId("a", 5, 1), KID, "也占着", 0);
  db.exec("DELETE FROM mailbox");
  const r = run(db, memory, p, "spawn", { preset: "kid", text: "x" });
  assert.equal(r.text, `已建进程 ${spawnId("a", 5, 2)}，预设 kid。它这一轮结束时会给你回信，之后的几轮不会。`);
  assert.equal(loadProcess(db, spawnId("a", 5, 0))!.parent, undefined);
});

test("spawn：预设读不出时是错误结果，什么都不建；读预设抛出的原因照抄", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const p = asking(db, memory);
  assert.deepEqual(run(db, memory, p, "spawn", { preset: "nope", text: "x" }), { text: "预设 nope 读不出：找不到预设：nope", isError: true });
  assert.equal(loadProcesses(db).length, 1);
  assert.deepEqual(mailbox(db), []);
});

test("跳数：post 和 spawn 超过 HOPS_MAX 就失败，什么都不写；刚好等于上限可以", (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const limit = `跳数到上限（${HOPS_MAX}）：这封信是被进程之间的信一路引出来的。结束本轮，等用户的下一封信。`;
  const over = asking(db, memory, { hops: HOPS_MAX });
  db.exec("DELETE FROM mailbox");
  assert.deepEqual(run(db, memory, over, "post", { to: "b", text: "x" }), { text: limit, isError: true });
  assert.deepEqual(run(db, memory, over, "spawn", { preset: "kid", text: "x" }), { text: limit, isError: true });
  assert.deepEqual(mailbox(db), []);
  assert.equal(loadProcesses(db).length, 2);
  const edge = { ...over, phase: { tag: "awaitingTool" as const, turn: { steps: 1, queued: [], hops: HOPS_MAX - 1, replyTo: [] } } };
  assert.equal(run(db, memory, edge, "post", { to: "b", text: "x" }).isError, false);
  assert.equal(run(db, memory, edge, "spawn", { preset: "kid", text: "x" }).isError, false);
});

test("预设没写 agents：模型调用 post 得到“不存在”的错误结果，信箱不堵", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "a", KID, "开始", 0);
  startProcess(db, memory, "b", KID, "hi", 0);
  const exec = createExecutor(db, byTurn({ a: [use(toolCall("c1", "post", { to: "b", text: "x" })), say("好")], b: [say("hi")] }));
  await settle(db, memory, exec, undefined, readPreset);
  assert.deepEqual(mailbox(db), []);
  assert.ok(allMessages(db, "a").some((m) => m.role === "toolResult" && m.isError));
  assert.deepEqual(allMessages(db, "b").filter((m) => m.role === "user").length, 1);
});

/** 按进程 ID（没有就按预设 ID）和这个进程第几次调用模型，查脚本；脚本用完后回 `say("完")`。第几次按副作用编号记，崩溃重放同一个动作得到同一个回复。 */
function byTurn(script: Record<string, AssistantMessage[] | ((job: Job, k: number) => AssistantMessage)>): Actions {
  const seen = new Map<string, number>();
  const count = new Map<string, number>();
  return {
    async callModel(job) {
      const key = job.process.id in script ? job.process.id : job.process.preset.id;
      const at = `${job.process.id}#${job.effect.n}`;
      if (!seen.has(at)) {
        count.set(job.process.id, (count.get(job.process.id) ?? 0) + 1);
        seen.set(at, count.get(job.process.id)!);
      }
      const k = seen.get(at)!;
      const s = script[key];
      return typeof s === "function" ? s(job, k) : (s?.[k - 1] ?? say("完"));
    },
    async runTool() {
      return res("out");
    },
  };
}

/** 这是一轮的第一次调用模型：段尾是用户消息。 */
const startsTurn = (job: Job): boolean => job.segment.at(-1)?.role === "user";

const textOf = (content: readonly { type: string; text?: string }[]): string => content.map((c) => c.text ?? "").join("");

const userTexts = (db: DatabaseSync, id: string): string[] => allMessages(db, id).flatMap((m) => (m.role === "user" ? [String(m.content)] : []));

test("A 问 B，B 回信：A 被回信唤醒", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const exec = createExecutor(db, byTurn({ b: [say("好"), say("三点")], a: [use(toolCall("c1", "post", { to: "b", text: "几点", reply: true })), say("已问"), say("收到")] }));
  await settle(db, memory, exec, undefined, readPreset);
  startProcess(db, memory, "a", BOSS, "开始", 0);
  await settle(db, memory, exec, undefined, readPreset);
  assert.ok(userTexts(db, "b").some((s) => s.includes("几点")));
  assert.deepEqual(userTexts(db, "a").slice(1), ["（进程 b 的回信，这一轮正常结束）\n三点"]);
  assert.deepEqual(loadProcess(db, "a")!.phase, { tag: "idle", ended: "done" });
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

test("B 被停止：回信写“被停止”，唤醒等它的 A", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "b", KID, "hi", 0);
  const exec = createExecutor(db, byTurn({ b: [say("好"), say("来不及")], a: [use(toolCall("c1", "post", { to: "b", text: "慢活", reply: true }), toolCall("c2", "stop_process", { process: "b" })), say("已发"), say("看到了")] }));
  await settle(db, memory, exec, undefined, readPreset);
  startProcess(db, memory, "a", BOSS, "开始", 0);
  await settle(db, memory, exec, undefined, readPreset);
  assert.deepEqual(loadProcess(db, "b")!.phase, { tag: "idle", ended: "stopped" });
  assert.deepEqual(userTexts(db, "a").slice(1), ["（进程 b 的回信，这一轮被停止）\n"]);
  assertStoreInvariants(db);
});

test("两个互相寄信的进程在 HOPS_MAX 处停住", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  const ping = (to: string) => (job: Job) => (startsTurn(job) ? use(toolCall(`c${job.effect.n}`, "post", { to, text: "乒" })) : say("寄了"));
  // 从接近上限的跳数起步，免得空跑 1000 多封信：startProcess 的第一封信跳数是 0，所以清空信箱，改放一封带跳数的进程信。
  for (const [id, other] of [["a", "b"], ["b", "a"]] as const) {
    startProcess(db, memory, id, BOSS, "开始", 0);
    db.prepare("DELETE FROM mailbox WHERE process_id = ?").run(id);
    putMail(db, id, { kind: "letter", letter: { from: { kind: "process", id: other, preset: "boss" }, content: textContent("开始"), hops: HOPS_MAX - 10 } });
  }
  const exec = createExecutor(db, byTurn({ a: ping("b"), b: ping("a") }));
  await settle(db, memory, exec, undefined, readPreset);
  const results = ["a", "b"].flatMap((id) => allMessages(db, id).flatMap((m) => (m.role === "toolResult" ? [m] : [])));
  const failed = results.filter((m) => m.isError);
  assert.ok(failed.length >= 1);
  for (const m of failed) assert.match(textOf(m.content), /^跳数到上限（1024）/);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

test("顺序委派：前 512 次 spawn 成功，第 513 次报跳数到上限", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  // 父进程：一轮的第一次调用模型就派一个子进程，看到结果就回复“派出了”结束本轮；子进程只回复。
  const exec = createExecutor(db, byTurn({ a: (job) => (startsTurn(job) ? use(toolCall(`s${job.effect.n}`, "spawn", { preset: "kid", text: `活 ${job.effect.n}` })) : say("派出了")), kid: [] }));
  startProcess(db, memory, "a", BOSS, "开始", 0);
  await settle(db, memory, exec, undefined, readPreset);
  const kids = loadProcesses(db).filter((p) => p.parent === "a");
  assert.equal(kids.length, 512);
  const results = allMessages(db, "a").flatMap((m) => (m.role === "toolResult" ? [m] : []));
  assert.equal(results.length, 513);
  assert.deepEqual(results.map((m) => m.isError), [...Array<boolean>(512).fill(false), true]);
  assert.match(textOf(results[512]!.content), /^跳数到上限（1024）/);
  assert.deepEqual(mailbox(db), []);
  assertStoreInvariants(db);
});

/** 库里全部表的内容，用来比较两次运行的结果。 */
function dump(db: DatabaseSync): unknown {
  const all = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));
  return {
    processes: all("SELECT * FROM processes ORDER BY id"),
    segments: all("SELECT * FROM segment_messages ORDER BY process_id, segment_seq, seq"),
    mailbox: all("SELECT * FROM mailbox ORDER BY seq"),
    effects: all("SELECT * FROM effects ORDER BY process_id"),
  };
}

test("崩溃注入：在寄信、派生、停止的事务前后杀服务，结果和不崩溃时一样", async (t) => {
  const dbs: DatabaseSync[] = [];
  const empty = tempDir(t, dbs);
  const emptyPath = join(empty, "empty.db");
  openDb(emptyPath).close();
  const script = {
    a: [
      use(toolCall("c1", "spawn", { preset: "kid", text: "做这个" }), toolCall("c2", "post", { to: "q", text: "问你", reply: true }), toolCall("c3", "stop_process", { process: "q" })),
      say("派出了"),
      say("都收到了"),
    ],
    q: [say("好"), say("q 的答")],
    kid: [say("kid 的答")],
  };
  /** 每一步一个事务：处理一条输入，或者开始一个动作并等它完成。第 `crashAt` 步之后关库重开。 */
  async function play(crashAt: number | null): Promise<{ steps: number; state: unknown }> {
    const path = join(empty, `${crashAt ?? "none"}.db`);
    copyFileSync(emptyPath, path);
    let db = openDb(path);
    dbs.push(db);
    const memory = fakeMemory();
    startProcess(db, memory, "q", KID, "hi", 0);
    startProcess(db, memory, "a", BOSS, "开始", 0);
    const actions = byTurn(script);
    let exec = createExecutor(db, actions);
    let steps = 0;
    for (;;) {
      if (!handleNext(db, memory, 0, readPreset)) {
        const done = exec.startNext();
        if (!done) break;
        await done;
      }
      assertStoreInvariants(db);
      if (++steps === crashAt) {
        db.close();
        db = openDb(path);
        dbs.push(db);
        exec = createExecutor(db, actions);
        assertStoreInvariants(db);
      }
      assert.ok(steps < 500, "没有收敛");
    }
    return { steps, state: dump(db) };
  }
  const base = await play(null);
  const kids = (base.state as { processes: { id: string; state_json: string }[] }).processes.filter((r) => (JSON.parse(r.state_json) as Process).parent === "a");
  assert.equal(kids.length, 1);
  assert.ok(base.steps > 8);
  // 脚本是按“这个进程第几次调用模型”查的，崩溃重开后执行器没有丢动作（每一步都等到完成），所以重放的结果必须一样。
  for (let k = 1; k <= base.steps; k++) assert.deepEqual((await play(k)).state, base.state, `第 ${k} 步之后崩溃`);
});

test("事务回滚：处理这条输入时在事务里失败，派生出的进程和它的信都没有；重试得到同一个 ID", async (t) => {
  const db = tempDb(t);
  const memory = fakeMemory();
  startProcess(db, memory, "q", KID, "hi", 0);
  startProcess(db, memory, "a", BOSS, "开始", 0);
  const calls = [toolCall("c1", "spawn", { preset: "kid", text: "做这个" }), toolCall("c2", "post", { to: "q", text: "问你", reply: true }), toolCall("c3", "stop_process", { process: "q" })];
  const exec = createExecutor(db, byTurn({ a: [use(...calls)], q: [say("好")] }));
  // 走到信箱队头是 a 的模型结果：处理它时执行 spawn。
  const head = () => mailbox(db)[0];
  for (let i = 0; !(head()?.id === "a" && head()?.input.kind === "modelResult"); i++) {
    assert.ok(i < 50, "没有走到");
    if (!handleNext(db, memory, 0, readPreset)) await exec.startNext();
  }
  const before = { box: mailbox(db), procs: loadProcesses(db) };
  const prepare = db.prepare.bind(db);
  let spawned = false;
  let presetReads = 0;
  const counting = (id: string) => {
    presetReads++;
    return readPreset(id);
  };
  // 等 spawn 写完进程行，再让下一次写信箱失败：失败发生在 spawn 的写入之后。
  db.prepare = (sql: string) => {
    if (sql.startsWith("INSERT INTO processes")) spawned = true;
    else if (spawned && sql.startsWith("INSERT INTO mailbox")) throw new Error("注入的失败");
    return prepare(sql);
  };
  assert.throws(() => handleNext(db, memory, 0, counting), /注入的失败/);
  db.prepare = prepare;
  assert.ok(spawned && presetReads > 0, "spawn 没有跑到");
  assert.deepEqual(mailbox(db), before.box);
  assert.deepEqual(loadProcesses(db), before.procs);
  const h = handleNext(db, memory, 0, readPreset);
  assert.ok(h);
  assert.equal(loadProcesses(db).filter((p) => p.parent === "a").map((p) => p.id).join(), spawnId("a", before.procs.find((p) => p.id === "a")!.lastEffect + 1, 0));
});
