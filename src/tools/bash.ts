import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmdirSync, rmSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clip, MESSAGE_MAX_BYTES } from "../kernel/derive.ts";
import { textContent } from "../kernel/types.ts";
import type { ToolResultContent } from "../kernel/types.ts";

const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 600;
// 输出过长时只留头尾各这么多字节，中段只计数。两段加上说明行仍在工具结果上限内。
const KEEP_BYTES = MESSAGE_MAX_BYTES / 2 - 256;
// bash 退出后，它留下的后台进程（如 `sleep 100 &`）还占着输出管道，close 要等它们结束。所以 exit 后
// 只再读这么久就关管道返回。后台进程继续运行，不归本工具管；它再写输出会遇到管道已关（msys 程序因 SIGPIPE 退出）。
const DRAIN_MS = 200;
// 先把 bash 的 msys pid（也是它的进程组号）写进临时文件，再执行命令；写不进就不执行。命令经环境变量传入，
// 不拼进脚本，反斜杠原样保留；export -n 让子进程看不到这两个变量。
const WRAPPER = 'echo $$ > "$TAU_PGID" || exit; export -n TAU_PGID TAU_COMMAND; eval "$TAU_COMMAND"';

const fail = (text: string): ToolResultContent => ({ content: textContent(text), isError: true });

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

const lineEnd = (body: string): string => (body === "" || body.endsWith("\n") ? "" : "\n");

/** 头尾两段之间省略了 `dropped` 字节时的输出：没省略就是头接尾，省略了中段只留一行说明。 */
const elide = (head: Buffer, tail: Buffer, dropped: number): string =>
  dropped === 0 ? Buffer.concat([head, tail]).toString("utf8") : `${head.toString("utf8")}\n…（中间省略 ${dropped} 字节）…\n${tail.toString("utf8")}`;

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
  const raw = (): { text: string; truncated: boolean } => ({ text: Buffer.concat([head, tail]).toString("utf8"), truncated: dropped > 0 });
  const text = (status: string): string => {
    const body = elide(head, tail, dropped);
    return clip(`${body}${lineEnd(body)}[${status}]`);
  };
  return { push, text, raw };
}

// 运行辅助程序，返回它的 stdout；出错也不抛出。
const capture = (file: string, args: string[]): Promise<string> =>
  new Promise((done) => execFile(file, args, { windowsHide: true }, (_e, stdout) => done(String(stdout))));

// 超时或中止时结束命令启动的进程，哪步失败都不管。只靠 taskkill /T 不够：bash fork 出的子进程再 exec
// msys 程序时（如 `sleep 30; true` 里的 sleep），中间的 Windows 进程会退出，父进程链断开；但它们还在 bash 的
// msys 进程组里。所以先用 taskkill /F /T 结束 bash 的进程树，再读 pgid 文件：bash 已经没了，读到的不会再变。
// 先读再结束不行：bash 可能在这之间写下 pgid、启动命令，组员就没人找了。然后用 msys 的 ps 列出组员的
// Windows pid 交给 taskkill /F /T；再查一遍，结束其间 exec 出来的。不用 msys 的 kill -9：信号发给 exec 到一半的
// 进程会卡 5 秒，其间别的组员照常运行。仍会漏掉的进程见 kb-tools 的“结束进程”。
async function killAll(exe: string, pid: number | undefined, pgidFile: string): Promise<void> {
  const killTrees = (pids: string[]) => pids.length > 0 && capture("taskkill", ["/F", "/T", ...pids.flatMap((p) => ["/PID", p])]);
  await killTrees([String(pid)]);
  const pgid = (await readFile(pgidFile, "utf8").catch(() => "")).trim();
  if (!/^\d+$/.test(pgid)) return; // bash 没开始执行命令，也不会再开始了
  const group = async (): Promise<string[]> => {
    const ps = await capture(path.join(exe, "..", "..", "usr", "bin", "ps.exe"), ["-l"]); // PID PPID PGID WINPID…，行首可有状态字母
    return [...ps.matchAll(/^[^\d\n]*\d+\s+\d+\s+(\d+)\s+(\d+)/gm)].filter((m) => m[1] === pgid).map((m) => m[2] ?? "");
  };
  await killTrees(await group());
  await killTrees(await group());
}

/** 命令的环境：服务的环境，加上进程 ID 和服务实际监听的管道名；去掉 MSYS_NO_PATHCONV。 */
export interface BashContext {
  process: string;
  pipe: string;
  /** 边跑边把输出推出去，只是预览、不进库（D88）。 */
  onData?: (chunk: Buffer) => void;
}

