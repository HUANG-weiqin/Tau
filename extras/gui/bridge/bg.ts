// 后台命令的 log：extras/bg/<进程 ID>-<名字>.log。
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

const TAIL_BYTES = 8 * 1024;
const EXIT_SCAN_BYTES = 64 * 1024;

export interface BgLog {
  process: string;
  name: string;
  size: number;
  mtime: number;
  tail: string;
  exit: number | null;
}

function readTail(file: string, size: number, bytes: number): string {
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  let start = 0;
  // 从中间截断时，丢掉开头不完整的 UTF-8 字符。
  if (size > len) while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** 取最后一行 `[后台任务 <名字>] 退出码 N` 的 N。 */
export function parseExit(text: string): number | null {
  let exit: number | null = null;
  for (const l of text.split(/\r?\n/)) {
    const m = /^\[后台任务 .+\] 退出码 (-?\d+)\s*$/.exec(l);
    if (m) exit = Number(m[1]);
  }
  return exit;
}

export function listBgLogs(home: string, processes: string[]): BgLog[] {
  const dir = path.join(home, "extras", "bg");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BgLog[] = [];
  for (const process of processes) {
    for (const f of names.filter((n) => n.startsWith(`${process}-`) && n.endsWith(".log")).sort()) {
      const file = path.join(dir, f);
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        out.push({
          process,
          name: f.slice(process.length + 1, -4),
          size: st.size,
          mtime: st.mtimeMs,
          tail: readTail(file, st.size, TAIL_BYTES),
          exit: parseExit(readTail(file, st.size, EXIT_SCAN_BYTES)),
        });
      } catch {
        // 读的时候文件没了：跳过。
      }
    }
  }
  return out;
}
