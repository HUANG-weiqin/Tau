// burst：连拍。只截图，不发输入，不要租约。
// 用法：node E:/tau/extras/tools/burst.ts [--seconds 2] [--region x0,y0,x1,y1]
// 在一个进程里连续截屏（默认 2 秒，最多 30 帧），把帧拼成一张网格图，打印文字说明和图片路径；用 read 看图。
// 坐标和 computer 一样按截图算。纯函数在 burst_lib.ts，系统调用在 win32.ts（经 desktop.ts）。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Fail, extrasDir, run, tauEnv } from "./common.ts";
import { MAX_FRAMES, MAX_CELLS, burstText, composeSheet, encodeFrame, frameDiff, parseBurstArgs, pickFrames, sheetLayout } from "./burst_lib.ts";
import { encodeImage, encodeJpeg, pruneComputerImages } from "./computer_lib.ts";
import { capture, checkBounds, checkDesktop, desktopProblem, fitSize, initDpi, parseArgs, screenSize, zoomRect } from "./desktop.ts";
import type { Rect } from "./desktop.ts";

/** 写文件：先建目录再写；别的进程的清理可能在中间删掉刚建的空目录，那就重建再写一次。 */
function writeFile(dir: string, file: string, bytes: Uint8Array): void {
  for (let attempt = 0; ; attempt++) {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(file, bytes);
      return;
    } catch (e) {
      if (attempt > 0 || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}

if (import.meta.main) run(async () => {
  const args = parseBurstArgs(process.argv.slice(2));
  const { proc } = tauEnv();
  initDpi();
  checkDesktop();
  const screen = screenSize();
  const shot = fitSize(screen.w, screen.h);
  let rect: Rect = { x: 0, y: 0, ...screen };
  let out = shot;
  if (args.region !== null) {
    checkBounds(parseArgs({ action: "zoom", region: args.region }), shot);
    rect = zoomRect(args.region, shot, screen);
    out = fitSize(rect.w, rect.h);
  }

  const frames: Buffer[] = [];
  const times: number[] = [];
  let cutShort = false;
  const start = Date.now();
  const limit = args.seconds * 1000;
  // 帧均匀摊在整段时长里：第 i 帧不早于 i × 时长 / 最多帧数。截图本身更慢时就全速截。
  const step = limit / MAX_FRAMES;
  while (frames.length < MAX_FRAMES) {
    const early = frames.length * step - (Date.now() - start);
    if (early > 0) await sleep(early);
    const t = Date.now() - start;
    if (frames.length > 0 && t >= limit) break;
    if (desktopProblem() !== null) {
      cutShort = true;
      break;
    }
    times.push(t);
    frames.push(capture(rect, out));
  }
  const elapsedMs = Date.now() - start;
  if (frames.length === 0) throw new Fail(desktopProblem() ?? "一帧也没截到。");

  const diffs = frames.slice(1).map((f, i) => frameDiff(frames[i]!, f, out.w, out.h));
  const root = extrasDir("computer");
  const dir = path.resolve(root, proc);
  const prefix = `${Date.now()}-${randomBytes(3).toString("hex")}-burst`;
  const oversize: number[] = [];
  frames.forEach((f, i) => {
    const r = encodeFrame((q) => encodeJpeg(f, out.w, out.h, q));
    if (r.tooBig) oversize.push(i);
    writeFile(dir, path.join(dir, `${prefix}-${String(i + 1).padStart(2, "0")}.jpg`), r.bytes);
  });

  const picked = pickFrames(frames.length, MAX_CELLS);
  const layout = sheetLayout(picked.length, out.w, out.h);
  const sheet = encodeImage(composeSheet(picked.map((i) => frames[i]!), out.w, out.h, layout), layout.sheetW, layout.sheetH);
  const sheetPath = path.join(dir, `${prefix}-sheet.${sheet.ext}`);
  writeFile(dir, sheetPath, sheet.bytes);
  pruneComputerImages(root, Date.now(), dir);

  process.stdout.write(`${burstText({ times, elapsedMs, shot, frame: out, region: args.region, cutShort, sheetPath, layout, picked, diffs, dir, prefix, oversize })}\n`);
});
