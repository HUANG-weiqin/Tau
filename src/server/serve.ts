// 服务：把库、执行器和管道装配起来（见 .knowledge/kb-service.md）。只有一个同步的 pump 推进状态，所以没有并发。
import { randomBytes } from "node:crypto";
import type { Server, Socket } from "node:net";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../executor/actions.ts";
import { createExecutor } from "../executor/executor.ts";
import { finalReply } from "../kernel/derive.ts";
import { observe } from "../kernel/observe.ts";
import { unreachable, userLetter } from "../kernel/types.ts";
import type { Instant, Memory, Process, ProcessId } from "../kernel/types.ts";
import { checkImages, imageType } from "../images.ts";
import { loadPreset } from "../presets/load.ts";
import type { Reply, Request } from "../protocol.ts";
import { loadProcess, loadProcesses, loadSegment, openDb, readSegment } from "../store/db.ts";
import { readBlob } from "../store/blobs.ts";
import { forkProcess, handleNext, pruneSegments, removeProcess, send, startProcess, sweepBlobs } from "../store/inputs.ts";
import type { Handled } from "../store/inputs.ts";
import { listen } from "./listen.ts";

/** watch 订阅的写缓冲上限：推完快照以后，缓冲又多出这么多（按 writableLength 的单位，字符数），就断开订阅。 */
export const WATCH_BUFFER_MAX = 1024 * 1024;

/** watch 的订阅：不持久，断开就丢。process 缺省表示订阅全部进程。 */
interface Subscription {
  socket: Socket;
  process: ProcessId | undefined;
  /** 推完快照时的 writableLength 加上 WATCH_BUFFER_MAX。 */
  limit: number;
}

export interface ServeOptions {
  pipe: string;
  dbPath: string;
  presetsDir: string;
  toolsDir: string;
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
  /** watch 的订阅，和观察者表分开。 */
  const subscriptions = new Set<Subscription>();
  let closing = false;
  const exec = createExecutor(
    db,
    createActions(
      opts.models,
      (id, n, delta) => {
        const text: Reply = { type: "text", process: id, n, delta };
        watchers.get(id)?.forEach((s) => reply(s, text));
        push(id, text);
      },
      opts.pipe,
      (hash) => readBlob(db, hash),
    ),
  );

  const readPreset = (id: string) => loadPreset(opts.presetsDir, id, opts.models, opts.toolsDir);

