// 崩溃注入（设计稿第 6 节）：用带种子的随机数排出一串步骤，每一步恰好提交一个事务；在第 k 步之后杀掉服务，k 取遍每一个位置。
// 在“开始动作”之后、“完成动作”之前崩溃，就是“标记 running 的事务提交之后、结果写回之前”的窗口。
// 不崩溃的那一次就是真库上的随机序列测试。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Executor, Job } from "../../src/executor/executor.ts";
import { textContent, unreachable, userLetter } from "../../src/kernel/types.ts";
import type { AssistantMessage, Input, Message, PresetSnapshot, ToolCall } from "../../src/kernel/types.ts";
import { loadProcess, loadProcesses, openDb } from "../../src/store/db.ts";
import { handleNext, send, startProcess } from "../../src/store/inputs.ts";
import { allMessages, effectRows, fakeMemory, gated, hash, mailbox, PRESET, reply, rng, tempDir, toolCall } from "./fixtures.ts";
import type { FakeMemory, Gate } from "./fixtures.ts";
import type { Image } from "../../src/images.ts";
import { checkImages } from "../../src/images.ts";
import { png } from "../images.ts";
import { res } from "../plain.ts";
import { assertStoreInvariants } from "./invariants.ts";

const SEEDS = [1, 2, 3, 4];
const USER_MESSAGES = 8;
const STOPS = 2;
/** 窗口小一些，让换段也会发生。 */
const CRASH_PRESET: PresetSnapshot = { ...PRESET, contextWindow: 60_000, input: ["text", "image"] };
/** read 是库外工具；memory_*、self、handoff 是库内工具；bash 不在预设里；nope 不存在。 */
const TOOLS = ["read", "read", "read", "memory_get", "memory_set", "self", "handoff", "bash", "nope"];

type Kind = "start" | "send" | "stop" | "handle" | "claim" | "complete";

/** 假模型：回复只由进程 ID 和副作用编号决定，所以重放时完全一样。 */
function model(job: Job): AssistantMessage {
  const { id } = job.process;
  const e = job.effect;
  const r = rng(hash(`${id}#${e.n}`));
  if (e.kind === "callModel" && e.purpose === "handoff") {
    return r() < 0.8 ? reply("stop", [{ type: "text", text: `交接说明 ${id}#${e.n}` }]) : { ...reply("error", []), errorMessage: "交接时出错" };
  }
  const x = r();
  const usage = Math.floor(r() * 6000);
  if (x < 0.35) return reply("stop", [{ type: "text", text: `回复 ${id}#${e.n}` }], usage);
  if (x < 0.95) {
    const calls: ToolCall[] = [];
    for (let i = 0, k = 1 + Math.floor(r() * 3); i < k; i++) {
      const name = TOOLS[Math.floor(r() * TOOLS.length)]!;
      calls.push(toolCall(`${id}#${e.n}.${i}`, name, name === "read" ? { path: "a" } : name.startsWith("memory_") ? { key: "k", value: `v${e.n}` } : {}));
    }
    return reply("toolUse", calls, usage);
  }
  return { ...reply("error", []), errorMessage: "模型出错" };
}

interface InFlight {
  gate: Gate;
  done: Promise<void>;
}

/** 服务的一生：一个库句柄、一个执行器、它开始了还没完成的动作。 */
interface Life {
  db: DatabaseSync;
  exec: Executor;
  gates: Gate[];
  inflight: InFlight[];
}

interface Run {
  path: string;
  /** 打开过的库，测试结束时关掉。 */
  dbs: DatabaseSync[];
  memory: FakeMemory;
  rand: () => number;
  clock: number;
  life: Life;
  /** 所有生命期里开始过的动作。 */
  started: string[];
  /** 已经提交的用户消息。 */
  users: string[];
  stops: number;
  /** 寄出的要回信的信。 */
  asked: number;
  processes: string[];
}

const jobKey = (job: Job) => `${job.process.id}#${job.effect.n}`;

/** 打开库，建执行器（启动恢复在这里做）。 */
function boot(path: string, dbs: DatabaseSync[]): Life {
  const db = openDb(path);
  dbs.push(db);
  // 这里模拟的崩溃是关掉句柄，不是断电，不需要每次提交都落盘；关掉它让几千次重放快一些。
  db.exec("PRAGMA synchronous = OFF");
  const actions = gated(model, (_job, call) => (res(`out:${call.id}`)));
  return { db, exec: createExecutor(db, actions), gates: actions.gates, inflight: [] };
}

function enabled(run: Run): Kind[] {
  const { db, inflight } = run.life;
  const out: Kind[] = [];
  if (run.users.length < USER_MESSAGES && run.processes.length < 2) out.push("start");
  if (run.users.length < USER_MESSAGES && run.processes.length > 0) out.push("send");
  if (run.stops < STOPS && run.processes.length > 0) out.push("stop");
  if (db.prepare("SELECT 1 FROM mailbox LIMIT 1").get()) out.push("handle");
  if (db.prepare("SELECT 1 FROM effects WHERE status = 'pending' LIMIT 1").get()) out.push("claim");
  if (inflight.length > 0) out.push("complete");
  return out;
}

