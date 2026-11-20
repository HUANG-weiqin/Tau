// 后台命令的 log 有两处：配方跑的 extras/bg/<进程 ID>-<名字>.log；
// bash 工具转入后台的 extras/shell/<进程 ID>/<毫秒时间>-<任务号>.log（旁边有 .claim 文件才算转了后台，D90）。
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

const TAIL_BYTES = 8 * 1024;
const EXIT_SCAN_BYTES = 64 * 1024;

export interface BgLog {
  process: string;
  name: string;
  /** 相对 extras 目录的路径，界面上显示。 */
  file: string;
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

function entry(process: string, name: string, file: string, shown: string): BgLog {
  const st = statSync(file);
  if (!st.isFile()) throw new Error("不是文件");
  return { process, name, file: shown, size: st.size, mtime: st.mtimeMs, tail: readTail(file, st.size, TAIL_BYTES), exit: parseExit(readTail(file, st.size, EXIT_SCAN_BYTES)) };
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

export function listBgLogs(home: string, processes: string[]): BgLog[] {
  const extras = path.join(home, "extras");
  const bg = names(path.join(extras, "bg"));
  const out: BgLog[] = [];
  for (const process of processes) {
    const found: [string, string, string][] = []; // 名字、文件、显示的路径
    for (const f of bg.filter((n) => n.startsWith(`${process}-`) && n.endsWith(".log"))) found.push([f.slice(process.length + 1, -4), path.join(extras, "bg", f), `bg/${f}`]);
    const shellDir = path.join(extras, "shell", process);
    const shell = names(shellDir);
    for (const f of shell.filter((n) => n.endsWith(".log") && shell.includes(`${n}.claim`))) found.push([f.slice(f.indexOf("-") + 1, -4), path.join(shellDir, f), `shell/${process}/${f}`]);
    for (const [name, file, shown] of found) {
      try {
        out.push(entry(process, name, file, shown));
      } catch {
        // 读的时候文件没了：跳过。
      }
    }
  }
  return out;
}
