// MCP 中转进程：在命名管道上听请求，为每个 (进程, 工作目录, 服务器) 持有一个 MCP stdio 服务器实例。
// 它由 call.ts 拉起、脱离调用者的进程树、常驻；实例空闲就回收，自己也没用了就退出（kb-extras 的“MCP 中转”）。
// 日志自己写进 relay.log：`start` 起来的进程没有可用的标准输出，往 stdout 写会丢或者出错。
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import path from "node:path";
import { startServer } from "./server.ts";
import type { RunningServer } from "./server.ts";

/** 默认管道名。测试用 `TAU_MCP_PIPE` 换成临时管道。 */
const DEFAULT_PIPE = "\\\\.\\pipe\\tau-mcp";

const ms = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

const PIPE = process.env["TAU_MCP_PIPE"] || DEFAULT_PIPE;
/** 一个实例空闲这么久就关掉它的服务器。 */
const IDLE_MS = ms(process.env["TAU_MCP_IDLE_MS"], 30 * 60_000);
/** 一个实例都没有、且这么久没有请求，relay 自己退出。 */
const EXIT_MS = ms(process.env["TAU_MCP_EXIT_MS"], 10 * 60_000);
/** MCP 请求的时间上限。真正的上限是工具定义的 `timeout` 和内核结束进程树：
 *  SDK 默认 60 秒，一个慢调用会被它判超时，队列跟着放行，状态和模型以为的对不上。 */
const REQUEST = { timeout: 600_000, resetTimeoutOnProgress: true };

interface Instance {
  key: string;
  process: string;
  workdir: string;
  server: string;
  running: RunningServer;
  /** 正在跑的请求数。大于 0 时不回收。 */
  busy: number;
  /** 上次用到的时刻，用来算空闲。 */
  last: number;
  /** 我们自己正在关它。 */
  closing: boolean;
}

const instances = new Map<string, Instance>();
/** 每个键一条队：同一个键的请求串行，不同键互不等待。 */
const queues = new Map<string, Promise<unknown>>();
/** 曾经起来过的键。用来判断这次是重起还是第一次。 */
const everAlive = new Set<string>();
/** 最近一次有事发生（请求或实例关掉）的时刻，用来算自己该不该退出。 */
let lastActive = Date.now();
/** 在途的 call/list 请求数。不是 0 时不退出：起服务器的那几秒里实例表还是空的。 */
let inflight = 0;

/** 日志文件：`~/.tau/extras/mcp/relay.log`（测试时家目录在临时目录）。 */
const LOG_FILE = path.join(homedir(), ".tau", "extras", "mcp", "relay.log");
let logFd: number | null = null;

/** 写一行日志。写不进就算了：日志不能影响正事。 */
function log(line: string): void {
  try {
    if (logFd === null) {
      mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      logFd = openSync(LOG_FILE, "a");
    }
    writeSync(logFd, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 写不进日志也不管。
  }
}

const keyOf = (proc: string, workdir: string, server: string): string => `${proc}\n${path.resolve(workdir).toLowerCase()}\n${server}`;

/** 队列：`fn` 不看上一个的结果，只管按顺序跑。跑空了就把这个键的表项删掉。 */
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

async function create(key: string, proc: string, workdir: string, server: string): Promise<Instance> {
  const running = await startServer(workdir, server, { onStderr: (text) => log(`[${server} stderr] ${text}`), onLog: log });
  everAlive.add(key);
  log(`起了服务器 ${server}（进程 ${proc}，PID ${running.pid}）：${running.config.command} ${running.config.args.join(" ")}`);
  return { key, process: proc, workdir, server, running, busy: 0, last: Date.now(), closing: false };
}

/** 拿这个键的实例：活着就用，死了或没有就（重）起。 */
async function acquire(key: string, proc: string, workdir: string, server: string): Promise<{ inst: Instance; restarted: boolean }> {
  const old = instances.get(key);
  if (old !== undefined && !old.running.dead()) return { inst: old, restarted: false };
  if (old !== undefined) await closeInstance(old);
  const restarted = everAlive.has(key);
  const inst = await create(key, proc, workdir, server);
  instances.set(key, inst);
  return { inst, restarted };
}

/** 正在关的实例。实例一开始关就离开了实例表，退出检查和 shutdown 要看这里，等它们关完才能退。 */
const closings = new Set<Promise<void>>();

function closeInstance(inst: Instance): Promise<void> {
  if (inst.closing) return Promise.resolve();
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  inst.closing = true;
  lastActive = Date.now();
  const pid = inst.running.pid;
  // 里面先按进程树结束、再关连接；已经自己退出的不碰 PID。
  const done = inst.running.close().then(() => {
    // 空闲时间从关完算起：关要几秒，刚关完就退出，会撞上这时刚到的请求。
    lastActive = Date.now();
    log(`关了服务器 ${inst.server}（进程 ${inst.process}，PID ${pid}）`);
  });
  closings.add(done);
  void done.finally(() => closings.delete(done));
  return done;
}

/** 同一个键的请求排在同一条队里；`fn` 跑的时候实例算在用，回收要让开。 */
function withInstance<T>(proc: string, workdir: string, server: string, fn: (inst: Instance, restarted: boolean) => Promise<T>): Promise<T> {
  const key = keyOf(proc, workdir, server);
  return serialize(key, async () => {
    const { inst, restarted } = await acquire(key, proc, workdir, server);
    inst.busy++;
    try {
      return await fn(inst, restarted);
    } finally {
      inst.busy--;
      inst.last = Date.now();
      lastActive = Date.now();
    }
  });
}

interface Request {
  op?: unknown;
  process?: unknown;
  workdir?: unknown;
  server?: unknown;
  tool?: unknown;
  arguments?: unknown;
}

type Reply = Record<string, unknown>;

const needString = (req: Request, field: "process" | "workdir" | "server" | "tool"): string => {
  const v = req[field];
  if (typeof v !== "string" || v === "") throw new Error(`请求缺少 ${field}（字符串）。`);
  return v;
};

async function handleCall(req: Request): Promise<Reply> {
  const proc = needString(req, "process");
  const workdir = needString(req, "workdir");
  const server = needString(req, "server");
  const tool = needString(req, "tool");
  const args = req.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("arguments 必须是对象。");
  return withInstance(proc, workdir, server, async (inst, restarted) => {
    let result;
    try {
      result = await inst.running.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, REQUEST);
    } catch (e) {
      const why = `服务器 ${server} 的工具 ${tool} 调用失败：${e instanceof Error ? e.message : String(e)}`;
      const tail = inst.running.stderrTail();
      throw new Error(tail === "" ? why : `${why}\n服务器的 stderr：\n${tail}`);
    }
    const reply: Reply = { ok: true, content: result.content };
    if (result.isError === true) reply["isError"] = true;
    if (restarted) reply["restarted"] = true;
    return reply;
  });
}

