// 进程的事务：启动、分叉、收一条命令、处理一条输入、三个删除、写记忆（见 .knowledge/kb-store.md）。每个函数恰好一个事务。
import { decide, effectOf, fork, start } from "../kernel/decide.ts";
import { HOPS_MAX, startError } from "../kernel/derive.ts";
import { findTool } from "../kernel/tools.ts";
import { textContent, unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Effect, Input, Instant, Memory, MemoryFailure, MemoryOp, Message, PresetSnapshot, Process, ProcessId, ToolResultContent } from "../kernel/types.ts";
import type { Image } from "../images.ts";
import { letterContent } from "./blobs.ts";
import { appendMessages, loadProcess, loadProcesses, loadSegment, putMail, saveProcess, tx } from "./db.ts";
import { envFor, nextHops, runDeclared, runInStore, sender } from "./instore.ts";
import type { ReadPreset } from "./instore.ts";

/**
 * 写入 `start` 返回的进程记录，把第一条消息作为用户的信放进信箱。启动检查不通过（设计稿 5.6）就抛错，什么都不写。
 * `images` 是通过入口检查的图片（`checkImages`）：模型收图片就和信在同一个事务里存进 `blobs`，否则每张换成一行说明。
 */
export function startProcess(db: DatabaseSync, memory: Memory, id: ProcessId, preset: PresetSnapshot, text: string, now: Instant, images: readonly Image[] = []): void {
  const tooBig = startError(preset);
  if (tooBig !== null) throw new Error(tooBig);
  tx(db, () => {
    checkFreeId(db, id);
    const p = start(id, preset, envFor(memory, preset, now));
    db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(p));
    putMail(db, id, { kind: "letter", letter: { from: { kind: "user" }, content: letterContent(db, text, images, preset.input.includes("image")), hops: 0 } });
  });
}

/**
 * 从源进程的当前段分叉出新进程 `id`：读源进程记录和当前段、写新进程记录和复制的消息，在一个事务里。拒绝的情形见 `fork`，加上启动检查；抛错就什么都不写。
 * 不寄信：没有输入要处理。图片的 `blob:` 引用照用，`blobs` 不动（没人引用以后由 `sweepBlobs` 清）。
 * 带 `preset`（调用方在事务之外读好的）是换角色：记忆视图按它重取，和 `spawn` 一样。
 */
export function forkProcess(db: DatabaseSync, memory: Memory, id: ProcessId, source: ProcessId, before: number | undefined, now: Instant, preset?: PresetSnapshot): { process: Process; segment: Message[] } {
  return tx(db, () => {
    checkFreeId(db, id);
    const old = loadProcess(db, source);
    if (!old) throw new Error(`没有这个进程：${source}`);
    const { process, messages } = fork(id, old, loadSegment(db, old), before, now, preset && { preset, memoryView: envFor(memory, preset, now).memoryView });
    const tooBig = startError(process.preset);
    if (tooBig !== null) throw new Error(tooBig);
    db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(process));
    appendMessages(db, process, 0, messages);
    return { process, segment: messages };
  });
}

/** 已有同名进程就抛错：调用方定的 ID 重试时，什么都不写，所以是幂等的（D64 第 9 组）。 */
function checkFreeId(db: DatabaseSync, id: ProcessId): void {
  if (loadProcess(db, id)) throw new Error(`进程 ID 已存在：${id}`);
}

/** 带 `from` 的信：以进程 `id` 的名义寄出，`reply` 为真时要回信（D64 第 8 组）。 */
export interface SendFrom {
  id: ProcessId;
  reply: boolean;
}

/**
 * 把信或停止放进一个已有进程的信箱。提交之后才能发回执。`images` 只能跟着信：按目标进程的模型收不收图片，存进 `blobs` 或换成说明。
 * 带 `from`（只对信）：发送者、跳数、`replyTo` 都从 `from.id` 的记录构造，和它调用 `post` 寄出的信同形，永远不带 `reply`，所以不能伪造回信。
 * 拒绝（什么都不写）：`from.id` 不存在、等于目标、跳数超过 `HOPS_MAX`。
 */
export function send(db: DatabaseSync, id: ProcessId, input: Extract<Input, { kind: "letter" | "stop" }>, images: readonly Image[] = [], from?: SendFrom): void {
  tx(db, () => {
    const p = loadProcess(db, id);
    if (!p) throw new Error(`没有这个进程：${id}`);
    let letter = input.kind === "letter" ? input.letter : undefined;
    if (from) {
      if (!letter) throw new Error("from 只能跟着信。");
      if (from.id === id) throw new Error("不能给自己寄信。");
      const a = loadProcess(db, from.id);
      if (!a) throw new Error(`没有这个进程：${from.id}`);
      const hops = nextHops(a);
      if (hops > HOPS_MAX) throw new Error(`跳数到上限（${HOPS_MAX}）：这封信是被进程之间的信一路引出来的。`);
      const { replyTo: _, ...rest } = letter;
      letter = { ...rest, from: sender(a), hops, ...(from.reply ? { replyTo: a.id } : {}) };
    }
    if (images.length === 0) return putMail(db, id, letter ? { kind: "letter", letter } : input);
    if (!letter) throw new Error("图片只能跟着信。");
    const text = letter.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    putMail(db, id, { kind: "letter", letter: { ...letter, content: letterContent(db, text, images, p.preset.input.includes("image")) } });
  });
}

