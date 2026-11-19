// 崩溃注入（设计稿第 6 节）：用带种子的随机数排出一串步骤，每一步提交一个事务（removeProcess 被拒绝时不提交）；在第 k 步之后杀掉服务，k 取遍每一个位置。
// 在“开始动作”之后、“完成动作”之前崩溃，就是“标记 running 的事务提交之后、结果写回之前”的窗口。
// 不崩溃的那一次就是真库上的随机序列测试。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../../src/executor/executor.ts";
import type { Executor, Job, ToolOutput } from "../../src/executor/executor.ts";
import { textContent, unreachable, userLetter } from "../../src/kernel/types.ts";
import type { AssistantMessage, DeclaredCall, Input, Message, PresetSnapshot, Process, ToolCall } from "../../src/kernel/types.ts";
import { BLOB_PREFIX } from "../../src/store/blobs.ts";
import { loadProcess, loadProcesses, openDb } from "../../src/store/db.ts";
import { handleNext, pruneSegments, removeProcess, send, startProcess, sweepBlobs } from "../../src/store/inputs.ts";
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
/** 会话配置（D71）：一次模拟里最多发这么多条 reconfigure。 */
const RECONFIGURES = 4;
/** 删除类的操作每种最多做这么多次（removeProcess 被拒绝也算一次）。 */
const PRUNES = 4;
const REMOVES = 8;
const SWEEPS = 3;
const DELETE_FROM = 14;
/** 窗口小一些，让换段也会发生。不带记忆：启动检查要给记忆的上界留 16,403 token（D80），这个窗口装不下；带记忆的快照由 `reconfigured` 造。 */
const CRASH_PRESET: PresetSnapshot = {
  ...PRESET,
  contextWindow: 60_000,
  handoff: 10_000,
  tools: ["read"],
  input: ["text", "image"],
  toolDefs: [{ name: "decl", description: "声明库内动作", parameters: { type: "object" }, command: "x", timeout: 60, output: "content" }],
};
/** read、decl 是库外工具（decl 的结果声明库内动作）；memory_*、self、handoff 是库内工具；bash 不在预设里；nope 不存在。 */
const TOOLS = ["read", "read", "read", "decl", "decl", "decl", "decl", "memory_get", "memory_set", "self", "handoff", "bash", "nope"];

type Kind = "start" | "send" | "stop" | "reconfigure" | "handle" | "claim" | "complete" | "prune" | "remove" | "sweep";

/** 服务造的新快照：以待换的（没有就是当前的）为底，随机改一两样。启动检查不查：小的阈值也要走交接后的检查。 */
function reconfigured(run: Run, p: Process): PresetSnapshot {
  const s: PresetSnapshot = { ...(p.next ?? p.preset) };
  for (let i = 0, k = 1 + Math.floor(run.rand() * 2); i < k; i++) {
    switch (Math.floor(run.rand() * 7)) {
      case 0:
        if (run.rand() < 0.3) delete s.thinking;
        else s.thinking = run.rand() < 0.5 ? "low" : "high";
        break;
      case 1:
        if (run.rand() < 0.3) delete s.handoff;
        else s.handoff = 3_000 + Math.floor(run.rand() * 7_000);
        break;
      case 2:
        s.prompt = `第 ${run.reconfigures} 版提示词`;
        break;
      case 3:
        s.tools = run.rand() < 0.5 ? ["read"] : ["read", "memory"];
        break;
      case 4:
        s.toolDefs = run.rand() < 0.5 ? [] : CRASH_PRESET.toolDefs;
        break;
      case 5:
        s.contextWindow = run.rand() < 0.5 ? 45_000 : 60_000;
        s.input = ["text", "image"]; // 不收图的模型会让后来的信不存图片，“带图片的信”的覆盖就靠不住了；换成不收图的模型，纯函数层的测试覆盖了。
        break;
      default:
        if (run.rand() < 0.5) delete s.context;
        else s.context = ["AGENTS.md"];
    }
  }
  return s;
}

/** 结构性字段的摘要，比较两份快照结构是否一样。 */
const structure = (p: PresetSnapshot): string => JSON.stringify([p.workdir, p.model, p.tools, p.toolDefs, p.prompt, p.contextWindow, p.input, p.context ?? null]);

/** 处理一条输入之后：记下会话配置的几种结果；运行中改了 `handoff` 的进程，到下一个副作用发出以前不检查阈值相关的不变量。 */
function noteReconfigure(run: Run, input: Input, before: Process, after: Process): void {
  if (input.kind === "reconfigure") {
    run.did.reconfigured++;
    if (after.next !== undefined) run.did.pending++;
    if (after.next === undefined && structure(after.preset) !== structure(before.preset)) run.did.adopted++;
    if (before.phase.tag !== "idle" && before.preset.handoff !== after.preset.handoff) run.relaxed.set(after.id, after.lastEffect);
  } else if (before.next !== undefined && after.segment.seq > before.segment.seq && after.next === undefined) run.did.nextAdopted++;
}