async function handleList(req: Request): Promise<Reply> {
  const proc = needString(req, "process");
  const workdir = needString(req, "workdir");
  const server = needString(req, "server");
  return withInstance(proc, workdir, server, async (inst, restarted) => {
    const tools: { name: string; description: string; inputSchema: unknown }[] = [];
    let cursor: string | undefined;
    do {
      const page = await inst.running.client.listTools(cursor === undefined ? {} : { cursor }, REQUEST);
      for (const t of page.tools) tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor !== "");
    const reply: Reply = { ok: true, tools };
    if (restarted) reply["restarted"] = true;
    return reply;
  });
}

function status(): Reply {
  const now = Date.now();
  return {
    ok: true,
    pid: process.pid,
    instances: [...instances.values()].map((i) => ({
      process: i.process,
      workdir: i.workdir,
      server: i.server,
      pid: i.running.pid,
      busy: i.busy,
      dead: i.running.dead(),
      idleMs: now - i.last,
    })),
  };
}

async function handle(raw: unknown): Promise<Reply> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "请求必须是 JSON 对象。" };
  const req = raw as Request;
  // call 和 list 算“在用”：进来就加一、更新时刻，走了再减一。起服务器要几秒，这期间实例表是空的。
  const working = req.op === "call" || req.op === "list";
  if (working) {
    inflight++;
    lastActive = Date.now();
  }
  try {
    switch (req.op) {
      case "status":
        // 看状态不算用它：不重置任何空闲计时。界面可能一直开着，relay 该退的时候还是要退。
        return status();
      case "list":
        return await handleList(req);
      case "call":
        return await handleCall(req);
      default:
        return { ok: false, error: `不认识的 op：${JSON.stringify(req.op)}。` };
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`请求失败（${String(req.op)}）：${error}`);
    return { ok: false, error };
  } finally {
    if (working) inflight--;
    if (req.op !== "status") lastActive = Date.now();
  }
}

function onSocket(socket: Socket): void {
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      void (async () => {
        let reply: Reply;
        try {
          reply = await handle(JSON.parse(line));
        } catch {
          reply = { ok: false, error: "请求不是合法的 JSON。" };
        }
        if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
      })();
    }
  });
}

/** 退出前关掉所有服务器；关不干净也要走。 */
async function shutdown(code: number): Promise<never> {
  for (const i of [...instances.values()]) void closeInstance(i);
  await Promise.all([...closings]);
  server.close();
  log("退出");
  process.exit(code);
}

const server: Server = createServer(onSocket);

server.on("error", (e) => {
  // 管道已被别的 relay 占着（或别的错）：直接退出，让调用方连占住的那个。
  log(`监听 ${PIPE} 失败，退出：${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`);
  process.exit(1);
});

server.listen(PIPE, () => {
  log(`在 ${PIPE} 上监听，PID ${process.pid}`);
  // 回收：实例空闲就关；一个实例都没有、又闲了很久，自己退出。
  const timer = setInterval(() => {
    const now = Date.now();
    for (const inst of [...instances.values()]) {
      if (inst.busy > 0 || now - inst.last <= IDLE_MS) continue;
      void closeInstance(inst);
    }
    if (instances.size === 0 && closings.size === 0 && inflight === 0 && now - lastActive > EXIT_MS) void shutdown(0);
  }, Math.max(20, Math.min(IDLE_MS, EXIT_MS) / 4));
  timer.unref();
});

process.on("uncaughtException", (e) => {
  log(`崩溃：${e.stack ?? e.message}`);
  if (logFd !== null) closeSync(logFd);
  process.exit(1);
});
