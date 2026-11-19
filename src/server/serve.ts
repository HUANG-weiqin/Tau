// 服务：把库、执行器和管道装配起来（见 .knowledge/kb-service.md）。只有一个同步的 pump 推进状态，所以没有并发。
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { Models } from "@earendil-works/pi-ai";
import { createActions } from "../executor/actions.ts";
import { createExecutor } from "../executor/executor.ts";
import { finalReply, limits, startError } from "../kernel/derive.ts";
import { observe } from "../kernel/observe.ts";
import { withCallParams } from "../kernel/snapshot.ts";
import { unreachable, userLetter } from "../kernel/types.ts";
import type { Instant, Memory, MemoryOp, Process, ProcessId } from "../kernel/types.ts";
import { checkImages, imageType } from "../images.ts";
import { checkPresetId, loadPreset, reconfigured } from "../presets/load.ts";
import type { Reply, Request } from "../protocol.ts";
import { countMessages, loadProcess, loadProcesses, loadSegment, openDb, readSegment } from "../store/db.ts";
import { readBlob } from "../store/blobs.ts";
import { forkProcess, handleNext, pruneSegments, removeProcess, send, startProcess, sweepBlobs, writeMemory } from "../store/inputs.ts";
import type { Handled } from "../store/inputs.ts";
import { listen } from "./listen.ts";

/** watch 订阅的写缓冲上限：推完快照以后，缓冲又多出这么多（按 writableLength 的单位，字符数），就断开订阅。 */
export const WATCH_BUFFER_MAX = 1024 * 1024;