/** 一半的用户信带一张图片，每封的字节不同。 */
function maybeImages(run: Run): Image[] {
  return run.rand() < 0.5 ? checkImages([png(10, 10, run.users.length + 1).toString("base64")]) : [];
}

function pick<T>(run: Run, xs: readonly T[]): T {
  return xs[Math.floor(run.rand() * xs.length)]!;
}

/** 执行一步：恰好提交一个事务。 */
async function step(run: Run, kind: Kind): Promise<void> {
  const { db, exec, gates, inflight } = run.life;
  const now = ++run.clock * 1000;
  switch (kind) {
    case "start": {
      const id = `p${run.processes.length + 1}`;
      const text = `<u${run.users.length + 1}>`;
      startProcess(db, run.memory, id, CRASH_PRESET, text, now, maybeImages(run));
      run.processes.push(id);
      run.users.push(text);
      return;
    }
    case "send": {
      const text = `<u${run.users.length + 1}>`;
      const to = pick(run, run.processes);
      const other = run.processes.find((id) => id !== to);
      // 有两个进程时，一半的信是另一个进程寄来、要回信的：回信的投递也在崩溃注入的范围里。
      if (other !== undefined && run.rand() < 0.5) {
        send(db, to, { kind: "letter", letter: { from: { kind: "process", id: other, preset: PRESET.id }, content: textContent(text), hops: 1, replyTo: other } });
        run.asked++;
      } else send(db, to, userLetter(text), maybeImages(run));
      run.users.push(text);
      return;
    }
    case "stop":
      send(db, pick(run, run.processes), { kind: "stop" });
      run.stops++;
      return;
    case "handle": {
      const h = handleNext(db, run.memory, now);
      assert.ok(h);
      if (h.abort === null) return;
      // 被删掉的 running 行一定是这一生开始的动作。中止它，等它的结果被丢弃：完成的事务什么都不写。
      const [f] = inflight.splice(inflight.findIndex((x) => jobKey(x.gate.job) === `${h.process.id}#${h.abort}`), 1);
      assert.ok(f);
      exec.abort(h.process.id, h.abort);
      await f.done;
      return;
    }
    case "claim": {
      const done = exec.startNext();
      const gate = gates.at(-1);
      assert.ok(done && gate);
      run.started.push(jobKey(gate.job));
      inflight.push({ gate, done });
      return;
    }
    case "complete": {
      const [f] = inflight.splice(Math.floor(run.rand() * inflight.length), 1);
      assert.ok(f);
      f.gate.finish();
      await f.done;
      return;
    }
    default:
      return unreachable(kind);
  }
}

function interrupted(db: DatabaseSync, id: string, n: number): { id: string; input: Input } {
  const tag = loadProcess(db, id)?.phase.tag;
  return { id, input: tag === "awaitingModel" ? { kind: "modelResult", n, outcome: { status: "interrupted" } } : { kind: "toolResult", n, outcome: { status: "interrupted" } } };
}

/** 杀掉服务：丢下执行器和它没完成的动作，关库。然后重启、恢复，检查恢复的结果。 */
async function crash(run: Run): Promise<void> {
  const rows = effectRows(run.life.db);
  const pending = rows.filter((r) => r.status === "pending");
  const running = rows.filter((r) => r.status === "running");
  const before = mailbox(run.life.db);
  const abandoned = run.life.inflight;
  run.life.db.close();
  run.life = boot(run.path, run.dbs);
  const { db } = run.life;

  // 没完成的动作恰好是 running 的行。它们一律作为 interrupted 送回；pending 的行留着正常开始。
  assert.deepEqual(abandoned.map((f) => jobKey(f.gate.job)).sort(), running.map((r) => `${r.id}#${r.n}`).sort());
  assert.deepEqual(effectRows(db), pending);
  const after = mailbox(db);
  const sorted = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(sorted(after.slice(before.length)), sorted(running.map((r) => interrupted(db, r.id, r.n))));
  assertStoreInvariants(db);

  // 旧的动作这时才完成：它们拿着关掉的库，什么都写不进去。
  for (const f of abandoned) {
    f.gate.finish();
    await assert.rejects(f.done, /not open/);
  }
  assert.deepEqual(mailbox(db), after);

  // 恢复之后马上再崩溃一次：再恢复什么都不改。
  db.close();
  run.life = boot(run.path, run.dbs);
  assert.deepEqual(mailbox(run.life.db), after);
  assert.deepEqual(effectRows(run.life.db), pending);
}

