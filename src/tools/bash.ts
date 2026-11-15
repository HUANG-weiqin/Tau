import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clip, TOOL_RESULT_MAX_BYTES } from "../kernel/derive.ts";
import type { ToolResultContent } from "../kernel/types.ts";

const DEFAULT_SECONDS = 120;
const MAX_SECONDS = 600;
// 输出过长时只留头尾各这么多字节，中段只计数。两段加上说明行仍在工具结果上限内。
const KEEP_BYTES = TOOL_RESULT_MAX_BYTES / 2 - 256;
// bash 退出后，它留下的后台进程（如 `sleep 100 &`）还占着输出管道，close 要等它们结束。所以 exit 后
// 只再读这么久就关管道返回。后台进程继续运行，不归本工具管；它再写输出会遇到管道已关（msys 程序因 SIGPIPE 退出）。
const DRAIN_MS = 200;
// 先把 bash 的 msys pid（也是它的进程组号）写进临时文件，再执行命令。命令经环境变量传入，
// 不拼进脚本，反斜杠原样保留；export -n 让子进程看不到这两个变量。
const WRAPPER = 'echo $$ > "$TAU_PGID"; export -n TAU_PGID TAU_COMMAND; eval "$TAU_COMMAND"';

const fail = (text: string): ToolResultContent => ({ text, isError: true });

let shell: string | null | undefined;

// Git for Windows 的 bin\bash.exe 会把 /mingw64/bin 和 /usr/bin 放进 PATH，所以 `-c` 就够用；`-l` 每次多花约 0.8 秒。
// git.exe 在 <根>\cmd、<根>\bin 或 <根>\mingw64\bin。不用 System32 或 WindowsApps 里的 bash.exe，那是 WSL。
function findShell(): string | null {
  if (shell !== undefined) return shell;
  const gitDirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "" && existsSync(path.join(d, "git.exe")));
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
    const room = Math.max(KEEP_BYTES - head.length, 0);
    head = Buffer.concat([head, chunk.subarray(0, room)]);
    tail = Buffer.concat([tail, chunk.subarray(room)]);
    dropped += Math.max(tail.length - KEEP_BYTES, 0);
    tail = tail.subarray(Math.max(tail.length - KEEP_BYTES, 0));
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

// 运行辅助程序，返回它的 stdout；出错也不抛出。
const capture = (file: string, args: string[]): Promise<string> =>
  new Promise((done) => execFile(file, args, { windowsHide: true }, (_e, stdout) => done(String(stdout))));

// 超时或中止时结束命令启动的进程，哪步失败都不管。只靠 taskkill /T 不够：bash fork 出的子进程再 exec
// msys 程序时（如 `sleep 30; true` 里的 sleep），中间的 Windows 进程会退出，父进程链断开；但它们还在 bash 的
// msys 进程组里。所以用 msys 的 ps 列出组员的 Windows pid，连同 bash 交给 taskkill /F /T；再查一遍，结束其间
// exec 出来的。不用 msys 的 kill -9：信号发给 exec 到一半的进程会卡 5 秒，其间别的组员照常运行。
// 仍会漏掉：用 setsid 离开进程组的进程；正好在结束那一刻创建的进程。几个调用同时被结束时 ps 偶尔也卡 5 秒。
async function killAll(exe: string, pid: number | undefined, pgidFile: string): Promise<void> {
  const pgid = (await readFile(pgidFile, "utf8").catch(() => "")).trim(); // 空：bash 还没开始执行命令
  const group = async (): Promise<string[]> => {
    if (!/^\d+$/.test(pgid)) return [];
    const ps = await capture(path.join(exe, "..", "..", "usr", "bin", "ps.exe"), ["-l"]); // PID PPID PGID WINPID…，行首可有状态字母
    return [...ps.matchAll(/^[^\d\n]*\d+\s+\d+\s+(\d+)\s+(\d+)/gm)].filter((m) => m[1] === pgid).map((m) => m[2] ?? "");
  };
  const killTrees = (pids: string[]) => pids.length > 0 && capture("taskkill", ["/F", "/T", ...pids.flatMap((p) => ["/PID", p])]);
  await killTrees([String(pid), ...(await group())]);
  await killTrees(await group());
}

export async function bash(args: { command: string; timeout?: number }, workdir: string, signal: AbortSignal): Promise<ToolResultContent> {
  const seconds = Math.min(args.timeout ?? DEFAULT_SECONDS, MAX_SECONDS);
  if (!(seconds > 0)) return fail(`timeout 必须是正数（秒）：${args.timeout}`);
  if (signal.aborted) return fail("已中止，命令没有运行");
  const exe = findShell();
  if (exe === null) return fail("需要 Git for Windows：PATH 上找不到 git.exe，也就找不到它的 bin\\bash.exe");
  const out = output();
  const pgidFile = path.join(os.tmpdir(), `tau-bash-${randomUUID()}.pgid`);
  return new Promise((resolve) => {
    const env = { ...process.env, TAU_PGID: pgidFile, TAU_COMMAND: args.command };
    const child = spawn(exe, ["-c", WRAPPER], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let code: number | null = null;
    // 正在结束进程时，它完成后给出结束的原因。
    let killing: Promise<string> | undefined;
    const kill = (why: string): void => void (killing ??= killAll(exe, child.pid, pgidFile).then(() => why));
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
      void rm(pgidFile, { force: true }).catch(() => {}).then(() => resolve(result));
    };
    const end = async (): Promise<void> => {
      const why = await killing;
      finish(why !== undefined ? fail(out.text(why)) : { text: out.text(`退出码 ${code ?? -1}`), isError: code !== 0 });
    };
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