/** watch 的订阅：不持久，断开就丢。process 缺省表示订阅全部进程。 */
interface Subscription {
  socket: Socket;
  process: ProcessId | undefined;
  /** `watch` 带 `messages: true`：每条 update 之后接着推追加的消息。 */
  messages: boolean;
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
      (id, n, delta, kind) => {
        // 带 kind 的（思考、工具调用）只推给带 messages 的订阅：start、send 的连接和普通订阅只收正文。
        const text: Reply = { type: "text", process: id, n, delta, ...(kind === undefined ? {} : { kind }) };
        if (kind === undefined) watchers.get(id)?.forEach((s) => reply(s, text));
        push(id, text, kind !== undefined);
      },
      opts.pipe,
      (hash) => readBlob(db, hash),
      (id, n, delta) => {
        // 命令边跑边写的输出（D88）：和带 kind 的模型预览一样，只推给带 messages 的订阅，不进库。
        push(id, { type: "text", process: id, n, delta, kind: "output" }, true);
      },
    ),
  );

  /** `workdir` 顶掉预设文件里的工作目录（`spawn`、`start`、`check` 用）。 */
  const readPreset = (id: string, workdir?: string) => loadPreset(opts.presetsDir, id, opts.models, opts.toolsDir, workdir);

  function pump(): void {
    for (;;) {
      const now = Date.now();
      const h = handleNext(db, memory, now, readPreset);
      if (!h) break;
      if (h.abort !== null) exec.abort(h.process.id, h.abort);
      if (subscriptions.size > 0) {
        push(h.process.id, update(h, now));
        h.appended.messages.forEach((message, i) => push(h.process.id, { type: "message", process: h.process.id, segment: h.process.segment.seq, seq: h.appended.from + i, message }, true));
      }
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

  /** 给订阅这个进程的连接推一条回复；`onlyMessages` 时只推给带 `messages: true` 的订阅。写缓冲超过上限的订阅就断开。 */
  function push(id: ProcessId, r: Reply, onlyMessages = false): void {
    for (const sub of subscriptions) {
      if ((sub.process !== undefined && sub.process !== id) || (onlyMessages && !sub.messages)) continue;
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
        const preset = readPreset(req.preset, req.workdir);
        const id = req.id ?? randomBytes(4).toString("hex");
        startProcess(db, memory, id, preset, req.text, now, images);
        return awaitFinal(s, id);
      }
      case "send":
        send(db, req.process, req.handoff === true ? withHandoff(userLetter(req.text)) : userLetter(req.text), checkImages(req.images ?? []), req.from === undefined ? undefined : { id: req.from, reply: req.reply === true });
        return awaitFinal(s, req.process);
      case "stop":
        send(db, req.process, { kind: "stop" });
        reply(s, { type: "receipt", process: req.process }).end();
        return pump();
      case "fork": {
        const id = req.id ?? randomBytes(4).toString("hex");
        const preset = req.preset === undefined ? undefined : readPreset(req.preset);
        const h = forkProcess(db, memory, id, req.process, req.before, now, preset);
        if (subscriptions.size > 0) push(id, update(h, now));
        reply(s, { type: "receipt", process: id }).end();
        return;
      }
      case "reconfigure": {
        // 同步做完（D71）：读记录、造新快照、过启动检查、放进信箱、处理，再读一次记录发回执。不用 awaitFinal：不开轮，没有最终回复可等；空闲的进程不会被唤醒。
        const record = loadProcess(db, req.process);
        if (!record) throw new Error(`没有这个进程：${req.process}`);
        const snapshot = req.fields === undefined ? record.preset : reconfigured(record.next ?? record.preset, req.fields, opts.models, opts.toolsDir);
        // 两份都要过启动检查：新快照 S，和立即生效的那份（当前快照带上 S 的调用参数；S 要等换段才生效时，它和 S 不同）。
        const tooBig = startError(snapshot);
        if (tooBig !== null) throw new Error(tooBig);
        const immediate = startError(withCallParams(record.preset, snapshot));
        if (immediate !== null) throw new Error(`当前配置带上新的调用参数就过不了启动检查：${immediate}`);
        send(db, req.process, { kind: "reconfigure", preset: snapshot });
        pump();
        reply(s, { type: "reconfigured", process: req.process, pending: loadProcess(db, req.process)?.next !== undefined }).end();
        return;
      }
      case "ps": {
        const all = loadProcesses(db);
        reply(s, { type: "ps", processes: all.map((p) => observe(p, loadSegment(db, p), all, now)) }).end();
        return;
      }
      case "inspect": {
        // 同步读完，中间没有别的输入被处理：记录和条数是同一刻的。
        const all = req.process === undefined ? loadProcesses(db) : [loadProcess(db, req.process)];
        for (const p of all) {
          if (!p) throw new Error(`没有这个进程：${req.process}`);
          reply(s, { type: "process", process: p, messages: countMessages(db, p.id, p.segment.seq), limits: limits(p.preset) });
        }
        reply(s, { type: "inspected", count: all.length, now }).end();
        return;
      }
      case "check": {
        const snapshot = readPreset(req.preset, req.workdir);
        reply(s, { type: "check", snapshot, limits: limits(snapshot), error: startError(snapshot) }).end();
        return;
      }
      case "memory": {
        reply(s, req.ns === undefined ? { type: "namespaces", ns: memory.namespaces() } : { type: "memory", ns: req.ns, entries: memory.entries(req.ns) }).end();
        return;
      }
      case "memory_write": {
        const r = writeMemory(db, memory, req.ops, now);
        reply(s, r.ok ? { type: "memory_written", versions: r.versions } : { type: "memory_rejected", index: r.index, result: r.result }).end();
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
      case "backup": {
        // 同步：期间服务不处理别的输入（D73 的代价）。不是输入，不开写事务，不调 pump。
        db.prepare("VACUUM INTO ?").run(req.path);
        reply(s, { type: "backed_up", path: req.path, bytes: statSync(req.path).size }).end();
        return;
      }
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
        const sub: Subscription = { socket: s, process: req.process, messages: req.messages === true, limit: s.writableLength + WATCH_BUFFER_MAX };
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

/** 一项记忆写入的形状：set 的 expected 是 null 或正整数，`brief` 可以没有、有就要是字符串；delete 的 expected 是正整数。 */
function memoryOp(x: unknown): x is MemoryOp {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  const version = typeof o.expected === "number" && Number.isSafeInteger(o.expected) && o.expected > 0;
  if (typeof o.ns !== "string" || typeof o.key !== "string") return false;
  if (o.kind === "set") return typeof o.value === "string" && (o.expected === null || version) && (o.brief === undefined || typeof o.brief === "string");
  return o.kind === "delete" && version;
}

/** 换段信：只有 true 才写 `handoff` 键。 */
function withHandoff(i: ReturnType<typeof userLetter>): ReturnType<typeof userLetter> {
  return { ...i, letter: { ...i.letter, handoff: true } };
}

/** 调用方定的进程 ID（D64 第 9 组）：ID 原样进信头和 `self` 的文字，上层还拿它拼路径，所以字符集收得很窄。没有就是合格。 */
const idOk = (v: unknown): boolean => v === undefined || (typeof v === "string" && /^[0-9a-z][0-9a-z_-]{0,31}$/.test(v));

const isString = (v: unknown): boolean => typeof v === "string";
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
/** `reconfigure` 的 `fields.tools` 最多几项（D71）：每个名字都要读一个工具定义文件，请求里的个数不能不设限。 */
export const TOOLS_FIELD_MAX = 128;
/** `reconfigure` 的 `fields` 里每个键的值的形状；值是否合格由读预设的同一套校验管（`presets/load.ts`）。 */
const FIELD_SHAPES: Record<string, (v: unknown) => boolean> = {
  model: isString,
  tools: isStrings,
  thinking: (v) => v === null || isString(v),
  handoff: (v) => v === null || typeof v === "number",
  options: (v) => v === null || (typeof v === "object" && !Array.isArray(v)),
  prompt: isString,
  workdir: isString,
  context: (v) => v === null || isStrings(v),
};

/** `reconfigure` 的请求（D71）：`fields` 和 `revert` 恰好给一个；`fields` 至少一个键，不许 `id`，不认识的键、类型不对都报错。 */
function checkReconfigure(r: Record<string, unknown>): Record<string, unknown> {
  const { fields, revert } = r;
  if ((fields === undefined) === (revert === undefined) || (revert !== undefined && revert !== true)) throw new Error("reconfigure 要带 fields 或者 revert: true，恰好一个");
  if (fields === undefined) return r;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || Object.keys(fields).length === 0) throw new Error("reconfigure 的 fields 必须是至少一个键的对象");
  for (const [key, v] of Object.entries(fields)) {
    if (key === "id") throw new Error("id 不能改：它是记忆库的 ID，换角色用 fork 带 preset");
    if (!Object.hasOwn(FIELD_SHAPES, key)) throw new Error(`reconfigure 的 fields 里没有这个键：${key}`);
    if (!FIELD_SHAPES[key]!(v)) throw new Error(`reconfigure 的 fields.${key} 类型不对`);
    if (key === "tools" && (v as string[]).length > TOOLS_FIELD_MAX) throw new Error(`reconfigure 的 fields.tools 最多 ${TOOLS_FIELD_MAX} 项：现在有 ${(v as string[]).length} 项`);
  }
  return r;
}

/**
 * backup 的目标路径（D73）：1 到 1024 个字符，无控制字符，Windows 绝对路径（盘符或 UNC，和预设的 workdir 一样；`/e/x` 不认）。
 * 空串、`:memory:`、`file:` 开头的都不是这种路径：SQLite 对它们另有解释，所以一律拒绝。
 * 以空格或点结尾的也拒绝（Windows 会悄悄去掉它们，文件名对不上）；盘符之后不许再有冒号（NTFS 的备用数据流）。
 */
function checkBackupPath(p: string): void {
  if (p.length < 1 || p.length > 1024) throw new Error(`备份路径要 1 到 1024 个字符：现在是 ${p.length} 个`);
  if (/\p{Cc}/u.test(p)) throw new Error("备份路径不能含控制字符");
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^[\\/]{2}[^\\/]/.test(p)) throw new Error(`备份路径必须是 Windows 绝对路径（盘符或 UNC）：${p}`);
  if (/[ .]$/.test(p)) throw new Error(`备份路径不能以空格或点结尾：${p}`);
  if (p.indexOf(":", 2) >= 0) throw new Error(`备份路径里盘符之后不能再有冒号（备用数据流）：${p}`);
}

function parseRequest(line: string): Request {
  const r: unknown = JSON.parse(line);
  const str = (o: object, k: string): boolean => typeof (o as Record<string, unknown>)[k] === "string";
  if (typeof r === "object" && r !== null && "op" in r) {
    const num = (k: string): boolean => {
      const v = (r as Record<string, unknown>)[k];
      return v === undefined || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
    };
    if (r.op === "memory" && (!("ns" in r) || str(r, "ns"))) {
      if ("ns" in r) checkPresetId((r as { ns: string }).ns);
      return r as Request;
    }
    if (r.op === "memory_write" && "ops" in r && Array.isArray(r.ops) && r.ops.length > 0 && r.ops.every(memoryOp)) {
      for (const op of r.ops as MemoryOp[]) checkPresetId(op.ns);
      return r as Request;
    }
    if (r.op === "ps") return { op: "ps" };
    if (r.op === "sweep") return { op: "sweep" };
    if (r.op === "backup" && "path" in r && str(r, "path")) {
      const path = (r as { path: string }).path;
      checkBackupPath(path);
      return { op: "backup", path };
    }
    if (r.op === "inspect" && (!("process" in r) || str(r, "process"))) return r as Request;
    if (r.op === "check" && str(r, "preset") && (!("workdir" in r) || str(r, "workdir"))) return r as Request;
    if (r.op === "remove" && str(r, "process")) return r as Request;
    if (r.op === "prune" && str(r, "process") && "before" in r && num("before")) return r as Request;
    if (r.op === "history" && str(r, "process") && num("segment") && num("from")) return r as Request;
    if (r.op === "watch" && (!("process" in r) || str(r, "process")) && ((r as Record<string, unknown>).messages === undefined || typeof (r as Record<string, unknown>).messages === "boolean")) return r as Request;
    if (r.op === "stop" && str(r, "process")) return r as Request;
    if (r.op === "reconfigure" && str(r, "process")) return checkReconfigure(r as Record<string, unknown>) as Request;
    if (r.op === "fork" && str(r, "process") && num("before") && ((r as Record<string, unknown>).preset === undefined || str(r, "preset")) && idOk((r as Record<string, unknown>).id)) return r as Request;
    const images = "images" in r ? r.images : [];
    const imagesOk = Array.isArray(images) && images.every((x) => typeof x === "string");
    if (r.op === "blob" && str(r, "hash")) return r as Request;
    const handoff = (r as Record<string, unknown>).handoff;
    const { from, reply, id } = r as Record<string, unknown>;
    if (r.op === "send" && str(r, "process") && str(r, "text") && imagesOk && (handoff === undefined || typeof handoff === "boolean") && (from === undefined || typeof from === "string") && (reply === undefined || (typeof reply === "boolean" && (reply === false || from !== undefined)))) return r as Request;
    if (r.op === "start" && str(r, "preset") && str(r, "text") && imagesOk && idOk(id) && (!("workdir" in r) || str(r, "workdir"))) return r as Request;
  }
  throw new Error(`无法识别的请求：${line}`);
}