  function pump(): void {
    for (;;) {
      const now = Date.now();
      const h = handleNext(db, memory, now, readPreset);
      if (!h) break;
      if (h.abort !== null) exec.abort(h.process.id, h.abort);
      if (subscriptions.size > 0) push(h.process.id, update(h, now));
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

  /** 给订阅这个进程的连接推一条回复。写缓冲超过上限的订阅就断开。 */
  function push(id: ProcessId, r: Reply): void {
    for (const sub of subscriptions) {
      if (sub.process !== undefined && sub.process !== id) continue;
      reply(sub.socket, r);
      if (sub.socket.writableLength > sub.limit) {
        subscriptions.delete(sub);
        sub.socket.destroy();
      }
    }
  }

  /** start、send 的连接：发回执、登记观察者，等最终回复。 */
  function awaitFinal(s: Socket, id: ProcessId): void {
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
        const images = checkImages(req.images ?? []);
        const preset = readPreset(req.preset);
        const id = randomBytes(4).toString("hex");
        startProcess(db, memory, id, preset, req.text, now, images);
        return awaitFinal(s, id);
      }
      case "send":
        send(db, req.process, userLetter(req.text), checkImages(req.images ?? []));
        return awaitFinal(s, req.process);
      case "stop":
        send(db, req.process, { kind: "stop" });
        reply(s, { type: "receipt", process: req.process }).end();
        return pump();
      case "fork": {
        const id = randomBytes(4).toString("hex");
        const preset = req.preset === undefined ? undefined : readPreset(req.preset);
        const h = forkProcess(db, memory, id, req.process, req.before, now, preset);
        if (subscriptions.size > 0) push(id, update(h, now));
        reply(s, { type: "receipt", process: id }).end();
        return;
      }
      case "ps": {
        const all = loadProcesses(db);
        reply(s, { type: "ps", processes: all.map((p) => observe(p, loadSegment(db, p), all, now)) }).end();
        return;
      }
      case "history": {
        const p = loadProcess(db, req.process);
        if (!p) throw new Error(`没有这个进程：${req.process}`);
        const segment = req.segment ?? p.segment.seq;
        if (segment < 1 || segment > p.segment.seq) throw new Error(`进程 ${p.id} 没有第 ${segment} 段，现在是第 ${p.segment.seq} 段。`);
        const { rows, count } = readSegment(db, p.id, segment, req.from ?? 0);
        if (count === 0 && segment < p.segment.seq) throw new Error(`进程 ${p.id} 的第 ${segment} 段已经被删掉。`);
        for (const r of rows) reply(s, { type: "message", segment, seq: r.seq, message: r.message });
        reply(s, { type: "end", segment, messages: count }).end();
        return;
      }
      case "prune":
        pruneSegments(db, req.process, req.before);
        reply(s, { type: "receipt", process: req.process }).end();
        return;
      case "remove": {
        if (exec.busy(req.process)) throw new Error(`进程 ${req.process} 在执行器里还有动作没收尾，稍后再删。`);
        removeProcess(db, req.process);
        const removed: Reply = { type: "removed", process: req.process };
        for (const sub of subscriptions) {
          if (sub.process !== undefined && sub.process !== req.process) continue;
          reply(sub.socket, removed);
          if (sub.process !== undefined) {
            subscriptions.delete(sub);
            sub.socket.end();
          }
        }
        reply(s, { type: "receipt", process: req.process }).end();
        return;
      }
      case "sweep":
        reply(s, { type: "swept", blobs: sweepBlobs(db) }).end();
        return;
      case "blob": {
        const data = readBlob(db, req.hash);
        const mimeType = data && imageType(data);
        if (!data || !mimeType) throw new Error(`没有这个 blob：${req.hash}`);
        reply(s, { type: "blob", mimeType, data: data.toString("base64") }).end();
        return;
      }
      case "watch": {
        if (closing) throw new Error("服务正在退出，不接受订阅。");
        const all = req.process === undefined ? loadProcesses(db) : [loadProcess(db, req.process)];
        for (const p of all) {
          if (!p) throw new Error(`没有这个进程：${req.process}`);
          reply(s, { type: "update", self: observe(p, loadSegment(db, p), [p], now).self });
        }
        if (s.destroyed) return;
        const sub: Subscription = { socket: s, process: req.process, limit: s.writableLength + WATCH_BUFFER_MAX };
        subscriptions.add(sub);
        s.on("close", () => subscriptions.delete(sub));
        // readline 关闭后会暂停读取。恢复读取并丢掉请求行之后的字节，客户端断开才会变成 'end' 和 'close'。
        s.resume();
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
      for (const sub of subscriptions) sub.socket.destroy();
      subscriptions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/** 处理完一条输入后，这个进程的 self 部分。只用 handleNext 返回的记录和段，不读库。 */
function update(h: Pick<Handled, "process" | "segment">, now: Instant): Reply {
  return { type: "update", self: observe(h.process, h.segment, [h.process], now).self };
}

function reply(s: Socket, r: Reply): Socket {
  if (!s.destroyed) s.write(`${JSON.stringify(r)}\n`);
  return s;
}

function parseRequest(line: string): Request {
  const r: unknown = JSON.parse(line);
  const str = (o: object, k: string): boolean => typeof (o as Record<string, unknown>)[k] === "string";
  if (typeof r === "object" && r !== null && "op" in r) {
    const num = (k: string): boolean => {
      const v = (r as Record<string, unknown>)[k];
      return v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
    };
    if (r.op === "ps") return { op: "ps" };
    if (r.op === "sweep") return { op: "sweep" };
    if (r.op === "remove" && str(r, "process")) return r as Request;
    if (r.op === "prune" && str(r, "process") && "before" in r && num("before")) return r as Request;
    if (r.op === "history" && str(r, "process") && num("segment") && num("from")) return r as Request;
    if (r.op === "watch" && (!("process" in r) || str(r, "process"))) return r as Request;
    if (r.op === "stop" && str(r, "process")) return r as Request;
    if (r.op === "fork" && str(r, "process") && num("before") && ((r as Record<string, unknown>).preset === undefined || str(r, "preset"))) return r as Request;
    const images = "images" in r ? r.images : [];
    const imagesOk = Array.isArray(images) && images.every((x) => typeof x === "string");
    if (r.op === "blob" && str(r, "hash")) return r as Request;
    if (r.op === "send" && str(r, "process") && str(r, "text") && imagesOk) return r as Request;
    if (r.op === "start" && str(r, "preset") && str(r, "text") && imagesOk) return r as Request;
  }
  throw new Error(`无法识别的请求：${line}`);
}
