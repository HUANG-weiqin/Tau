// 服务：把库、执行器和管道装配起来（见 .knowledge/kb-service.md）。只有一个同步的 pump 推进状态，所以没有并发。
import { randomBytes } from "node:crypto";
import type { Server, Socket } from "node:net";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../executor/actions.ts";
import { createExecutor } from "../executor/executor.ts";
import { observe } from "../kernel/observe.ts";
import { unreachable } from "../kernel/types.ts";
import type { Memory, Message, Process, ProcessId } from "../kernel/types.ts";
import { loadPreset } from "../presets/load.ts";
import type { Reply, Request } from "../protocol.ts";
import { loadProcesses, loadSegment, openDb } from "../store/db.ts";
import { handleNext, send, startProcess } from "../store/inputs.ts";
import { listen } from "./listen.ts";

export interface ServeOptions {
  pipe: string;
  dbPath: string;
  presetsDir: string;
  models: Models;
  memory: (db: DatabaseSync) => Memory;
}

export interface Service {
  server: Server;
  db: DatabaseSync;
  close(): Promise<void>;
}

export async function serve(opts: ServeOptions): Promise<Service> {
  // 先拿到管道，才算持锁；之后才碰库。
  const server = await listen(opts.pipe, (s) => void onConnection(s));
  const db = openDb(opts.dbPath);
  const memory = opts.memory(db);
  /** 观察者：等某个进程回到 idle 的连接。不持久，断开就丢。 */
  const watchers = new Map<ProcessId, Set<Socket>>();
  let closing = false;
  const exec = createExecutor(
    db,
    createActions(opts.models, (id, delta) => watchers.get(id)?.forEach((s) => reply(s, { type: "text", delta }))),
  );

  function pump(): void {
    for (let h = handleNext(db, memory, Date.now()); h; h = handleNext(db, memory, Date.now())) {
      if (h.abort !== null) exec.abort(h.process.id, h.abort);
      settle(h.process);
    }
    for (let run = exec.startNext(); run; run = exec.startNext()) run.then(pump, fatal);
  }

  function fatal(e: unknown): void {
    if (closing) return;
    console.error("tau 服务遇到无法继续的错误，退出。重启时会恢复。", e);
    process.exit(1);
  }

  /** 进程回到 idle、信箱里也没有它的输入时，给等它的连接发最终回复。 */
  function settle(p: Process): void {
    const set = watchers.get(p.id);
    if (!set || p.phase.tag !== "idle" || db.prepare("SELECT 1 FROM mailbox WHERE process_id = ? LIMIT 1").get(p.id)) return;
    const final: Reply = { type: "final", reply: finalReply(loadSegment(db, p)), ended: p.phase.ended ?? null };
    watchers.delete(p.id);
    for (const s of set) reply(s, final).end();
  }

  function watch(s: Socket, id: ProcessId): void {
    reply(s, { type: "receipt", process: id });
    const set = watchers.get(id) ?? new Set();
    watchers.set(id, set);
    set.add(s);
    s.on("close", () => set.delete(s));
    pump();
  }

  function handle(s: Socket, req: Request): void {
    const now = Date.now();
    switch (req.op) {
      case "start": {
        const preset = loadPreset(opts.presetsDir, req.preset, opts.models);
        const id = randomBytes(4).toString("hex");
        startProcess(db, memory, id, preset, req.text, now);
        return watch(s, id);
      }
      case "send":
        send(db, req.process, { kind: "userMessage", text: req.text });
        return watch(s, req.process);
      case "stop":
        send(db, req.process, { kind: "stop" });
        reply(s, { type: "receipt", process: req.process }).end();
        return pump();
      case "ps": {
        const all = loadProcesses(db);
        reply(s, { type: "ps", processes: all.map((p) => observe(p, loadSegment(db, p), all, now)) }).end();
        return;
      }
      default:
        return unreachable(req);
    }
  }

  async function onConnection(s: Socket): Promise<void> {
    s.on("error", () => {});
    const lines = createInterface({ input: s, crlfDelay: Infinity });
    for await (const line of lines) {
      lines.close();
      try {
        handle(s, parseRequest(line));
      } catch (e) {
        reply(s, { type: "error", message: e instanceof Error ? e.message : String(e) }).end();
      }
      return;
    }
  }

  pump();
  return {
    server,
    db,
    async close() {
      closing = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

function reply(s: Socket, r: Reply): Socket {
  if (!s.destroyed) s.write(`${JSON.stringify(r)}\n`);
  return s;
}

/** 最终回复：从段尾往前，遇到用户消息之前的最后一条助手消息的正文。 */
function finalReply(segment: readonly Message[]): string {
  for (let i = segment.length - 1; i >= 0; i--) {
    const m = segment[i]!;
    if (m.role === "user") return "";
    if (m.role === "assistant") return m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  }
  return "";
}

function parseRequest(line: string): Request {
  const r: unknown = JSON.parse(line);
  const str = (o: object, k: string): boolean => typeof (o as Record<string, unknown>)[k] === "string";
  if (typeof r === "object" && r !== null && "op" in r) {
    if (r.op === "ps") return { op: "ps" };
    if (r.op === "stop" && str(r, "process")) return r as Request;
    if (r.op === "send" && str(r, "process") && str(r, "text")) return r as Request;
    if (r.op === "start" && str(r, "preset") && str(r, "text")) return r as Request;
  }
  throw new Error(`无法识别的请求：${line}`);
}