function userText(m: Message): string {
  if (m.role !== "user") return "";
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** 从空库开始跑到没有事可做。给了 `crashAt` 时，在第 crashAt 步之后崩溃一次。 */
async function play(empty: Empty, seed: number, crashAt: number | null): Promise<{ steps: number; asked: number; backs: number; blobs: number; crashed: { kind: Kind; window: boolean } | null }> {
  const path = join(empty.dir, `${seed}-${crashAt ?? "none"}.db`);
  copyFileSync(empty.path, path);
  const { dbs } = empty;
  const run: Run = { path, dbs, memory: fakeMemory(), rand: rng(seed), clock: 0, life: boot(path, dbs), started: [], users: [], stops: 0, asked: 0, processes: [] };
  let steps = 0;
  let crashed: { kind: Kind; window: boolean } | null = null;
  for (let kinds = enabled(run); kinds.length > 0; kinds = enabled(run)) {
    const kind = pick(run, kinds);
    await step(run, kind);
    assertStoreInvariants(run.life.db);
    if (++steps === crashAt) {
      crashed = { kind, window: run.life.inflight.length > 0 };
      await crash(run);
    }
    assert.ok(steps < 5000, "没有收敛");
  }

  // 收敛：信箱空，副作用表空，全部 idle。
  const { db } = run.life;
  assert.deepEqual(mailbox(db), []);
  assert.deepEqual(effectRows(db), []);
  const processes = loadProcesses(db);
  for (const p of processes) assert.equal(p.phase.tag, "idle");
  const messages = processes.flatMap((p) => allMessages(db, p.id));
  // 没有输入丢失，也没有输入被处理两次：每条用户消息恰好出现一次。
  // 换段时，段末的用户消息（安全点并入的信也在其中）原样带进新段的第一条：新段的第一条不算。
  const said = processes.flatMap((p) => allMessages(db, p.id, true)).map(userText).join("\n");
  for (const u of run.users) assert.equal(said.split(u).length - 1, 1, `${u} 应该恰好出现一次`);
  // 回信：每封要回信的信所在的那一轮结束时都寄了回信，一个也没丢，也没有重复。同一轮里的几封信，同一个发信的只回一封，所以不多于寄出的信数。
  const backs = said.split("的回信，这一轮").length - 1;
  assert.ok(run.asked === 0 ? backs === 0 : backs >= 1 && backs <= run.asked, `寄出 ${run.asked} 封要回信的信，收到 ${backs} 封回信`);
  // 库外副作用不会被重做；每个工具调用恰好一个结果；每条助手消息只写入一次。
  assert.equal(new Set(run.started).size, run.started.length, "有动作被开始了两次");
  const calls = messages.flatMap((m) => (m.role === "assistant" ? m.content.flatMap((c) => (c.type === "toolCall" ? [c.id] : [])) : []));
  const results = messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []));
  assert.deepEqual([...results].sort(), [...calls].sort());
  const replies = messages.filter((m) => m.role === "assistant").map((m) => JSON.stringify(m));
  assert.equal(new Set(replies).size, replies.length);
  const blobs = db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n as number;
  db.close();
  return { steps, asked: run.asked, backs, blobs, crashed };
}

/** 一个空库的模板。新建库要建表、落盘，在 Windows 上比复制文件慢十几倍，几百次重放都从复制它开始。 */
interface Empty {
  dir: string;
  path: string;
  dbs: DatabaseSync[];
}

function emptyDb(t: TestContext): Empty {
  const dbs: DatabaseSync[] = [];
  const dir = tempDir(t, dbs);
  const path = join(dir, "empty.db");
  openDb(path).close();
  return { dir, path, dbs };
}

test("随机序列：真库上每一步之后不变量都成立，最后全部收敛", async (t) => {
  const empty = emptyDb(t);
  let asked = 0;
  let backs = 0;
  let blobs = 0;
  for (const seed of SEEDS) {
    const r = await play(empty, seed, null);
    asked += r.asked;
    backs += r.backs;
    blobs += r.blobs;
  }
  assert.ok(blobs > 0, "没有覆盖到带图片的信");
  assert.ok(asked > 0 && backs > 0, `要回信的信 ${asked} 封，回信 ${backs} 封：没有覆盖到回信`);
});

test("崩溃注入：在每一个事务之后，以及“标记 running 之后、结果写回之前”杀掉服务", async (t) => {
  const empty = emptyDb(t);
  const covered = new Set<string>();
  for (const seed of SEEDS) {
    const { steps } = await play(empty, seed, null);
    for (let k = 1; k <= steps; k++) {
      const { crashed } = await play(empty, seed, k);
      assert.ok(crashed);
      covered.add(crashed.kind);
      if (crashed.window) covered.add("window");
    }
  }
  // 每一种事务之后都崩溃过，running 的窗口也崩溃过；启动恢复之后的崩溃每次 crash 里都有。
  assert.deepEqual([...covered].sort(), ["claim", "complete", "handle", "send", "start", "stop", "window"]);
});
