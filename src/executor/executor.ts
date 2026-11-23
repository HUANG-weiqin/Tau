// 执行器：库外副作用的开始、中止、上报（见 .knowledge/kb-executor.md）。不做决策，不重试。
import { effectOf, hurried } from "../kernel/decide.ts";
import { textContent, unreachable } from "../kernel/types.ts";
import type { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, DeclaredCall, Effect, Input, Message, Process, ProcessId, ToolCall, ToolResultContent } from "../kernel/types.ts";
import type { Image } from "../images.ts";
import { putBlobs } from "../store/blobs.ts";
import { loadProcess, loadSegment, putMail, tx } from "../store/db.ts";

export interface Job {
  process: Process;
  segment: Message[];
  effect: Effect;
}

/**
 * 工具的结果。带图的 `content` 输出还带着要存的图片：内容里是 `blob:<hash>` 引用，字节由执行器在上报结果的事务里插入 `blobs`。
 * `calls` 是 `content` 输出声明的库内动作：执行器原样放进结果的输入，不解释它。
 */
export type ToolOutput = ToolResultContent & { images?: readonly Image[]; calls?: readonly DeclaredCall[] };

/** 真正的动作。抛出或拒绝时，执行器把它上报为失败的结果。 */
export interface Actions {
  callModel(job: Job, signal: AbortSignal): Promise<AssistantMessage>;
  /** `hurry` 被中止就是“有信在排队”（D104）：只有内置 bash 理它，别的工具忽略。 */
  runTool(job: Job, call: ToolCall, signal: AbortSignal, hurry: AbortSignal): Promise<ToolOutput>;
}

export interface Executor {
  /** 取一个 `pending` 的副作用并开始它；没有就返回 null。返回的 promise 在结果写回或被丢弃之后完成。 */
  startNext(): Promise<void> | null;
  /** 中止一个正在运行的副作用；它不在运行时什么都不做。 */
  abort(id: ProcessId, n: number): void;
  /** 催一个正在运行的副作用（D104）；它不在运行时什么都不做。 */
  hurry(id: ProcessId, n: number): void;
  /** 这个进程在执行器里还有没收尾的动作（包括已被中止、还没结束的）。只读。服务删进程之前用它。 */
  busy(id: ProcessId): boolean;
}

/** 启动执行器。先做启动恢复，所以每次服务启动只能建一个。 */
export function createExecutor(db: DatabaseSync, actions: Actions): Executor {
  recover(db);
  /** 执行器唯一的活状态：正在运行的副作用的中止开关和催的开关。 */
  const running = new Map<string, { abort: AbortController; hurry: AbortController }>();
  const key = (id: ProcessId, n: number) => JSON.stringify([id, n]);
  return {
    startNext() {
      const job = claim(db);
      if (!job) return null;
      const k = key(job.process.id, job.effect.n);
      const live = { abort: new AbortController(), hurry: new AbortController() };
      if (hurried(job.process)) live.hurry.abort();
      running.set(k, live);
      return act(actions, job, live.abort.signal, live.hurry.signal)
        .then((outcome) => complete(db, job, outcome))
        .finally(() => running.delete(k));
    },
    abort(id, n) {
      running.get(key(id, n))?.abort.abort();
    },
    hurry(id, n) {
      running.get(key(id, n))?.hurry.abort();
    },
    busy(id) {
      const prefix = `${JSON.stringify([id]).slice(0, -1)},`;
      return [...running.keys()].some((k) => k.startsWith(prefix));
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
          putMail(db, id, { kind: "modelResult", n, outcome: { status: "interrupted" } });
          break;
        case "awaitingTool":
          putMail(db, id, { kind: "toolResult", n, outcome: { status: "interrupted" } });
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

/** 动作的结果：要放进信箱的输入，加上它引用的图片（只有带图的工具结果有）。 */
interface Outcome {
  input: Input;
  images: readonly Image[];
}

/** 一个事务：这一行还在，就删掉它，把图片存进 `blobs`，把结果放进信箱；已经不在，就丢弃结果和图片。 */
function complete(db: DatabaseSync, job: Job, { input, images }: Outcome): void {
  tx(db, () => {
    const gone = db.prepare("DELETE FROM effects WHERE process_id = ? AND n = ?").run(job.process.id, job.effect.n);
    if (Number(gone.changes) === 0) return;
    putBlobs(db, images);
    putMail(db, job.process.id, input);
  });
}

/** 同步开始动作，返回它的结果。失败也是结果。 */
function act(actions: Actions, job: Job, signal: AbortSignal, hurry: AbortSignal): Promise<Outcome> {
  const e = job.effect;
  switch (e.kind) {
    case "callModel":
      return attempt(() => actions.callModel(job, signal)).then(
        (message): Outcome => ({ input: { kind: "modelResult", n: e.n, outcome: { status: "ok", message } }, images: [] }),
        (err: unknown): Outcome => ({ input: { kind: "modelResult", n: e.n, outcome: { status: "ok", message: failedReply(job.process, err) } }, images: [] }),
      );
    case "runTool":
      return attempt(() => actions.runTool(job, e.call, signal, hurry)).then(
        ({ images = [], calls, ...content }): Outcome => ({ input: { kind: "toolResult", n: e.n, outcome: { status: "ok", content, ...(calls ? { calls: [...calls] } : {}) } }, images }),
        (err: unknown): Outcome => ({ input: { kind: "toolResult", n: e.n, outcome: { status: "ok", content: { content: textContent(`工具执行失败：${message(err)}`), isError: true } } }, images: [] }),
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
