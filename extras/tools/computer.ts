// computer：操作这台电脑的主屏幕（截图、放大、点击、移动、拖动、滚动、输入、按键、等待）。
// 参数的 JSON 从标准输入来，输出是 `output: content` 的 JSON 数组：一段文字，一张图片（文件在 ~/.tau/extras/computer/<进程 ID>/）。
// 坐标是截图里的像素；截图按 fitSize 缩过，每次调用按当前屏幕尺寸重算，不存状态。判断在 computer_lib.ts，系统调用在 win32.ts。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dropUnknown, extrasDir, readArgs, refuseUnknown, run, takeArgs, takeNotes, tauEnv } from "./common.ts";
import { checkBounds, describeWindow, doneText, encodeImage, fitSize, parseArgs, perform, pruneComputerImages, zoomRect, zoomText } from "./computer_lib.ts";
import type { Io, Size } from "./computer_lib.ts";
import { needsLease } from "./computer_lease.ts";
import { takeLease } from "./desktop.ts";
import { capture, checkDesktop, desktopProblem, foreground, initDpi, releaseStuck, screenSize, send, setCursor } from "./win32.ts";

/** 动作做完等这么久，让界面反应过来再截图。 */
const SETTLE_MS = 500;

const io: Io = { send, setCursor, sleep: (ms) => sleep(ms), releaseStuck };

/** 编码、写成文件，返回给模型的路径（Windows 写法）。顺手清掉旧图。
 *  先编码，再建目录、紧接着写：别的进程的清理可能在中间删掉刚建的空目录，那就重建再写一次。 */
function saveImage(proc: string, bgra: Buffer, size: Size): string {
  const root = extrasDir("computer");
  const dir = path.join(root, proc);
  const { bytes, ext } = encodeImage(bgra, size.w, size.h);
  const file = path.resolve(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`);
  for (let attempt = 0; ; attempt++) {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, bytes);
      break;
    } catch (e) {
      if (attempt > 0 || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  pruneComputerImages(root, Date.now(), dir);
  return file;
}

/** 输出一个 JSON 数组。“注：”并进第一个文字项（标准输出只能是这一个数组）；没有文字项就加一个。 */
const show = (items: unknown[]): void => {
  const n = takeNotes();
  const first = items.find((i) => (i as { type?: string }).type === "text") as { text: string } | undefined;
  if (n !== "") {
    if (first === undefined) items.unshift({ type: "text", text: n });
    else first.text = `${first.text}
${n}`;
  }
  process.stdout.write(`${JSON.stringify(items)}
`);
};

if (import.meta.main) run(async () => {
  const { proc } = tauEnv();
  const taken = takeArgs("computer", await readArgs());
  const a = parseArgs(taken.args);
  // 不认识的参数：输入动作拒绝（可能改了意思，做错了收不回），其余丢掉。都在拿租约之前。
  if (needsLease(a.action)) refuseUnknown("computer", taken.unknown, `这次没有${a.action}：去掉 ${taken.unknown.join("、")} 再调，会照剩下的参数真的执行 ${a.action}（${JSON.stringify(taken.args)}），${taken.unknown.join("、")} 不会生效；拿不准先 screenshot 看一眼。`);
  else dropUnknown("computer", taken.unknown);
  // 输入动作先拿租约：拿不到就在发出任何输入之前报错。
  if (needsLease(a.action)) takeLease(proc);
  initDpi();
  checkDesktop();
  const screen = screenSize();
  const shot = fitSize(screen.w, screen.h);
  checkBounds(a, shot, screen);

  if (a.action === "zoom") {
    const rect = zoomRect(a.region, shot, screen);
    const out = fitSize(rect.w, rect.h);
    const file = saveImage(proc, capture(rect, out), out);
    show([{ type: "text", text: zoomText(a.region, rect, out) }, { type: "image", path: file }]);
    return;
  }
  await perform(a, shot, screen, io);
  // 动作已经做了。之后的任何错误都带上做了什么，免得模型以为没做成、再做一遍。
  const did = doneText(a);
  try {
    if (a.action !== "screenshot" && a.action !== "wait") await sleep(SETTLE_MS);
    const problem = desktopProblem();
    if (problem !== null) {
      // 点了会弹 UAC 的东西、win+l、等的时候锁屏：输入桌面已经切走，截图会是黑的。
      show([{ type: "text", text: `${did === "" ? "" : `${did}。`}之后输入桌面切走了（多半是 UAC 提示或锁屏），没有截图。` }]);
      return;
    }
    const file = saveImage(proc, capture({ x: 0, y: 0, ...screen }, shot), shot);
    const fg = foreground();
    const text = `${did === "" ? "" : `${did}。`}截图 ${shot.w}×${shot.h}，主屏 ${screen.w}×${screen.h}；坐标按截图算。前台窗口：${describeWindow(fg.title, fg.exe)}`;
    show([{ type: "text", text }, { type: "image", path: file }]);
  } catch (e) {
    if (did === "") throw e;
    // 动作已经做了：退出码 0，写明没截到图，免得模型以为没做成、再做一遍。
    show([{ type: "text", text: `${did}。动作已经做了；之后没截到图：${e instanceof Error ? e.message : String(e)}。要看画面就 screenshot。` }]);
  }
});
