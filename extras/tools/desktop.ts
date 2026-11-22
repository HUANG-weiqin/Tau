// desktop：给 Agent 自己写的脚本用的入口。脚本用 bash 跑 node，导入这个模块，自己编排截图和输入。
// 坐标和 computer 工具一样按截图算（fitSize 缩过的图）：先 fitSize(screenSize()) 得到 shot，再用 perform 或 toScreen 换成屏幕坐标。
// 发鼠标键盘输入必须走 leasedIo(proc)，否则绕过桌面租约，会和别的 Agent 抢输入。只截图不需要租约。
// 进程 ID 用 common.ts 的 tauEnv().proc；bash 里的命令有 TAU_PROCESS 和 TAU_PIPE。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { extrasDir } from "./common.ts";
import { acquireLease, leaseKeeper } from "./computer_lease.ts";
import { onlyReleases } from "./computer_lib.ts";
import type { Io } from "./computer_lib.ts";
import { releaseStuck, send, setCursor, withLeaseMutex } from "./win32.ts";

/** 真的输入。 */
const realIo: Io = { send, setCursor, sleep: (ms) => sleep(ms), releaseStuck };

export { capture, checkDesktop, desktopProblem, foreground, initDpi, screenSize } from "./win32.ts";
export { checkBounds, encodeImage, fitSize, parseArgs, perform, toScreen, zoomRect } from "./computer_lib.ts";
export type { Action, Io, Point, Rect, Size } from "./computer_lib.ts";

/** 租约文件：先写临时文件再改名，读的人不会看到写了一半的内容。 */
export function takeLease(proc: string): void {
  const file = path.join(extrasDir("computer"), "lease.json");
  acquireLease(proc, {
    withMutex: withLeaseMutex,
    read: () => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    write: (text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
    },
    now: () => Date.now(),
  });
}

/** 带租约的输入：send、setCursor 发出之前先确保持有租约（10 秒续一次）；sleep 不要。
 *  只松开的 send 和 releaseStuck 不要租约，直接发：拖动中途续租失败，补发的松开左键不能被挡住。
 *  拿不到租约就抛错，那一次不发出任何输入。raw、take、now 给测试换成假的。 */
export function leasedIo(proc: string, raw: Io = realIo, take: () => void = () => takeLease(proc), now: () => number = Date.now): Io {
  const ensure = leaseKeeper(take, now);
  return {
    send: (events) => {
      if (!onlyReleases(events)) ensure();
      raw.send(events);
    },
    setCursor: (p) => {
      ensure();
      raw.setCursor(p);
    },
    sleep: (ms) => raw.sleep(ms),
    releaseStuck: () => raw.releaseStuck(),
  };
}
