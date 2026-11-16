// 进程的事务：启动、收一条命令、处理一条输入（见 .knowledge/kb-store.md）。每个函数恰好一个事务。
import { decide, effectOf, fork, start } from "../kernel/decide.ts";
import { startError } from "../kernel/derive.ts";
import { findTool } from "../kernel/tools.ts";
import { textContent, unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Effect, Input, Instant, Memory, Message, PresetSnapshot, Process, ProcessId, ToolResultContent } from "../kernel/types.ts";
import type { Image } from "../images.ts";
import { letterContent } from "./blobs.ts";
import { appendMessages, loadProcess, loadSegment, putMail, saveProcess, tx } from "./db.ts";
import { envFor, runInStore } from "./instore.ts";
import type { ReadPreset } from "./instore.ts";

/**
 * 写入 `start` 返回的进程记录，把第一条消息作为用户的信放进信箱。启动检查不通过（设计稿 5.6）就抛错，什么都不写。
 * `images` 是通过入口检查的图片（`checkImages`）：模型收图片就和信在同一个事务里存进 `blobs`，否则每张换成一行说明。
 */
export function startProcess(db: DatabaseSync, memory: Memory, id: ProcessId, preset: PresetSnapshot, text: string, now: Instant, images: readonly Image[] = []): void {
  const tooBig = startError(preset);
  if (tooBig !== null) throw new Error(tooBig);
  tx(db, () => {
    const p = start(id, preset, envFor(memory, preset, now));
    db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(p));
    putMail(db, id, { kind: "letter", letter: { from: { kind: "user" }, content: letterContent(db, text, images, preset.input.includes("image")), hops: 0 } });
  });
}

/**
 * 从源进程的当前段分叉出新进程 `id`：读源进程记录和当前段、写新进程记录和复制的消息，在一个事务里。拒绝的情形见 `fork`，加上启动检查；抛错就什么都不写。
 * 不寄信：没有输入要处理。图片的 `blob:` 引用照用，`blobs` 只增不删。
 */
export function forkProcess(db: DatabaseSync, id: ProcessId, source: ProcessId, before: number | undefined, now: Instant): { process: Process; segment: Message[] } {
  return tx(db, () => {
    const old = loadProcess(db, source);
    if (!old) throw new Error(`没有这个进程：${source}`);
    const { process, messages } = fork(id, old, loadSegment(db, old), before, now);
    const tooBig = startError(process.preset);
    if (tooBig !== null) throw new Error(tooBig);
    db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(process));
    appendMessages(db, process, 0, messages);
    return { process, segment: messages };
  });
}

/** 把信或停止放进一个已有进程的信箱。提交之后才能发回执。`images` 只能跟着信：按目标进程的模型收不收图片，存进 `blobs` 或换成说明。 */
export function send(db: DatabaseSync, id: ProcessId, input: Extract<Input, { kind: "letter" | "stop" }>, images: readonly Image[] = []): void {
  tx(db, () => {
    const p = loadProcess(db, id);
    if (!p) throw new Error(`没有这个进程：${id}`);
    if (images.length === 0) return putMail(db, id, input);
    if (input.kind !== "letter") throw new Error("图片只能跟着信。");
    const text = input.letter.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    putMail(db, id, { kind: "letter", letter: { ...input.letter, content: letterContent(db, text, images, p.preset.input.includes("image")) } });
  });
}

export interface Handled {
  process: Process;
  /** 处理之后的当前段。 */
  segment: readonly Message[];
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
    const { process: p, append, out } = decide(old, seg, JSON.parse(row.input_json as string) as Input, envFor(memory, old.preset, now));
    const sameSegment = p.segment.seq === old.segment.seq;
    saveProcess(db, p);
    appendMessages(db, p, sameSegment ? seg.length : 0, append);
    for (const { to, letter } of out) putMail(db, to, { kind: "letter", letter });
    db.prepare("DELETE FROM mailbox WHERE seq = ?").run(row.seq as number);
    const segment = sameSegment ? [...seg, ...append] : append;
    const abort = syncEffects(db, memory, p, segment, effectOf(old, seg), now, readPreset);
    return { process: p, segment, abort };
  });
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