/** 还要放宽阈值检查的进程：发出了新的副作用，或者回到 idle，就不再放宽。 */
function relaxedIds(run: Run): Set<string> {
  for (const [id, n] of run.relaxed) {
    const p = loadProcess(run.life.db, id);
    if (!p || p.phase.tag === "idle" || p.lastEffect !== n) run.relaxed.delete(id);
  }
  return new Set(run.relaxed.keys());
}

/** 假模型：回复只由进程 ID 和副作用编号决定，所以重放时完全一样。 */
function model(job: Job): AssistantMessage {
  const { id } = job.process;
  const e = job.effect;
  const r = rng(hash(`${id}#${e.n}`));
  if (e.kind === "callModel" && e.purpose === "handoff") {
    return r() < 0.8 ? reply("stop", [{ type: "text", text: `交接说明 ${id}#${e.n}` }]) : { ...reply("error", []), errorMessage: "交接时出错" };
  }
  const x = r();
  const usage = Math.floor(r() * 12_000);
  if (x < 0.35) return reply("stop", [{ type: "text", text: `回复 ${id}#${e.n}` }], usage);
  if (x < 0.95) {
    const calls: ToolCall[] = [];
    for (let i = 0, k = 1 + Math.floor(r() * 3); i < k; i++) {
      const name = i === 0 && r() < 0.4 ? "decl" : TOOLS[Math.floor(r() * TOOLS.length)]!;
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

/** decl 的结果声明的动作：寄给 p1 或 p2（可能不存在、可能是自己）、停止它们、写读记忆，偶尔声明不能声明的 handoff。 */
function declared(callId: string): ToolOutput {
  const r = rng(hash(callId));
  const pid = () => `p${1 + Math.floor(r() * 2)}`;
  const menu: (() => DeclaredCall)[] = [
    () => ({ name: "post", arguments: { to: pid(), text: `声明 ${callId}` } }),
    () => ({ name: "stop_process", arguments: { process: pid() } }),
    () => ({ name: "memory_set", arguments: { key: `d-${callId}`, value: callId } }),
    () => ({ name: "memory_get", arguments: { key: "d" } }),
    () => ({ name: "handoff", arguments: {} }),
  ];
  const calls = Array.from({ length: 1 + Math.floor(r() * 3) }, () => menu[Math.floor(r() * menu.length)]!());
  return { ...res(`out:${callId}`), calls };
}

/** 每个 read 结果都带一张图片，像带图的 content 输出：内容里是引用，图片的字节由执行器在上报结果的事务里存。 */
function toolOutput(call: ToolCall): ToolOutput {
  const r = rng(hash(call.id));
  if (call.name === "decl") return declared(call.id);
  if (call.name !== "read") return res(`out:${call.id}`);
  const [image] = checkImages([png(10, 10, 1000 + Math.floor(r() * 40)).toString("base64")]);
  return { content: [{ type: "text", text: `out:${call.id}` }, { type: "image", data: BLOB_PREFIX + image!.hash, mimeType: image!.mimeType }], isError: false, images: [image!] };
}

const blobCount = (db: DatabaseSync): number => db.prepare("SELECT COUNT(*) AS n FROM blobs").get()?.n as number;

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
  reconfigures: number;
  /** 运行中被 `reconfigure` 改过 `handoff` 的进程 -> 那时的 `lastEffect`：发出新的副作用（或回到 idle）以前，和阈值有关的不变量不检查。 */
  relaxed: Map<string, number>;
  /** 寄出的要回信的信。 */
  asked: number;
  processes: string[];
  /** 起过的进程数，新进程 ID 由它算：删掉的 ID 不复用。 */
  spawned: number;
  /** 被删掉的消息里的用户消息（不含换段时带进新段的副本）：它们在删除之前已经提交，仍然算“恰好出现一次”。 */
  archive: string[];
  /** 带声明动作的工具结果（按工具调用 ID）是不是错误：进程被删以后消息没了，所以在处理时记。 */
  declared: Map<string, boolean>;
  prunes: number;
  removes: number;
  sweeps: number;
  /** 真的删掉了东西的次数。 */
  did: { pruned: number; removed: number; swept: number; toolImages: number; reconfigured: number; pending: number; adopted: number; nextAdopted: number };
}

const jobKey = (job: Job) => `${job.process.id}#${job.effect.n}`;

/** 打开库，建执行器（启动恢复在这里做）。 */
function boot(path: string, dbs: DatabaseSync[]): Life {
  const db = openDb(path);
  dbs.push(db);
  // 这里模拟的崩溃是关掉句柄，不是断电，不需要每次提交都落盘；关掉它让几千次重放快一些。
  db.exec("PRAGMA synchronous = OFF");
  const actions = gated(model, (_job, call) => toolOutput(call));
  return { db, exec: createExecutor(db, actions), gates: actions.gates, inflight: [] };
}

function enabled(run: Run): Kind[] {
  const { db, inflight } = run.life;
  const out: Kind[] = [];
  if (run.users.length < USER_MESSAGES && run.processes.length < 2) out.push("start");
  if (run.users.length < USER_MESSAGES && run.processes.length > 0) out.push("send");
  if (run.stops < STOPS && run.processes.length > 0) out.push("stop");
  if (run.reconfigures < RECONFIGURES && run.processes.length > 0) out.push("reconfigure");
  // 删除类的操作到后面才开始：先让进程换几段、结束几轮，删的才有东西可删。
  if (run.clock >= DELETE_FROM) {
    if (run.prunes < PRUNES && withOldSegments(run).length > 0) out.push("prune");
    if (run.removes < REMOVES && idleIds(run).length > 0) out.push("remove");
    // 清图片要在真的删过东西以后：删之前清，什么都清不掉。
    if (run.sweeps < SWEEPS && run.did.pruned + run.did.removed > run.sweeps) out.push("sweep");
  }
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
      const id = `p${++run.spawned}`;
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
        const reply = run.rand() < 0.75;
        send(db, to, userLetter(text), [], { id: other, reply });
        if (reply) run.asked++;
      } else send(db, to, userLetter(text), maybeImages(run));
      run.users.push(text);
      return;
    }
    case "stop":
      send(db, pick(run, run.processes), { kind: "stop" });
      run.stops++;
      return;
    case "reconfigure": {
      const id = pick(run, run.processes);
      send(db, id, { kind: "reconfigure", preset: reconfigured(run, loadProcess(db, id)!) });
      run.reconfigures++;
      return;
    }
    case "handle": {
      const head = mailbox(db)[0]!;
      const before = loadProcess(db, head.id)!;
      const h = handleNext(db, run.memory, now);
      assert.ok(h);
      noteReconfigure(run, head.input, before, h.process);
      for (const m of h.segment) if (m.role === "toolResult" && m.content.some((c) => c.type === "text" && /\n\n\[(post|stop_process|memory_set|memory_get|handoff)\] /.test(c.text))) run.declared.set(m.toolCallId, m.isError);
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
    case "prune": {
      const id = pick(run, withOldSegments(run));
      const seq = loadProcess(db, id)!.segment.seq;
      const before = run.rand() < 0.5 ? seq : 1 + Math.floor(run.rand() * seq);
      const gone = deletedMessages(db, id, before);
      pruneSegments(db, id, before);
      run.prunes++;
      if (gone.length > 0) run.did.pruned++;
      run.archive.push(...gone.map(userText));
      run.did.toolImages += gone.filter(hasToolImage).length;
      return;
    }
    case "remove": {
      const id = pick(run, idleIds(run));
      const gone = deletedMessages(db, id, Infinity);
      run.removes++;
      try {
        removeProcess(db, id);
      } catch {
        return; // 被拒绝是正常结果：空闲、没人引用才能删。
      }
      run.processes.splice(run.processes.indexOf(id), 1);
      run.archive.push(...gone.map(userText));
      run.did.toolImages += gone.filter(hasToolImage).length;
      run.did.removed++;
      return;
    }
    case "sweep":
      run.sweeps++;
      run.did.swept += sweepBlobs(db);
      return;
    default:
      return unreachable(kind);
  }
}