/** 删这个进程段号小于 `before` 的旧段。当前段不删，进程在运行也行；`before` ≤ 1 什么都不删。没有这个进程、`before` 大于当前段号就抛错。 */
export function pruneSegments(db: DatabaseSync, id: ProcessId, before: number): void {
  tx(db, () => {
    const p = loadProcess(db, id);
    if (!p) throw new Error(`没有这个进程：${id}`);
    if (before > p.segment.seq) throw new Error(`进程 ${id} 的当前段是第 ${p.segment.seq} 段，before ${before} 超出了当前段。`);
    db.prepare("DELETE FROM segment_messages WHERE process_id = ? AND segment_seq < ?").run(id, before);
  });
}

/**
 * 删一个进程的记录和全部段。不碰记忆、`blobs`、`effects`（空闲的进程没有 `effects` 行）。
 * 拒绝（抛错，什么都不删）：没有这个进程、不是空闲、信箱里有它的输入、有进程的 `parent` 是它、它在任何 `turn.replyTo` 或排队的信的 `replyTo` 里。
 * 这样被删的进程不再被任何地方引用。执行器里还有它的动作没收尾，这里看不到，由服务在调用之前查。
 */
export function removeProcess(db: DatabaseSync, id: ProcessId): void {
  tx(db, () => {
    const all = loadProcesses(db);
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`没有这个进程：${id}`);
    if (p.phase.tag !== "idle") throw new Error(`进程 ${id} 不是空闲，不能删。`);
    const mail = db.prepare("SELECT process_id, input_json FROM mailbox").all().map((r) => ({ id: r.process_id as string, input: JSON.parse(r.input_json as string) as Input }));
    if (mail.some((m) => m.id === id)) throw new Error(`信箱里还有进程 ${id} 的输入，不能删。`);
    const child = all.find((x) => x.parent === id);
    if (child) throw new Error(`进程 ${child.id} 的父进程是 ${id}，不能删。先删子进程。`);
    const waiting = all.find((x) => x.phase.tag !== "idle" && (x.phase.turn.replyTo.includes(id) || x.phase.turn.queued.some((l) => l.replyTo === id)));
    if (waiting) throw new Error(`进程 ${waiting.id} 还要给 ${id} 回信，不能删。`);
    if (mail.some((m) => m.input.kind === "letter" && m.input.letter.replyTo === id)) throw new Error(`信箱里有要回信给 ${id} 的信，不能删。`);
    db.prepare("DELETE FROM segment_messages WHERE process_id = ?").run(id);
    db.prepare("DELETE FROM processes WHERE id = ?").run(id);
  });
}

/** 清掉没人引用的图片，返回删掉的行数。引用在全部进程的全部段、信箱、进程记录（`turn.queued`）里，按原文找 `blob:` 加 64 位十六进制：多认只会多留。 */
export function sweepBlobs(db: DatabaseSync): number {
  return tx(db, () => {
    const used = new Set<string>();
    for (const sql of ["SELECT message_json AS j FROM segment_messages", "SELECT input_json AS j FROM mailbox", "SELECT state_json AS j FROM processes"]) {
      for (const row of db.prepare(sql).all()) for (const m of (row.j as string).matchAll(/blob:([0-9a-f]{64})/g)) used.add(m[1]!);
    }
    const drop = db.prepare("DELETE FROM blobs WHERE hash = ?");
    let swept = 0;
    for (const row of db.prepare("SELECT hash FROM blobs").all()) if (!used.has(row.hash as string)) swept += Number(drop.run(row.hash as string).changes);
    return swept;
  });
}

/** 一批记忆写入里第一个失败的那项：只在事务里用来触发回滚。 */
class Rejected extends Error {
  index: number;
  result: MemoryFailure;
  constructor(index: number, result: MemoryFailure) {
    super("记忆写入被拒绝");
    this.index = index;
    this.result = result;
  }
}

/**
 * 按顺序执行一批记忆写入，整批一个事务：第一个失败就整批回滚（版本号序列也不前进），返回它的下标和 `Memory` 的失败形状。成功时给每一项的版本，删除是 null。
 * 不看预设是否存在、有没有 `memory`；不写进程记录、段和信箱。
 */
