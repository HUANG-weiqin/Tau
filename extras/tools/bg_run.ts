// bg_run：把命令放到后台跑，工具立刻返回；跑完给自己寄一封信（kb-extras 的“工具库”和“后台命令和完成通知的配方”）。
// 后台命令在工具定义自己的 bash 里跑，输出全进 log（否则工具返回后管道关闭，写它会 SIGPIPE）。
// node 做两件事：`start` 取参数、查同名、建 log；`finish` 命令跑完后写退出码行、寄信（`notify`，`shell` 也用）。
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ConnectError, talk } from "./client.ts";
import { bashPath, extrasDir, Fail, readArgs, run, tauEnv, winPath } from "./common.ts";

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const TAIL_LINES = 20;
const TAIL_CHARS = 3000;
const SCAN_BYTES = 64 * 1024;
/** 连不上时每 5 秒重试一次，约 1 小时。 */
const RETRIES = 720;
const RETRY_MS = 5000;

/** 文件最后 `bytes` 字节，从中间截断时去掉开头不完整的字符。 */
function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8").replace(/^�+/, "");
}

/** 和界面“后台”页（bridge/bg.ts）认的一样：`[后台任务 <名字>] 退出码 N`。 */
const exitLine = (name: string, code: string): string => `[后台任务 ${name}] 退出码 ${code}`;
const hasExit = (text: string): boolean => /^\[后台任务 .+\] 退出码 -?\d+\s*$/m.test(text);

async function start(): Promise<void> {
  const { proc } = tauEnv();
  const { name, command } = await readArgs();
  if (typeof name !== "string" || !NAME.test(name)) throw new Fail("name 只许字母、数字、下划线和连字符，1 到 40 个字符。");
  if (typeof command !== "string" || command.trim() === "") throw new Fail("command 必须是非空字符串。");
  const dir = extrasDir("bg");
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, `${proc}-${name}.log`);
  let text: string | null = null;
  try {
    text = readTail(log, SCAN_BYTES);
  } catch {
    // 没有 log：没跑过。
  }
  // 没有退出码行就是还在跑。服务停了或机器重启，没跑完的任务也没有这一行：这时换个名字。
  if (text !== null && !hasExit(text)) throw new Fail(`后台任务 ${name} 还在运行，没有启动新的。log：${winPath(log)}。换个名字，或者等它跑完。`);
  writeFileSync(log, "");
  const message = `已在后台运行：${name}。log：${winPath(log)}。跑完会给你寄一封信（退出码加 log 最后几行）。不用等，接着做别的事；想看进度，用 read 读 log。`;
  // 第一行是 log，第二行是给模型的话，其余是命令原文。
  process.stdout.write(`${bashPath(log)}\n${message}\n${command}`);
}

async function finish(log: string | undefined, code: string | undefined): Promise<void> {
  const { proc } = tauEnv();
  if (log === undefined || code === undefined || !/^-?\d+$/.test(code)) throw new Fail("用法：bg_run.ts finish <log> <退出码>");
  const base = path.basename(log, ".log");
  if (!base.startsWith(`${proc}-`)) throw new Fail(`log 不属于这个进程：${log}`);
  const name = base.slice(proc.length + 1);
  let tail = "";
  try {
    tail = readTail(log, 16 * 1024);
  } catch {
    // log 没了：只寄退出码。
  }
  const lines = tail.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  // 先写退出码行：寄信失败时，log 里还有它。命令的输出不以换行结尾时先补一个，退出码行要独占一行才认得出。
  writeSync(1, `${tail === "" || tail.endsWith("\n") ? "" : "\n"}${exitLine(name, code)}\n`);
  await notify(name, log, String(code), lines);
}

/**
 * 寄“完成了”的信：`shell` 转后台的命令也用它（两个工具寄同一句话，界面和模型看到的形状一样）。
 * `log` 是输出文件，`lines` 是它最后几行（已经切好，调用方要截断就截断）。
 */
export async function notify(name: string, log: string, code: string, lines: string[]): Promise<void> {
  const { proc, pipe } = tauEnv();
  let shown = lines.slice(-TAIL_LINES).join("\n");
  if (shown.length > TAIL_CHARS) shown = `…${shown.slice(-TAIL_CHARS)}`;
  const text = `[后台任务 ${name}] 完成，退出码 ${code}\n${shown === "" ? "（log 是空的）" : `log 最后 ${Math.min(lines.length, TAIL_LINES)} 行：\n${shown}`}\n完整 log：${winPath(log)}`;
  for (let i = 0; i < RETRIES; i++) {
    try {
      let receipt = false;
      let error: string | null = null;
      await talk(pipe, { op: "send", process: proc, text }, (r) => {
        if (r.type === "receipt") receipt = true;
        else if (r.type === "error") error = String(r.message);
        return receipt || error !== null;
      });
      if (error !== null) process.stderr.write(`寄信被拒绝，不重试：${error}\n`);
      else if (!receipt) process.stderr.write("没有收到回执就断开了，信寄没寄出不知道，不重试。\n");
      return;
    } catch (e) {
      // 只在连不上时重试：这时信肯定没寄出。
      if (!(e instanceof ConnectError)) throw e;
      await sleep(RETRY_MS);
    }
  }
  process.stderr.write("连了约 1 小时都连不上服务，通知丢了。\n");
}

if (import.meta.main) {
  const [mode, log, code] = process.argv.slice(2);
  run(async () => {
    if (mode === "start") await start();
    else if (mode === "finish") await finish(log, code);
    else throw new Fail("用法：bg_run.ts start|finish");
  });
}
