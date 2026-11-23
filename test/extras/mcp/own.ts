// 测试里认“自己起的进程”：不只看进程号。
// Windows 的进程号复用很快（实测 20 个死掉的号里有 3 个在 300 个新进程内被复用）。
// 看到一个进程号时先只登记，要用的时候（isOwn、known、kill）一次查完：命令行对得上 `expect`（带这个测试文件的标记）才记下创建时间。
// 之后只认“进程号和创建时间都对得上”的。查之前已经死掉的号没有记下，当作不是自己的、也不在了。
// 真的泄漏的进程不会自己消失，创建时间一直对得上，照样抓得住；号被复用就不再误报，也不会误杀别人。
// 登记不起 powershell：测试在轮询状态时每一次都会登记，一次几百毫秒会把测试拖慢。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** 这些进程现在的创建时间和命令行，一次 powershell 查完。不在了的不出现在结果里。 */
function probe(pids: number[]): Map<number, { created: string; cmd: string }> | null {
  const out = new Map<number, { created: string; cmd: string }>();
  if (pids.length === 0) return out;
  const filter = pids.map((p) => `ProcessId=${p}`).join(" OR ");
  const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToFileTimeUtc())|$($_.CommandLine)" }`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (r.error !== undefined || r.status !== 0) return null;
  const text = r.stdout ?? "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.*)$/.exec(line);
    if (m !== null) out.set(Number(m[1]), { created: m[2]!, cmd: m[3]! });
  }
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface Own {
  /** 每个测试文件唯一的标记：假服务器的命令行和它起的孙进程都带它。 */
  mark: string;
  /** 登记一个刚看到的进程号。不查：要用的时候才一起查，命令行对得上 `expect` 的才算自己的。 */
  note(pid: number, expect: RegExp): void;
  /** 把登记过的一起查了。要让一个只活一小会儿的进程算数，在它还活着的时候调一次（比如每个测试结束时）。 */
  settle(): void;
  /** 记下了的（命令行对得上、查的时候还活着的）进程号。 */
  known(): number[];
  /** 现在还活着，而且就是记下的那个进程（创建时间对得上）。 */
  isOwn(pid: number): boolean;
  /** 是自己的才按进程树结束。 */
  kill(pid: number): void;
}

export function createOwn(): Own {
  const born = new Map<number, string>();
  const pending = new Map<number, RegExp>();
  /** 把登记过的一起查了：对得上的记下创建时间。 */
  function settle(): void {
    const todo = [...pending].filter(([pid]) => !born.has(pid) && alive(pid));
    const found = probe(todo.map(([pid]) => pid));
    // 查询失败就留着，下次再查：清掉的话这些号就丢了，泄漏检查会漏过。
    if (found === null) return;
    pending.clear();
    for (const [pid, expect] of todo) {
      const p = found.get(pid);
      if (p !== undefined && expect.test(p.cmd)) born.set(pid, p.created);
    }
  }
  const own: Own = {
    mark: `tau-t-${randomBytes(6).toString("hex")}`,
    note(pid, expect) {
      if (!born.has(pid)) pending.set(pid, expect);
    },
    settle,
    known() {
      settle();
      return [...born.keys()];
    },
    isOwn(pid) {
      settle();
      const created = born.get(pid);
      if (created === undefined || !alive(pid)) return false;
      return probe([pid])?.get(pid)?.created === created;
    },
    kill(pid) {
      if (own.isOwn(pid)) spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    },
  };
  return own;
}