// MSYS_NO_PATHCONV 是 tau 脚本为 exec node 设的，会留在服务的环境里（kb-service 坑点）。命令要照常转换路径，所以去掉。
// Windows 的环境变量名不分大小写，所以按大写比较；TAU_PROCESS、TAU_PIPE 也先去掉再加，免得继承来的值留下。
const OWN_VARS = new Set(["MSYS_NO_PATHCONV", "TAU_PROCESS", "TAU_PIPE"]);
const commandEnv = (ctx: BashContext): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !OWN_VARS.has(k.toUpperCase()))),
  TAU_PROCESS: ctx.process,
  TAU_PIPE: ctx.pipe,
});

const NO_SHELL = "需要 Git for Windows：PATH 上找不到 git.exe，也就找不到它的 bin\\bash.exe";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 200;
// 预览每次轮询最多读这么多：写得快的命令不能让一次推送占住事件循环，剩下的留给下一次。
const PUSH_MAX = 1024 * 1024;
const winPath = (p: string): string => path.resolve(p).replace(/\//g, "\\");
const bashPath = (p: string): string => path.resolve(p).replace(/\\/g, "/");
const drop = (...files: string[]): void => {
  for (const f of files) {
    try {
      rmSync(f, { recursive: true, force: true });
    } catch {
      // 被占着删不掉：留着，7 天后清。
    }
  }
};

// 后台命令的包装脚本（D90）。和 WRAPPER 一样先写 pgid、经环境变量取命令、export -n；命令在子 shell 里跑，
// 命令里的 exit 和 exec 都不会让收尾跳过。命令结束后抢 claim（noclobber 下建文件，内建，不起进程；内核那边用 "wx"，
// 两边都是 O_EXCL，只有一个建得成）：内核先抢到（转了后台），脚本这时才写退出码行、运行通知脚本；脚本先抢到，什么都不做。
// 抢输了的错误信息丢掉，别写进 log。中文用 \x 转义写，任务号和 log 路径经环境变量给通知脚本（前缀赋值只导出给这一条命令）。
// 非 UTF-8 的 LANG（zh_CN.GBK、ja_JP.SJIS）下，msys 把环境变量和参数里的非 ASCII 字符（home 含中文时 claim 和 log 的路径）
// 按那个字符集转，会走样，claim 找不到、信丢了。所以命令跑完以后、碰这些路径之前，把这个 shell 的字符集换成 UTF-8
// （不导出，只对收尾有效；命令是在子 shell 里跑的，早已跑完，看到的仍是服务的 LANG）。
const hex = (s: string): string => [...Buffer.from(s)].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
const BG_WRAPPER = [
  'echo $$ > "$TAU_PGID" || exit',
  "export -n TAU_PGID TAU_COMMAND TAU_CLAIM TAU_JOB TAU_LOG TAU_NODE TAU_NOTIFY",
  '(eval "$TAU_COMMAND")',
  "c=$?",
  "LC_ALL=C.UTF-8",
  "set -C",
  `if ! { : > "$TAU_CLAIM"; } 2>/dev/null && [ -e "$TAU_CLAIM" ]; then rm -f "$TAU_PGID"; printf '\\n[${hex("后台任务")} %s] ${hex("退出码")} %s\\n' "$TAU_JOB" $c; TAU_JOB="$TAU_JOB" TAU_LOG="$TAU_LOG" "$TAU_NODE" "$TAU_NOTIFY" $c; rm -f "$TAU_CLAIM"; fi`,
  "exit $c",
].join("; ");

/** 删 `root` 下 7 天前的文件和空了的进程目录（`keep` 除外）。转了后台、还没汇报的（有 claim 的 log）不清：命令可能只是安静，清掉它，结束时就寄不出信了。claim 在同名 log 已经没了才清。每一步失败都忽略。 */
function sweep(root: string, keep: string): void {
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, d.name);
      if (!d.isDirectory()) continue;
      for (const f of readdirSync(dir).sort()) {
        const file = path.join(dir, f);
        if (f.endsWith(".claim") && existsSync(file.slice(0, -".claim".length))) continue;
        if (!f.endsWith(".claim") && existsSync(`${file}.claim`)) continue;
        if (Date.now() - statSync(file).mtimeMs > WEEK_MS) drop(file);
      }
      if (dir !== keep && readdirSync(dir).length === 0) rmdirSync(dir);
    }
  } catch {
    // 别的调用同时在清，或目录不存在：不管。
  }
}

