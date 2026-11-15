// 进程的事务：启动、收一条命令、处理一条输入（设计稿第 4.4 节）。每个函数恰好一个事务。
import { decide, effectOf, start } from "../kernel/decide.ts";
import { findTool } from "../kernel/tools.ts";
import { unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Effect, Env, Input, Instant, Memory, Message, PresetSnapshot, Process, ProcessId, ToolResultContent } from "../kernel/types.ts";
import { appendMessages, loadProcess, loadSegment, post, saveProcess, tx } from "./db.ts";
import { runInStore } from "./instore.ts";

function envFor(memory: Memory, preset: PresetSnapshot, now: Instant): Env {
  return { now, memoryView: preset.tools.includes("memory") ? memory.view(preset.id) : "" };
}

/** 写入 `start` 返回的进程记录，把第一条消息作为 `userMessage` 放进信箱。 */
export function startProcess(db: DatabaseSync, memory: Memory, id: ProcessId, preset: PresetSnapshot, text: string, now: Instant): void {
  tx(db, () => {
    const p = start(id, preset, envFor(memory, preset, now));
    db.prepare("INSERT INTO processes (id, state_json) VALUES (?, ?)").run(id, JSON.stringify(p));
    post(db, id, { kind: "userMessage", text });
  });
}

/** 把用户消息或停止放进一个已有进程的信箱。提交之后才能发回执。 */
export function send(db: DatabaseSync, id: ProcessId, input: Extract<Input, { kind: "userMessage" | "stop" }>): void {
  tx(db, () => {
    if (!db.prepare("SELECT 1 FROM processes WHERE id = ?").get(id)) throw new Error(`没有这个进程：${id}`);
    post(db, id, input);
  });
}

export interface Handled {
  process: Process;
  /** 这个事务删掉了一个 `running` 行时，是它的副作用编号：调用方要中止执行器里的这个动作。 */
  abort: number | null;
}

/** 处理信箱里最早的一条输入。信箱空时返回 null。 */
export function handleNext(db: DatabaseSync, memory: Memory, now: Instant): Handled | null {
  return tx(db, () => {
    const row = db.prepare("SELECT seq, process_id, input_json FROM mailbox ORDER BY seq LIMIT 1").get();
    if (!row) return null;
    const old = loadProcess(db, row.process_id as string);
    if (!old) throw new Error(`信箱里的输入属于一个不存在的进程：${String(row.process_id)}`);
    const seg = loadSegment(db, old);
    const { process: p, append } = decide(old, seg, JSON.parse(row.input_json as string) as Input, envFor(memory, old.preset, now));
    const sameSegment = p.segment.seq === old.segment.seq;
    saveProcess(db, p);
    appendMessages(db, p, sameSegment ? seg.length : 0, append);
    db.prepare("DELETE FROM mailbox WHERE seq = ?").run(row.seq as number);
    const abort = syncEffects(db, memory, p, sameSegment ? [...seg, ...append] : append, effectOf(old, seg), now);
    return { process: p, abort };
  });
}

/** 第 4.4 节第 4 步：只在等的副作用编号变了才动。返回被删掉的 `running` 行的编号。 */
function syncEffects(db: DatabaseSync, memory: Memory, p: Process, seg: readonly Message[], before: Effect | null, now: Instant): number | null {
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
        ? runInStore(db, memory, p, seg, after.call, now)
        : { text: `工具 ${after.call.name} 不存在，或者预设里没有它。`, isError: true };
      post(db, p.id, { kind: "toolResult", n: after.n, outcome: { status: "ok", content } });
      return abort;
    }
    default:
      return unreachable(after);
  }
  db.prepare("INSERT INTO effects (process_id, n, status) VALUES (?, ?, 'pending')").run(p.id, after.n);
  return abort;
}
