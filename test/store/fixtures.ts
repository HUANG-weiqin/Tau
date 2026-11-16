// 存储和执行器测试的共用部件：临时库、假记忆库、预设、消息、可控的假动作、带种子的随机数。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { Actions, Executor, Job } from "../../src/executor/executor.ts";
import type { AssistantMessage, Input, Memory, Message, PresetSnapshot, ToolCall, ToolResultContent, Versioned } from "../../src/kernel/types.ts";
import { openDb } from "../../src/store/db.ts";
import { res } from "../plain.ts";
import { handleNext } from "../../src/store/inputs.ts";
import type { ReadPreset } from "../../src/store/instore.ts";

export const PRESET: PresetSnapshot = {
  id: "helper",
  workdir: "E:/work",
  model: "faux/model-1",
  tools: ["read", "memory"],
  prompt: "你是测试助手。",
  contextWindow: 1_000_000,
  input: ["text"],
};

/** 一个临时目录，测试结束时先关掉 `dbs` 里还开着的库，再删掉目录。 */
export function tempDir(t: TestContext, dbs: DatabaseSync[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "tau-store-"));
  t.after(() => {
    for (const db of dbs) if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 一个临时库，测试结束时关掉并删掉。 */
export function tempDb(t: TestContext): DatabaseSync {
  const dbs: DatabaseSync[] = [];
  dbs.push(openDb(join(tempDir(t, dbs), "tau.db")));
  return dbs[0]!;
}

export type FakeMemory = Memory & { calls: string[] };

/**
 * 用 Map 实现的记忆库：版本号全库自增，写入 = 删旧插新。`calls` 记录每次调用。
 * 它不检查上限，视图格式也不是真实的（真实的见 src/memory/kv.ts 和它的测试）：测试不要断言它的视图文本。
 */
export function fakeMemory(): FakeMemory {
  const rows = new Map<string, Versioned & { ns: string; key: string }>();
  const calls: string[] = [];
  let last = 0;
  const k = (ns: string, key: string) => JSON.stringify([ns, key]);
  const current = (ns: string, key: string): Versioned | null => {
    const r = rows.get(k(ns, key));
    return r ? { value: r.value, version: r.version } : null;
  };
  return {
    calls,
    view(ns) {
      calls.push("view");
      return [...rows.values()]
        .filter((r) => r.ns === ns)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((r) => `${r.key}: ${r.value}`)
        .join("\n");
    },
    get(ns, key) {
      calls.push("get");
      return current(ns, key);
    },
    set(ns, key, value, expected) {
      calls.push("set");
      const cur = current(ns, key);
      if ((cur?.version ?? null) !== expected) return { ok: false, current: cur };
      rows.set(k(ns, key), { ns, key, value, version: ++last });
      return { ok: true, version: last };
    },
    delete(ns, key, expected) {
      calls.push("delete");
      const cur = current(ns, key);
      if (cur?.version !== expected) return { ok: false, current: cur };
      rows.delete(k(ns, key));
      return { ok: true };
    },
  };
}

export function toolCall(id: string, name: string, args: JsonObject = {}): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function reply(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"], totalTokens = 0): AssistantMessage {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "model-1",
    usage: { ...zero, totalTokens, cost: { ...zero, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

export const say = (text: string) => reply("stop", [{ type: "text", text }]);
export const use = (...calls: ToolCall[]) => reply("toolUse", calls);

/** 立即完成的假动作：模型回复按脚本依次给出，工具回 `out:<调用 ID>`。`log` 记录每个开始的动作。 */
export function scripted(replies: AssistantMessage[]): Actions & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async callModel(job) {
      log.push(`model ${job.process.id} #${job.effect.n}`);
      const r = replies.shift();
      if (!r) throw new Error("脚本里没有更多的模型回复");
      return r;
    },
    async runTool(job, call) {
      log.push(`tool ${job.process.id} #${job.effect.n} ${call.name}`);
      return res(`out:${call.id}`);
    },
  };
}

export interface Gate {
  job: Job;
  signal: AbortSignal;
  /** 让动作完成。 */
  finish(): void;
}

/** 由测试决定何时完成的假动作。中止时拒绝。 */
export function gated(model: (job: Job) => AssistantMessage, tool: (job: Job, call: ToolCall) => ToolResultContent): Actions & { gates: Gate[] } {
  const gates: Gate[] = [];
  const gate = <T>(job: Job, signal: AbortSignal, make: () => T) =>
    new Promise<T>((resolve, reject) => {
      gates.push({ job, signal, finish: () => resolve(make()) });
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  return {
    gates,
    callModel: (job, signal) => gate(job, signal, () => model(job)),
    runTool: (job, call, signal) => gate(job, signal, () => tool(job, call)),
  };
}

/** 处理所有输入、执行所有副作用，直到没有事可做。给了 `gates` 时，每开始一个动作就让它完成。 */
export async function settle(db: DatabaseSync, memory: Memory, exec: Executor, gates?: Gate[], readPreset?: ReadPreset): Promise<void> {
  for (;;) {
    const h = handleNext(db, memory, 0, readPreset);
    if (h) {
      if (h.abort !== null) exec.abort(h.process.id, h.abort);
      continue;
    }
    const done = exec.startNext();
    if (!done) return;
    gates?.at(-1)?.finish();
    await done;
  }
}

export function mailbox(db: DatabaseSync): { id: string; input: Input }[] {
  return db
    .prepare("SELECT process_id, input_json FROM mailbox ORDER BY seq")
    .all()
    .map((r) => ({ id: r.process_id as string, input: JSON.parse(r.input_json as string) as Input }));
}

export function effectRows(db: DatabaseSync): { id: string; n: number; status: string }[] {
  return db
    .prepare("SELECT process_id, n, status FROM effects ORDER BY process_id")
    .all()
    .map((r) => ({ id: r.process_id as string, n: r.n as number, status: r.status as string }));
}

/** 一个进程所有段的全部消息，按段和段内序号排序。`withoutCarried`：不要第二段起的第一条，它带着上一段末尾的用户消息的副本。 */
export function allMessages(db: DatabaseSync, id: string, withoutCarried = false): Message[] {
  return db
    .prepare(`SELECT message_json FROM segment_messages WHERE process_id = ? ${withoutCarried ? "AND NOT (segment_seq > 1 AND seq = 0)" : ""} ORDER BY segment_seq, seq`)
    .all(id)
    .map((r) => JSON.parse(r.message_json as string) as Message);
}

/** 从现在起，记下这个库上每条语句返回的行数和 SQL。 */
export function countReads(db: DatabaseSync): { rows: number; sql: string[] } {
  const seen = { rows: 0, sql: [] as string[] };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const st = prepare(sql);
    const [all, get] = [st.all.bind(st), st.get.bind(st)];
    seen.sql.push(sql);
    st.all = ((...args: SQLInputValue[]) => {
      const r = all(...args);
      seen.rows += r.length;
      return r;
    }) as typeof st.all;
    st.get = ((...args: SQLInputValue[]) => {
      const r = get(...args);
      if (r) seen.rows++;
      return r;
    }) as typeof st.get;
    return st;
  };
  return seen;
}

/** mulberry32：带种子的伪随机数，返回 [0, 1)。 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串的 FNV-1a 散列，用作种子。 */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