/** 换过段的进程：有旧段可删。 */
function withOldSegments(run: Run): string[] {
  return run.processes.filter((id) => loadProcess(run.life.db, id)!.segment.seq > 1);
}

/** 现在空闲的进程。removeProcess 只删它们（别的条件拒绝与否，由事务判断）。 */
function idleIds(run: Run): string[] {
  return run.processes.filter((id) => loadProcess(run.life.db, id)?.phase.tag === "idle");
}

/** 一个进程段号小于 `before` 的消息（不含换段带进新段的副本），删之前先记下：用户消息算进“恰好出现一次”，带图的工具结果算进覆盖。 */
function deletedMessages(db: DatabaseSync, id: string, before: number): Message[] {
  return db
    .prepare("SELECT message_json FROM segment_messages WHERE process_id = ? AND segment_seq < ? AND NOT (segment_seq > 1 AND seq = 0) ORDER BY segment_seq, seq")
    .all(id, before)
    .map((r) => JSON.parse(r.message_json as string) as Message);
}

const hasToolImage = (m: Message): boolean => m.role === "toolResult" && m.content.some((c) => c.type === "image");

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
  const blobsBefore = blobCount(run.life.db);
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
  assertStoreInvariants(db, relaxedIds(run));

  // 旧的动作这时才完成：它们拿着关掉的库，什么都写不进去。
  for (const f of abandoned) {
    f.gate.finish();
    await assert.rejects(f.done, /not open/);
  }
  assert.deepEqual(mailbox(db), after);
  // 没写回的结果，它的图片也没有写进 blobs：恢复和旧动作的失败写入都不动 blobs。
  assert.equal(blobCount(db), blobsBefore);

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
async function play(empty: Empty, seed: number, crashAt: number | null): Promise<{ steps: number; asked: number; backs: number; blobs: number; toolImages: number; declared: { ok: number; failed: number }; did: Run["did"]; crashed: { kind: Kind; window: boolean } | null }> {
  const path = join(empty.dir, `${seed}-${crashAt ?? "none"}.db`);
  copyFileSync(empty.path, path);
  const { dbs } = empty;
  const run: Run = { path, dbs, memory: fakeMemory(), rand: rng(seed), clock: 0, life: boot(path, dbs), started: [], users: [], stops: 0, reconfigures: 0, relaxed: new Map(), asked: 0, processes: [], spawned: 0, archive: [], declared: new Map(), prunes: 0, removes: 0, sweeps: 0, did: { pruned: 0, removed: 0, swept: 0, toolImages: 0, reconfigured: 0, pending: 0, adopted: 0, nextAdopted: 0 } };
  let steps = 0;
  let crashed: { kind: Kind; window: boolean } | null = null;
  for (let kinds = enabled(run); kinds.length > 0; kinds = enabled(run)) {
    const kind = pick(run, kinds);
    await step(run, kind);
    assertStoreInvariants(run.life.db, relaxedIds(run));
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
  const said = [...run.archive, ...processes.flatMap((p) => allMessages(db, p.id, true)).map(userText)].join("\n");
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
  const blobs = blobCount(db);
  const toolImages = messages.filter((m) => m.role === "toolResult" && m.content.some((c) => c.type === "image")).length;
  db.close();
  const declared = { ok: [...run.declared.values()].filter((e) => !e).length, failed: [...run.declared.values()].filter((e) => e).length };
  return { steps, asked: run.asked, backs, blobs, toolImages, declared, did: run.did, crashed };
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
  let toolImages = 0;
  const declared = { ok: 0, failed: 0 };
  const did = { pruned: 0, removed: 0, swept: 0, toolImages: 0, reconfigured: 0, pending: 0, adopted: 0, nextAdopted: 0 };
  for (const seed of SEEDS) {
    const r = await play(empty, seed, null);
    declared.ok += r.declared.ok;
    declared.failed += r.declared.failed;
    asked += r.asked;
    backs += r.backs;
    blobs += r.blobs;
    toolImages += r.toolImages;
    did.pruned += r.did.pruned;
    did.removed += r.did.removed;
    did.swept += r.did.swept;
    did.toolImages += r.did.toolImages;
    did.reconfigured += r.did.reconfigured;
    did.pending += r.did.pending;
    did.adopted += r.did.adopted;
    did.nextAdopted += r.did.nextAdopted;
  }
  assert.ok(blobs > 0, "没有覆盖到带图片的信");
  assert.ok(toolImages + did.toolImages > 0, "没有覆盖到带图的工具结果");
  assert.ok(declared.ok > 0 && declared.failed > 0, `声明的动作成功 ${declared.ok} 条、失败 ${declared.failed} 条：没有覆盖到`);
  assert.ok(did.pruned > 0, "没有覆盖到真的删掉旧段的 pruneSegments");
  assert.ok(did.removed > 0, "没有覆盖到成功的 removeProcess");
  assert.ok(did.swept > 0, "没有覆盖到真的删掉图片的 sweepBlobs");
  assert.ok(did.reconfigured > 0 && did.pending > 0 && did.adopted > 0 && did.nextAdopted > 0, `会话配置：处理了 ${did.reconfigured} 条，存 next ${did.pending} 次，直接采用 ${did.adopted} 次，换段采用 ${did.nextAdopted} 次：没有覆盖到`);
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
  // 每一种事务（含三个删除）之后都崩溃过，running 的窗口也崩溃过；启动恢复之后的崩溃每次 crash 里都有。
  assert.deepEqual([...covered].sort(), ["claim", "complete", "handle", "prune", "reconfigure", "remove", "send", "start", "stop", "sweep", "window"]);
});
