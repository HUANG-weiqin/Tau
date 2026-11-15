import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { clip, TOOL_RESULT_MAX_BYTES } from "../kernel/derive.ts";
import type { ToolResultContent } from "../kernel/types.ts";

const DEFAULT_SECONDS = 120;
const MAX_SECONDS = 600;
// 输出过长时只留头尾各这么多字节，中段只计数。两段加上说明行仍在工具结果上限内。
const KEEP_BYTES = TOOL_RESULT_MAX_BYTES / 2 - 256;
// bash 退出后，它留下的后台进程（如 `sleep 100 &`）还占着输出管道，close 事件要等它们结束。
// 所以 exit 后只再读这么久，然后关掉管道返回。后台进程继续运行，本工具不再管它；
// 它之后再写输出会遇到管道已关（msys 程序收到 SIGPIPE 退出）。
const DRAIN_MS = 200;

const fail = (text: string): ToolResultContent => ({ text, isError: true });

let shell: string | null | undefined;

// Git for Windows 的 bin\bash.exe 会把 /mingw64/bin 和 /usr/bin 放进 PATH，所以 `-c` 就够用；
// `-l` 要读 profile，每次多花约 0.8 秒。不用 System32 或 WindowsApps 里的 bash.exe，那是 WSL。
function findShell(): string | null {
  if (shell !== undefined) return shell;
  const gitDirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && existsSync(path.join(d, "git.exe")));
  // git.exe 在 <根>\cmd、<根>\bin 或 <根>\mingw64\bin。
  const roots = gitDirs.flatMap((d) => [d, path.dirname(d), path.dirname(path.dirname(d))]);
  shell = roots.map((root) => path.join(root, "bin", "bash.exe")).find((p) => existsSync(p)) ?? null;
  return shell;
}

// stdout 和 stderr 按到达顺序进同一份输出。内存里最多留头尾各 KEEP_BYTES。
function output() {
  let head: Buffer = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let dropped = 0;
  const push = (chunk: Buffer): void => {
    const room = KEEP_BYTES - head.length;
    if (room > 0) head = Buffer.concat([head, chunk.subarray(0, room)]);
    tail = Buffer.concat([tail, chunk.subarray(Math.max(room, 0))]);
    if (tail.length > KEEP_BYTES) {
      dropped += tail.length - KEEP_BYTES;
      tail = tail.subarray(tail.length - KEEP_BYTES);
    }
  };
  const text = (status: string): string => {
    const body =
      dropped === 0
        ? Buffer.concat([head, tail]).toString("utf8")
        : `${head.toString("utf8")}\n…（中间省略 ${dropped} 字节）…\n${tail.toString("utf8")}`;
    return clip(`${body}${body === "" || body.endsWith("\n") ? "" : "\n"}[${status}]`);
  };
  return { push, text };
}

// 超时或中止时用 taskkill /T /F 结束整棵 Windows 进程树。
// 已知漏洞：bash fork 出的子进程再 exec 一个 msys 程序时（如 `sleep 30; true` 里的 sleep），
// 中间那个 Windows 进程会退出，父进程链断开，taskkill 找不到它和它的子孙。
export async function bash(args: { command: string; timeout?: number }, workdir: string, signal: AbortSignal): Promise<ToolResultContent> {
  const seconds = Math.min(args.timeout ?? DEFAULT_SECONDS, MAX_SECONDS);
  if (!(seconds > 0)) return fail(`timeout 必须是正数（秒）：${args.timeout}`);
  if (signal.aborted) return fail("已中止，命令没有运行");
  const exe = findShell();
  if (exe === null) return fail("需要 Git for Windows：PATH 上找不到 git.exe，也就找不到它的 bin\\bash.exe");
  const out = output();
  return new Promise((resolve) => {
    const child = spawn(exe, ["-c", args.command], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let killed: string | undefined;
    let code: number | null = null;
    const kill = (why: string): void => {
      killed = why;
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    };
    const onAbort = (): void => kill("已中止，已结束整棵进程树");
    const timer = setTimeout(() => kill(`超时：${seconds} 秒后结束了整棵进程树`), seconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
    const stopWatching = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    // 会被调用多次（error、close、排空计时器）；resolve 只认第一次，其余步骤重复执行无害。
    const finish = (result: ToolResultContent): void => {
      stopWatching();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    const end = (): void =>
      finish(killed !== undefined ? fail(out.text(killed)) : { text: out.text(`退出码 ${code ?? -1}`), isError: code !== 0 });
    child.stdout.on("data", out.push);
    child.stderr.on("data", out.push);
    child.on("error", (e) => finish(fail(`无法启动 bash（工作目录 ${workdir}）：${e.message}`)));
    child.on("exit", (c) => {
      code = c;
      stopWatching();
      setTimeout(end, DRAIN_MS).unref();
    });
    child.on("close", end);
  });
}
