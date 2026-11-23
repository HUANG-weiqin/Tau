// 按配置起一个 MCP stdio 服务器、做完初始化；关掉它并结束整棵进程树。relay 和 gen 共用。
// 关的顺序是重点：先按进程树结束、等 taskkill 真的退出，再 client.close()。父进程先没了，taskkill /T 就找不到它的子孙。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadServer } from "./config.ts";
import type { ServerConfig } from "./config.ts";

/** 等 taskkill 退出的上限。机器忙时它要好几秒；放弃以后 client.close() 先结束服务器，还在跑的 taskkill 就找不到子孙。 */
const KILL_MS = 60_000;
/** 关连接时最多等这么久。 */
const CLOSE_MS = 3_000;
/** 留服务器 stderr 的尾巴：起不来时真正的原因在那里（例如 python 的 ModuleNotFoundError）。 */
const STDERR_TAIL = 4 * 1024;

export interface RunningServer {
  config: ServerConfig;
  client: Client;
  /** 服务器进程的 PID，起来时记下：关掉以后 `transport.pid` 读不到。 */
  pid: number | null;
  /** 初始化时服务器给的说明，可能没有。 */
  instructions: string | undefined;
  /** 服务器 stderr 的最后几 KB（看漏掉的 stderr 在这儿）。 */
  stderrTail(): string;
  /** 服务器自己退出了（管道断了也算）。 */
  dead(): boolean;
  /** 结束整棵进程树再关连接。已经自己退出的不碰 PID：那可能已经属于别人。 */
  close(): Promise<void>;
}

/** 起 taskkill。测试换成故意很慢的替身。 */
export type Kill = (pid: number) => ChildProcess;
const taskkill: Kill = (pid) => spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });

/** 结束一整棵进程树。要等 taskkill 真的退出才返回：父进程先没了，taskkill /T 就找不到子孙。
 *  等不到 KILL_MS 就放弃并记一行日志。认不出来的不管。 */
export function killTree(pid: number | null, kill: Kill = taskkill, onLog?: (line: string) => void): Promise<void> {
  if (pid === null) return Promise.resolve();
  return new Promise((resolve) => {
    const child = kill(pid);
    const timer = setTimeout(() => {
      onLog?.(`taskkill /T ${pid} ${KILL_MS / 1000} 秒还没退出，不等了`);
      resolve();
    }, KILL_MS);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", done);
    child.on("close", done);
  });
}

/**
 * 起一个服务器，并做完 MCP 初始化。
 * `cwd` 用配置里的（相对工作目录），没有就是工作目录；环境是 relay 自己的环境加配置里的 `env`。
 * 失败时把起来一半的进程树一起收掉，抛出的消息给模型和界面看。
 */
export interface StartOptions {
  /** 服务器的 stderr 往哪写（relay 写日志）。 */
  onStderr?: (text: string) => void;
  /** 起服务器加初始化的时限（毫秒）。0 或不给就是不限，只受 SDK 的 60 秒请求超时管。 */
  timeoutMs?: number;
  /** 起 taskkill 的办法，测试用。 */
  kill?: Kill;
  /** relay 自己的日志行（收进程树等太久之类）。 */
  onLog?: (line: string) => void;
}

export async function startServer(workdir: string, server: string, opts: StartOptions = {}): Promise<RunningServer> {
  const config = loadServer(workdir, server);
  // relay 自己的环境加上配置里的 env。
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...env, ...config.env },
    cwd: config.cwd === undefined ? path.resolve(workdir) : path.resolve(workdir, config.cwd),
    stderr: "pipe",
  });
  // 服务器的 stderr 一定要有人读：SDK 给的是一个 PassThrough，没人读满了以后服务器写 stderr 就卡住。
  // 所以这里一直读，留最后几 KB；起不来时把这段接进错误。另外交给调用方（relay 写日志）。
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    tail = (tail + text).slice(-STDERR_TAIL);
    opts.onStderr?.(text.trimEnd());
  });
  const tailText = (): string => {
    const t = tail.trim();
    return t === "" ? "" : `\n服务器的 stderr：\n${t}`;
  };
  const client = new Client({ name: "tau-mcp-relay", version: "1" }, { capabilities: {} });
  let dead = false;
  // connect 在第一个 await 之前就把服务器 spawn 了，所以这里同步拿得到 PID。
  // 连接失败以后 transport 会把它自己关掉，那时 transport.pid 是 null：PID 要现在记下。
  const connected = client.connect(transport); // 里面做完初始化；服务器不答时 60 秒超时
  const pid = transport.pid;
  try {
    const limit = opts.timeoutMs ?? 0;
    if (limit > 0) {
      // 起不来卡住也算超时：超时也要把起来一半的进程树收掉。
      await Promise.race([connected, sleep(limit).then(() => Promise.reject(new Error(`${limit} 毫秒内没起来`)))]);
    } else {
      await connected;
    }
  } catch (e) {
    // 起来一半的服务器还活着：这时按进程树结束，才连它起的子进程一起收掉。
    await killTree(pid, opts.kill, opts.onLog);
    throw new Error(`起不来 MCP 服务器 ${server}（${config.command}）：${e instanceof Error ? e.message : String(e)}${tailText()}`);
  }
  client.onclose = () => {
    dead = true;
  };
  return {
    config,
    client,
    pid,
    instructions: client.getInstructions(),
    stderrTail: () => tail.trim(),
    dead: () => dead,
    close: async () => {
      if (!dead) await killTree(pid, opts.kill, opts.onLog);
      dead = true;
      await Promise.race([client.close().catch(() => {}), sleep(CLOSE_MS)]);
    },
  };
}
