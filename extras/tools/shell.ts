// shell：运行命令，输出太长时只回头尾，完整输出存文件（kb-extras 的“工具库”）。
// 用户的命令不在 node 里跑：工具定义的命令模板在自己的 bash 里 eval 它，内核超时和停止时才管得住它。
// node 做四件事：`start` 从标准输入取参数、定输出文件；`hold` 先等几秒；`done` 记下退出码；`report` 截断输出、给出路径。
// 等够了还没跑完就把命令留在后台（工具正常返回，bash 不结束留在后台的进程），输出照样进文件，模型用 read 读。
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { notify } from "./bg_run.ts";
import { bashPath, extrasDir, Fail, readArgs, run, tauEnv, winPath } from "./common.ts";

/** 头尾各留这么多字节；整段加说明不到 16 KiB，远小于内核的输出上限。 */
export const KEEP_BYTES = 6 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** 先等几秒（`wait`，默认 60，最多 300）：等够了还没跑完，就留在后台、立刻返回。 */
const WAIT_DEFAULT = 60;
const WAIT_MAX = 300;
const POLL_MS = 100;

/** 删 `root` 下 7 天前的文件和空了的子目录（`keep` 除外）。每一步失败都忽略。 */
export function sweep(root: string, keep: string, now = Date.now()): void {
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, f.name);
        if (f.isFile() && now - statSync(file).mtimeMs > WEEK_MS) unlinkSync(file);
      }
      if (dir !== keep && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // 别的进程同时在清：不管。
    }
  }
}

function readAt(file: string, start: number, len: number): Buffer {
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** 输出文件读成给模型的文字。`file` 读不出当没有输出。短的原样回，长的回头尾和路径。`keep` 为真表示文件要留着。 */
export function render(file: string): { text: string; keep: boolean } {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return { text: "", keep: false };
  }
  if (size <= KEEP_BYTES * 2) return { text: readAt(file, 0, size).toString("utf8"), keep: false };
  // 从中间截断，边界上不完整的 UTF-8 字符会变成替换符，去掉。
  const head = readAt(file, 0, KEEP_BYTES).toString("utf8").replace(/�+$/, "");
  const tail = readAt(file, size - KEEP_BYTES, KEEP_BYTES).toString("utf8").replace(/^�+/, "");
  const text = `${head}\n…（中间省略 ${size - KEEP_BYTES * 2} 字节）…\n${tail}${tail.endsWith("\n") ? "" : "\n"}输出共 ${size} 字节，只显示了头尾。完整输出在 ${winPath(file)}，用 read 读（可带 offset 和 limit）。\n`;
  return { text, keep: true };
}

async function start(): Promise<void> {
  const { proc } = tauEnv();
  const { command, wait } = await readArgs();
  if (typeof command !== "string" || command.trim() === "") throw new Fail("command 必须是非空字符串。");
  if (wait !== undefined && (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > WAIT_MAX)) throw new Fail(`wait 是 0 到 ${WAIT_MAX} 的整数，或者省略。`);
  const seconds = wait ?? WAIT_DEFAULT;
  const root = extrasDir("shell");
  const dir = path.join(root, proc);
  mkdirSync(dir, { recursive: true });
  sweep(root, dir);
  const file = path.join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.log`);
  // <输出文件>.wait 里是等多少秒（0 就是老样子，一直等到命令结束）；<输出文件>.exit 在命令跑完时写下退出码。
  // <输出文件>.sync 表示“有调用在等”：等到了就同步返回、不寄信；转后台时撤掉它，跑完才寄信（等于唤醒进程）。
  writeFileSync(`${file}.wait`, String(seconds));
  if (seconds > 0) writeFileSync(`${file}.sync`, "");
  // 第一行是输出文件，其余是命令原文。
  process.stdout.write(`${bashPath(file)}\n${command}`);
}

function report(file: string | undefined): void {
  if (file === undefined) throw new Fail("缺少输出文件。");
  const { text, keep } = render(file);
  process.stdout.write(text);
  // 跑完时 in 命令的退出码：工具的结果是错误还是成功看它，和 bash 一样。
  const code = exitCode(file);
  if (code !== null) process.exitCode = code;
  if (!keep) {
    for (const p of [file, `${file}.exit`, `${file}.wait`, `${file}.sync`]) {
      try {
        unlinkSync(p);
      } catch {
        // 没有就算了。
      }
    }
  }
}

/** 命令跑完时 `done` 写下的退出码；还没写完或者没有，是 null。 */
function exitCode(file: string): number | null {
  try {
    const text = readFileSync(`${file}.exit`, "utf8").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** 命令跑完：把退出码写到旁边，`hold` 看到它就知道等到了。 */
function done(file: string | undefined, code: string | undefined): void {
  if (file === undefined || code === undefined || !/^-?\d+$/.test(code)) throw new Fail("用法：shell.ts done <输出文件> <退出码>");
  writeFileSync(`${file}.exit`, code);
}

/** 命令跑完了，又有调用已经转后台（没有 .sync）：寄一封信，等于唤醒这个进程。等到了结果的调用不寄。 */
async function told(file: string | undefined, code: string | undefined): Promise<void> {
  if (file === undefined || code === undefined || !/^-?\d+$/.test(code)) throw new Fail("用法：shell.ts notify <输出文件> <退出码>");
  if (existsSync(`${file}.sync`)) return;
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
  } catch {
    // 输出文件没了：只寄退出码。
  }
  await notify(path.basename(file, ".log"), file, code, lines);
}

/** 先等 `seconds` 秒：等够了还没跑完（没有退出码）就退出 1，模板据此把命令留在后台。 */
async function hold(file: string | undefined, seconds: string | undefined): Promise<void> {
  if (file === undefined || seconds === undefined || !/^\d+$/.test(seconds)) throw new Fail("用法：shell.ts hold <输出文件> <秒数>");
  const deadline = Date.now() + Number(seconds) * 1000;
  while (exitCode(file) === null && Date.now() < deadline) await sleep(POLL_MS);
  if (exitCode(file) !== null) return;
  // 等不到：撤掉“有调用在等”的标记，跑完由 notify 寄信。撤完再查一次，这期间跑完了照样同步返回。
  rmSync(`${file}.sync`, { force: true });
  if (exitCode(file) === null) process.exitCode = 1;
}

if (import.meta.main) {
  const [mode, file, extra] = process.argv.slice(2);
  run(async () => {
    if (mode === "start") await start();
    else if (mode === "report") report(file);
    else if (mode === "done") done(file, extra);
    else if (mode === "hold") await hold(file, extra);
    else if (mode === "notify") await told(file, extra);
    else throw new Fail("用法：shell.ts start|report|done|hold|notify");
  });
}
