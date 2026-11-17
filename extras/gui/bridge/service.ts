// 服务和桥的状态、重启（见 .knowledge/kb-gui.md 的“重启和旧代码”）。
// “旧代码”：进程启动的时间早于它用到的源码的最新修改时间。真正起停进程的是 restart.ps1，这里只判断、只转发。
import { execFile, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pipeRequest, pipeUp } from "./pipe.ts";

export interface ServiceOps {
  /** 按命令行找服务进程的启动时间（毫秒）。服务不在是 null。 */
  serviceStartedAt(): Promise<number | null>;
  /** 另起一个脱离的进程跑 restart.ps1，立刻返回。 */
  restart(args: { service: boolean; bridge: boolean; bridgePid: number; bridgeArgs: string[]; repo: string }): void;
}

export interface ServiceStatus {
  service: { up: boolean; startedAt: number | null; stale: boolean };
  bridge: { startedAt: number; stale: boolean };
  /** 在跑的进程数（阶段不是 idle）。服务不在是 null。 */
  running: number | null;
  /** 服务相关源码的最新修改时间，和桥相关源码的最新修改时间。 */
  newestSource: number;
  newestBridge: number;
}

/** 目录树里最新的修改时间（毫秒）。跳过 node_modules 和点开头的目录；`exts` 为空不筛。不存在的路径算 0。 */
export function newestMtime(roots: string[], exts: string[] = []): number {
  let best = 0;
  const walk = (p: string): void => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (base === "node_modules" || base.startsWith(".")) return;
      for (const name of readdirSync(p)) walk(path.join(p, name));
    } else if (exts.length === 0 || exts.includes(path.extname(p).toLowerCase())) best = Math.max(best, st.mtimeMs);
  };
  for (const r of roots) walk(r);
  return best;
}

const SOURCE_EXTS = [".ts", ".js", ".json"];

const FIND_SCRIPT = String.raw`$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]main\.ts"?\s+serve\s*$' } | Select-Object -First 1; if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }`;

/** 命令行里的一个参数：空的、带空白或引号的都加双引号。 */
function quoteArg(a: string): string {
  return a === "" || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/**
 * 起一个独立的 powershell 跑 `target` 命令行的 argv。
 * 不能用 detached：Windows 上那样起的 powershell 立刻退出，什么都不执行（见 kb-gui 的坑点）。
 * 非 detached 的子进程又会被桥的死带走，所以让 powershell 用 Start-Process 拉起孙进程。
 */
export function launchArgv(target: string[]): string[] {
  const line = target.map(quoteArg).join(" ");
  return ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath 'powershell.exe' -ArgumentList '${line.replace(/'/g, "''")}' -WindowStyle Hidden`];
}

/** 跑 restart.ps1 的 powershell argv。纯函数，测试直接比字符串。 */
export function restartCommand(script: string, f: { service: boolean; bridge: boolean; bridgePid: number; bridgeArgs: string[] }): string[] {
  const target = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script];
  if (f.service) target.push("-Service");
  if (f.bridge) target.push("-Bridge", "-BridgePid", String(f.bridgePid), "-BridgeArgs", f.bridgeArgs.join(" "));
  return launchArgv(target);
}

/** 真实的实现：PowerShell 查进程，独立的 powershell 跑 restart.ps1。 */
export const realOps: ServiceOps = {
  serviceStartedAt: () =>
    new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", FIND_SCRIPT], { encoding: "utf8", timeout: 15_000, windowsHide: true }, (err, stdout) => {
        const n = Number(stdout.trim());
        resolve(err || !Number.isFinite(n) || n <= 0 ? null : n);
      });
    }),
  restart({ service, bridge, bridgePid, bridgeArgs, repo }) {
    const script = path.join(repo, "extras", "gui", "restart.ps1");
    const child = spawn("powershell.exe", restartCommand(script, { service, bridge, bridgePid, bridgeArgs }), { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  },
};

export interface ServiceControlOptions {
  pipe: string;
  /** 仓库根目录。 */
  repo: string;
  ops?: ServiceOps;
  /** 桥的启动时间。默认现在减去 process.uptime()。 */
  bridgeStartedAt?: number;
  /** 查到的服务启动时间缓存多久（毫秒）。 */
  cacheMs?: number;
  now?: () => number;
}

export function createServiceControl(o: ServiceControlOptions) {
  const ops = o.ops ?? realOps;
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 30_000;
  const bridgeStartedAt = o.bridgeStartedAt ?? Math.round(Date.now() - process.uptime() * 1000);
  let cached: { at: number; value: number | null } | null = null;

  async function startedAt(): Promise<number | null> {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    const value = await ops.serviceStartedAt();
    cached = { at: now(), value };
    return value;
  }

  async function countRunning(): Promise<number | null> {
    let n: number | null = null;
    try {
      await pipeRequest(o.pipe, { op: "ps" }, (r) => {
        if (r?.type !== "ps" || !Array.isArray(r.processes)) return false;
        n = r.processes.filter((p: any) => (p?.self?.phase?.tag ?? "idle") !== "idle").length;
        return true;
      });
    } catch {
      return null;
    }
    return n;
  }

  async function status(): Promise<ServiceStatus> {
    const up = await pipeUp(o.pipe);
    const newestSource = newestMtime([path.join(o.repo, "src"), path.join(o.repo, "package.json"), path.join(o.repo, "package-lock.json")], SOURCE_EXTS);
    const newestBridge = newestMtime([path.join(o.repo, "extras", "gui", "bridge"), path.join(o.repo, "extras", "tools")], SOURCE_EXTS);
    const started = up ? await startedAt() : null;
    return {
      service: { up, startedAt: started, stale: started !== null && newestSource > started },
      bridge: { startedAt: bridgeStartedAt, stale: newestBridge > bridgeStartedAt },
      running: up ? await countRunning() : null,
      newestSource,
      newestBridge,
    };
  }

  /** 要重启服务而有进程在跑、又没有 `force`：不动，回在跑的个数。只重启桥不动进程，不拦。 */
  async function restart(a: { service: boolean; bridge: boolean; force: boolean; bridgeArgs: string[] }): Promise<{ ok: true } | { ok: false; running: number }> {
    if (a.service && !a.force) {
      const running = (await pipeUp(o.pipe)) ? await countRunning() : 0;
      if (running !== null && running > 0) return { ok: false, running };
    }
    cached = null;
    ops.restart({ service: a.service, bridge: a.bridge, bridgePid: process.pid, bridgeArgs: a.bridgeArgs, repo: o.repo });
    return { ok: true };
  }

  return { status, restart };
}
