// shell：运行命令，输出太长时只回头尾，完整输出存文件（kb-extras 的“工具库”）。
// 用户的命令不在 node 里跑：工具定义的命令模板在自己的 bash 里 eval 它，内核超时和停止时才管得住它。
// node 只做两件事：`start` 从标准输入取参数、定输出文件；`report` 截断输出、给出路径。
import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { bashPath, extrasDir, Fail, readArgs, run, tauEnv, winPath } from "./common.ts";

/** 头尾各留这么多字节；整段加说明不到 16 KiB，远小于内核的输出上限。 */
export const KEEP_BYTES = 6 * 1024;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  const { command } = await readArgs();
  if (typeof command !== "string" || command.trim() === "") throw new Fail("command 必须是非空字符串。");
  const root = extrasDir("shell");
  const dir = path.join(root, proc);
  mkdirSync(dir, { recursive: true });
  sweep(root, dir);
  const file = path.join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.log`);
  // 第一行是输出文件，其余是命令原文。
  process.stdout.write(`${bashPath(file)}\n${command}`);
}

function report(file: string | undefined): void {
  if (file === undefined) throw new Fail("缺少输出文件。");
  const { text, keep } = render(file);
  process.stdout.write(text);
  if (!keep) {
    try {
      unlinkSync(file);
    } catch {
      // 没有就算了。
    }
  }
}

if (import.meta.main) {
  const [mode, file] = process.argv.slice(2);
  run(async () => {
    if (mode === "start") await start();
    else if (mode === "report") report(file);
    else throw new Fail("用法：shell.ts start|report");
  });
}