/** 文件从 `start` 起最多 `len` 字节；读不出是空。 */
function readAt(file: string, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return buf.subarray(0, readSync(fd, buf, 0, len, start));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** 输出文件读成文字：头尾各 KEEP_BYTES 放得下就是全部，放不下留头尾。`size` 是文件的字节数。 */
function view(log: string): { body: string; size: number } {
  let size = 0;
  try {
    size = statSync(log).size;
  } catch {
    // 文件没了：当作没有输出。
  }
  if (size <= 2 * KEEP_BYTES) return { body: readAt(log, 0, size).toString("utf8"), size };
  return { body: elide(readAt(log, 0, KEEP_BYTES), readAt(log, size - KEEP_BYTES, KEEP_BYTES), size - 2 * KEEP_BYTES), size };
}

/**
 * bash 工具（D90）：先等 `timeout` 秒，命令在这么久里跑完，结果就是输出和退出码；没跑完就转后台，命令不被结束，
 * 输出一直写在文件里，跑完寄一封信。标准输出和标准错误从一开始就接到同一个文件，不走管道。
 * 谁来汇报只有一个赢家：内核在到时间时、包装脚本在命令结束后，各自建 `<log>.claim` 文件（O_EXCL），先建成的赢。
 */
export async function bash(args: { command: string; timeout?: number }, workdir: string, signal: AbortSignal, ctx: BashContext): Promise<ToolResultContent> {
  const wanted = args.timeout ?? DEFAULT_SECONDS;
  if (!Number.isInteger(wanted) || wanted < 0) return fail(`timeout 必须是非负整数（秒）：${args.timeout}`);
  const seconds = Math.min(wanted, MAX_SECONDS); // 超过 2^31 毫秒的定时器，Node 会改成 1 毫秒
  if (signal.aborted) return fail("已中止，命令没有运行");
  const exe = findShell();
  if (exe === null) return fail(NO_SHELL);
  const root = path.join(os.homedir(), ".tau", "extras", "shell");
  const dir = path.join(root, ctx.process);
  const job = randomBytes(3).toString("hex");
  const log = path.join(dir, `${Date.now()}-${job}.log`);
  const claim = `${log}.claim`;
  const pgidFile = path.join(os.tmpdir(), `tau-bash-${randomUUID()}.pgid`);
  let fd: number;
  try {
    mkdirSync(dir, { recursive: true });
    sweep(root, dir);
    fd = openSync(log, "w"); // 不能用 "a"：msys 写不了只追加的句柄，echo 静默失败。所有写入者共用这一个句柄，位置是共享的。
  } catch (e) {
    return fail(`无法建输出文件 ${winPath(log)}：${e instanceof Error ? e.message : String(e)}`);
  }
  const env = { ...commandEnv(ctx), TAU_PGID: pgidFile, TAU_COMMAND: args.command, TAU_CLAIM: bashPath(claim), TAU_JOB: job, TAU_LOG: bashPath(log), TAU_NODE: bashPath(process.execPath), TAU_NOTIFY: bashPath(path.join(import.meta.dirname, "notify.ts")) };
  let child: ChildProcess;
  try {
    child = spawn(exe, ["-c", BG_WRAPPER], { cwd: workdir, env, stdio: ["ignore", fd, fd], windowsHide: true });
  } catch (e) {
    drop(log); // 命令含 NUL 字符时 spawn 同步抛错
    return fail(`无法启动 bash（工作目录 ${workdir}）：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    closeSync(fd);
  }
  return new Promise((resolve) => {
    let offset = 0;
    let settled = false;
    let killing: Promise<string> | undefined;
    // 预览（D88）：从上次读到的位置继续读。`end` 是最后那次的上限：补到结果读到的位置为止，不多不少。
    const push = (end = Infinity): void => {
      if (!ctx.onData) return;
      for (let sent = 0; sent < PUSH_MAX; ) {
        const chunk = readAt(log, offset, Math.max(0, Math.min(65536, end - offset)));
        if (chunk.length === 0) return;
        offset += chunk.length;
        sent += chunk.length;
        ctx.onData(chunk);
      }
    };
    const kill = (why: string): void => void (killing ??= killAll(exe, child.pid, pgidFile).then(() => why));
    const onAbort = (): void => kill("已中止，结束了命令启动的进程");
    const timer = setTimeout(() => {
      if (killing) return;
      try {
        closeSync(openSync(claim, "wx")); // 已存在就抛错：包装脚本先抢到了，命令正好跑完，继续等 bash 退出。
      } catch {
        return;
      }
      settled = true;
      stopWatching();
      child.unref();
      let pgid = "";
      try {
        pgid = readFileSync(pgidFile, "utf8").trim();
      } catch {
        // bash 还没写 pgid：不写进程组号那一行。
      }
      const { body, size } = view(log);
      push(size); // 轮询以后写的那几行，补到结果读到的位置
      const text = `${body}${lineEnd(body)}[转入后台 ${job}] 命令还在运行，没有被结束。\n输出文件：${winPath(log)}（还在增长，用 read 读，可带 offset 和 limit）\n${/^\d+$/.test(pgid) ? `进程组号：${pgid}\n` : ""}跑完会给你寄一封信，内容是退出码和最后几行；你可以接着做别的事，也可以结束这一轮等信。`;
      resolve({ content: textContent(clip(text)), isError: false });
    }, seconds * 1000);
    const ticker = ctx.onData ? setInterval(push, POLL_MS) : undefined;
    signal.addEventListener("abort", onAbort, { once: true });
    const stopWatching = (): void => {
      clearTimeout(timer);
      clearInterval(ticker);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: ToolResultContent, keep = false): void => {
      settled = true;
      stopWatching();
      if (!keep) drop(log);
      drop(claim, pgidFile);
      resolve(result);
    };
    child.on("error", (e) => settled || finish(fail(`无法启动 bash（工作目录 ${workdir}）：${e.message}`)));
    child.on("exit", async (code) => {
      if (settled) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const why = await killing;
      stopWatching();
      const { body, size } = view(log);
      push(size);
      const keep = size > 2 * KEEP_BYTES;
      const note = keep ? `输出共 ${size} 字节，只显示了头尾。完整输出在 ${winPath(log)}，用 read 读（可带 offset 和 limit）。\n` : "";
      const text = clip(`${body}${lineEnd(body)}${note}[${why ?? `退出码 ${code ?? -1}`}]`);
      finish(why !== undefined ? fail(text) : { content: textContent(text), isError: code !== 0 }, keep);
    });
  });
}

/** 一次命令的运行：`stdin` 有值时从标准输入给，写完就关；`split` 时另外单独收标准输出。 */
export interface CommandSpec {
  command: string;
  /** 已经查过：正数，不超过 600。 */
  seconds: number;
  stdin?: string;
  split?: boolean;
}

/** `result` 和 bash 工具的一样（合并的输出加状态行）。`stdout` 只在 `split` 且命令运行过时有：标准输出的原文，和它是否被截断。 */
export interface CommandRun {
  result: ToolResultContent;
  stdout?: { text: string; truncated: boolean };
}

/** 工具定义的运行（设计稿 5.5）：超时就结束进程树、中止、输出上限、环境变量。输出走管道，不写文件、不转后台；bash 工具是上面的 `bash`，只共享 `findShell`、`killAll`、`commandEnv`。 */
export async function runCommand(spec: CommandSpec, workdir: string, signal: AbortSignal, ctx: BashContext): Promise<CommandRun> {
  const { seconds } = spec;
  if (signal.aborted) return { result: fail("已中止，命令没有运行") };
  const exe = findShell();
  if (exe === null) return { result: fail(NO_SHELL) };
  const out = output();
  const stdoutOnly = output();
  const pgidFile = path.join(os.tmpdir(), `tau-bash-${randomUUID()}.pgid`);
  return new Promise((resolve) => {
    const env = { ...commandEnv(ctx), TAU_PGID: pgidFile, TAU_COMMAND: spec.command };
    const stdio: ["ignore" | "pipe", "pipe", "pipe"] = [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"];
    const child = spawn(exe, ["-c", WRAPPER], { cwd: workdir, env, stdio, windowsHide: true }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    // 命令不读标准输入就退出时，写入会报 EPIPE。没有错误监听器，Node 会把它当未捕获异常，服务就退出了。
    child.stdin?.on("error", () => {});
    if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
    let code: number | null = null;
    // 正在结束进程时，它完成后给出结束的原因。
    let killing: Promise<string> | undefined;
    const kill = (why: string): void => void (killing ??= killAll(exe, child.pid, pgidFile).then(() => why));
    const onAbort = (): void => kill("已中止，结束了命令启动的进程");
    const timer = setTimeout(() => kill(`超时：${seconds} 秒后结束了命令启动的进程`), seconds * 1000);
    signal.addEventListener("abort", onAbort, { once: true });
    const stopWatching = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    // 会被调用多次（error、close、排空计时器）；resolve 只认第一次，其余步骤重复执行无害。
    const finish = (result: ToolResultContent): void => {
      stopWatching();
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      void rm(pgidFile, { force: true }).catch(() => {}).then(() => resolve({ result, ...(spec.split ? { stdout: stdoutOnly.raw() } : {}) }));
    };
    const end = async (): Promise<void> => {
      const why = await killing;
      finish(why !== undefined ? fail(out.text(why)) : { content: textContent(out.text(`退出码 ${code ?? -1}`)), isError: code !== 0 });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
      if (spec.split) stdoutOnly.push(chunk);
      ctx.onData?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out.push(chunk);
      ctx.onData?.(chunk);
    });
    child.on("error", (e) => finish(fail(`无法启动 bash（工作目录 ${workdir}）：${e.message}`)));
    child.on("exit", (c) => {
      code = c;
      stopWatching();
      setTimeout(end, DRAIN_MS).unref();
    });
    child.on("close", end);
  });
}