export function writeMemory(db: DatabaseSync, memory: Memory, ops: readonly MemoryOp[]): { ok: true; versions: (number | null)[] } | { ok: false; index: number; result: MemoryFailure } {
  try {
    const versions = tx(db, () =>
      ops.map((op, i): number | null => {
        if (op.kind === "delete") {
          const r = memory.delete(op.ns, op.key, op.expected);
          if (!r.ok) throw new Rejected(i, r);
          return null;
        }
        const r = memory.set(op.ns, op.key, op.value, op.expected);
        if (!r.ok) throw new Rejected(i, r);
        return r.version;
      }),
    );
    return { ok: true, versions };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, index: e.index, result: e.result };
    throw e;
  }
}

export interface Handled {
  process: Process;
  /** 处理之后的当前段。 */
  segment: readonly Message[];
  /** 这次追加进段的消息和第一条的段内序号：换段时从 0 起，段号是 `process.segment.seq`。服务靠它推 watch 的消息，不读库。 */
  appended: { from: number; messages: readonly Message[] };
  /** 这个事务删掉了一个 `running` 行时，是它的副作用编号：调用方要中止执行器里的这个动作。 */
  abort: number | null;
}

/** 处理信箱里最早的一条输入。信箱空时返回 null。 */
export function handleNext(db: DatabaseSync, memory: Memory, now: Instant, readPreset?: ReadPreset): Handled | null {
  return tx(db, () => {
    const row = db.prepare("SELECT seq, process_id, input_json FROM mailbox ORDER BY seq LIMIT 1").get();
    if (!row) return null;
    const old = loadProcess(db, row.process_id as string);
    if (!old) throw new Error(`信箱里的输入属于一个不存在的进程：${String(row.process_id)}`);
    const seg = loadSegment(db, old);
    const before = effectOf(old, seg);
    const input = declaredFirst(db, memory, old, seg, before, JSON.parse(row.input_json as string) as Input, now, readPreset);
    const { process: p, append, out } = decide(old, seg, input, envFor(memory, old.preset, now));
    const sameSegment = p.segment.seq === old.segment.seq;
    saveProcess(db, p);
    appendMessages(db, p, sameSegment ? seg.length : 0, append);
    for (const { to, letter } of out) putMail(db, to, { kind: "letter", letter });
    db.prepare("DELETE FROM mailbox WHERE seq = ?").run(row.seq as number);
    const segment = sameSegment ? [...seg, ...append] : append;
    const abort = syncEffects(db, memory, p, segment, before, now, readPreset);
    return { process: p, segment, appended: { from: sameSegment ? seg.length : 0, messages: append }, abort };
  });
}

/**
 * 工具结果声明的库内动作（D64 第 10 组），在 `decide` 之前、同一个事务里执行；返回去掉 `calls`、带着执行结果的输入。
 * 条件：这条结果正是 `effectOf(旧记录, 当前段)` 在等的那次 `runTool`（编号相同），而且结果是 ok。其余情形原样返回，声明不执行。永不抛错。
 */
function declaredFirst(db: DatabaseSync, memory: Memory, old: Process, seg: readonly Message[], before: Effect | null, input: Input, now: Instant, readPreset?: ReadPreset): Input {
  if (input.kind !== "toolResult" || input.outcome.status !== "ok") return input;
  const { content, calls, ...rest } = input.outcome;
  if (!calls?.length || before?.kind !== "runTool" || before.n !== input.n) return input;
  return { ...input, outcome: { ...rest, content: runDeclared(db, memory, old, seg, content, calls, now, readPreset) } };
}

/** 第 4.4 节第 4 步：只在等的副作用编号变了才动。返回被删掉的 `running` 行的编号。 */
function syncEffects(db: DatabaseSync, memory: Memory, p: Process, seg: readonly Message[], before: Effect | null, now: Instant, readPreset?: ReadPreset): number | null {
  const after = effectOf(p, seg);
  if (before?.n === after?.n) return null;
  let abort: number | null = null;
  if (before) {
    const gone = db.prepare("DELETE FROM effects WHERE process_id = ? AND n = ? RETURNING status").get(p.id, before.n);
    if (gone?.status === "running") abort = before.n;
  }
  if (!after) return abort;
  switch (after.kind) {
    case "callModel":
      break;
    case "runTool": {
      const spec = findTool(p.preset, after.call.name);
      if (spec?.inStore === false) break;
      const content: ToolResultContent = spec
        ? runInStore(db, memory, p, seg, after.call, now, readPreset)
        : { content: textContent(`工具 ${after.call.name} 不存在，或者预设里没有它。`), isError: true };
      putMail(db, p.id, { kind: "toolResult", n: after.n, outcome: { status: "ok", content } });
      return abort;
    }
    default:
      return unreachable(after);
  }
  db.prepare("INSERT INTO effects (process_id, n, status) VALUES (?, ?, 'pending')").run(p.id, after.n);
  return abort;
}
