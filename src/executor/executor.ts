// 执行器：库外副作用的开始、中止、上报（见 .knowledge/kb-executor.md）。不做决策，不重试。
import { effectOf } from "../kernel/decide.ts";
import { textContent, unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Effect, Input, Message, Process, ProcessId, ToolCall, ToolResultContent } from "../kernel/types.ts";
import { loadProcess, loadSegment, post, tx } from "../store/db.ts";

export interface Job {
  process: Process;
  segment: Message[];
  effect: Effect;
}

/** 真正的动作。抛出或拒绝时，执行器把它上报为失败的结果。 */
export interface Actions {
  callModel(job: Job, signal: AbortSignal): Promise<AssistantMessage>;
  runTool(job: Job, call: ToolCall, signal: AbortSignal): Promise<ToolResultContent>;
}

export interface Executor {
  /** 取一个 `pending` 的副作用并开始它；没有就返回 null。返回的 promise 在结果写回或被丢弃之后完成。 */
  startNext(): Promise<void> | null;
  /** 中止一个正在运行的副作用；它不在运行时什么都不做。 */
  abort(id: ProcessId, n: number): void;
}

/** 启动执行器。先做启动恢复，所以每次服务启动只能建一个。 */
export function createExecutor(db: DatabaseSync, actions: Actions): Executor {
  recover(db);
  /** 执行器唯一的活状态：正在运行的副作用的中止开关。 */
  const running = new Map<string, AbortController>();
  const key = (id: ProcessId, n: number) => JSON.stringify([id, n]);
  return {
    startNext() {
      const job = claim(db);
      if (!job) return null;
      const k = key(job.process.id, job.effect.n);
      const ac = new AbortController();
      running.set(k, ac);
      return act(actions, job, ac.signal)
        .then((input) => complete(db, job, input))
        .finally(() => running.delete(k));
    },
    abort(id, n) {
      running.get(key(id, n))?.abort();
    },
  };
}

/** 启动恢复，一个事务：`running` 的行一律删除，作为 `interrupted` 结果放进信箱。`pending` 的行正常开始。 */
function recover(db: DatabaseSync): void {
  tx(db, () => {
    for (const row of db.prepare("DELETE FROM effects WHERE status = 'running' RETURNING process_id, n").all()) {
      const id = row.process_id as string;
      const n = row.n as number;
      const phase = loadProcess(db, id)?.phase ?? { tag: "idle" };
      switch (phase.tag) {
        case "awaitingModel":
          post(db, id, { kind: "modelResult", n, outcome: { status: "interrupted" } });
          break;
        case "awaitingTool":
          post(db, id, { kind: "toolResult", n, outcome: { status: "interrupted" } });
          break;
        case "idle":
          throw new Error(`待办副作用表里有进程 ${id} 的一行，但它不在等副作用。`);
        default:
          unreachable(phase);
      }
    }
  });
}

/** 一个事务：取一个 `pending` 行，读出进程记录和当前段，算出副作用，标记为 `running`。 */
function claim(db: DatabaseSync): Job | null {
  return tx(db, () => {
    const row = db.prepare("SELECT process_id, n FROM effects WHERE status = 'pending' LIMIT 1").get();
    if (!row) return null;
    const process = loadProcess(db, row.process_id as string);
    const segment = process ? loadSegment(db, process) : [];
    const effect = process ? effectOf(process, segment) : null;
    if (!process || !effect || effect.n !== row.n) throw new Error(`待办副作用表和进程 ${String(row.process_id)} 不一致。`);
    db.prepare("UPDATE effects SET status = 'running' WHERE process_id = ?").run(process.id);
    return { process, segment, effect };
  });
}

/** 一个事务：这一行还在，就删掉它并把结果放进信箱；已经不在，就丢弃结果。 */
function complete(db: DatabaseSync, job: Job, input: Input): void {
  tx(db, () => {
    const gone = db.prepare("DELETE FROM effects WHERE process_id = ? AND n = ?").run(job.process.id, job.effect.n);
    if (Number(gone.changes) > 0) post(db, job.process.id, input);
  });
}

/** 同步开始动作，返回它的结果输入。失败也是结果。 */
function act(actions: Actions, job: Job, signal: AbortSignal): Promise<Input> {
  const e = job.effect;
  switch (e.kind) {
    case "callModel":
      return attempt(() => actions.callModel(job, signal)).then(
        (message): Input => ({ kind: "modelResult", n: e.n, outcome: { status: "ok", message } }),
        (err: unknown): Input => ({ kind: "modelResult", n: e.n, outcome: { status: "ok", message: failedReply(job.process, err) } }),
      );
    case "runTool":
      return attempt(() => actions.runTool(job, e.call, signal)).then(
        (content): Input => ({ kind: "toolResult", n: e.n, outcome: { status: "ok", content } }),
        (err: unknown): Input => ({ kind: "toolResult", n: e.n, outcome: { status: "ok", content: { content: textContent(`工具执行失败：${message(err)}`), isError: true } } }),
      );
    default:
      return unreachable(e);
  }
}

/** 同步调用 `f`；同步抛出也变成被拒绝的 promise。 */
function attempt<T>(f: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(f()));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failedReply(p: Process, err: unknown): AssistantMessage {
  const [provider = "", ...model] = p.preset.model.split("/");
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider,
    model: model.join("/"),
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: "error",
    errorMessage: message(err),
    timestamp: Date.now(),
  };
}
