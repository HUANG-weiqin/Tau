// 后台命令跑完后，bash.ts 的包装脚本运行它：给发起命令的进程寄一封信（D90）。
// 只用 node 内置模块，不导入别的文件。用法：node notify.ts <退出码> [重试间隔毫秒]
// 环境：TAU_PROCESS、TAU_PIPE（命令的环境里本来就有），TAU_JOB（任务号）、TAU_LOG（log 路径）。
// 任务号和路径不走命令行参数：非 UTF-8 的 LANG 下，msys 把参数里的非 ASCII 字符转走样。
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TAIL_LINES = 20;
const TAIL_CHARS = 3000;
const SCAN_BYTES = 16 * 1024;
/** 连不上时每 5 秒重试一次，最多 720 次，约 1 小时。 */
const RETRIES = 720;

type Outcome = "receipt" | "unreachable" | { failed: string };

/** 发一行请求，等回执或错误。连不上是 `unreachable`（请求肯定没发出）；连上以后断开是 `failed`。 */
const attempt = (pipe: string, request: object): Promise<Outcome> =>
  new Promise((resolve) => {
    const socket = createConnection(pipe);
    socket.setEncoding("utf8");
    let connected = false;
    let buf = "";
    const end = (outcome: Outcome): void => {
      socket.destroy();
      resolve(outcome); // 只认第一次
    };
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let reply: { type?: string; message?: unknown };
        try {
          reply = JSON.parse(line);
        } catch {
          return end({ failed: "服务回的不是 JSON，不重试。" });
        }
        if (reply.type === "receipt") return end("receipt");
        if (reply.type === "error") return end({ failed: `寄信被拒绝，不重试：${String(reply.message)}` });
      }
    });
    socket.on("error", () => end(connected ? { failed: "没有收到回执就断开了，信寄没寄出不知道，不重试。" } : "unreachable"));
    socket.on("close", () => end({ failed: "没有收到回执就断开了，信寄没寄出不知道，不重试。" }));
  });

/** 文件最后 `SCAN_BYTES` 字节，从中间截断时去掉开头不完整的字符。读不出是空串。 */
function readTail(file: string): string {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, SCAN_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8").replace(/^\uFFFD+/, "");
  } catch {
    return "";
  }
}

/** 包装脚本在 log 末尾写的那行；信的第一行已经是它的内容。 */
const EXIT_LINE = /^\[后台任务 [0-9a-f]{6}\] 退出码 -?\d+$/;

async function main(code: string, retryMs: number): Promise<void> {
  const { TAU_PROCESS: proc, TAU_PIPE: pipe, TAU_JOB: job, TAU_LOG: log } = process.env;
  if (!proc || !pipe || !job || !log) throw new Error("没有 TAU_PROCESS、TAU_PIPE、TAU_JOB 或 TAU_LOG");
  const lines = readTail(log).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  // 只去最后一行、且完整匹配的退出码行；它前面脚本加的那个空行一起去掉。
  if (EXIT_LINE.test(lines.at(-1) ?? "")) {
    lines.pop();
    if (lines.at(-1) === "") lines.pop();
  }
  let shown = lines.slice(-TAIL_LINES).join("\n");
  // 按 UTF-16 单位切，可能切开代理对：丢掉开头残留的半个。
  if (shown.length > TAIL_CHARS) shown = `…${shown.slice(-TAIL_CHARS).replace(/^[\uDC00-\uDFFF]/, "")}`;
  const text = `[后台任务 ${job}] 退出码 ${code}\nlog：${path.resolve(log).replace(/\//g, "\\")}\n${shown}`;
  for (let i = 0; i < RETRIES; i++) {
    const outcome = await attempt(pipe, { op: "send", process: proc, text });
    if (outcome === "receipt") return;
    if (outcome !== "unreachable") return void process.stderr.write(`${outcome.failed}\n`);
    await sleep(retryMs);
  }
  process.stderr.write("连了约 1 小时都连不上服务，通知丢了。\n");
}

if (import.meta.main) {
  const [code, retry] = process.argv.slice(2);
  if (!/^-?\d+$/.test(code ?? "")) {
    process.stderr.write("用法：notify.ts <退出码> [重试间隔毫秒]\n");
    process.exitCode = 1;
  } else {
    main(code!, Number(retry ?? 5000)).catch((e: unknown) => {
      process.stderr.write(`通知出错：${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
  }
}
