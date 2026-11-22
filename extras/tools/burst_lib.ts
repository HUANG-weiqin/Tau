// burst 的纯函数：挑帧、网格布局、拼网格图、帧差、说明文字、参数。不导入 koffi，不碰屏幕。脚本是 burst.ts。
import { Fail } from "./common.ts";
import { IMAGE_MAX_BYTES, parseArgs } from "./computer_lib.ts";
import type { Quad, Size } from "./computer_lib.ts";

export const MAX_SECONDS = 5;
export const MIN_SECONDS = 0.2;
export const DEFAULT_SECONDS = 2;
/** 一次最多截这么多帧。 */
export const MAX_FRAMES = 30;
/** 网格图里最多放这么多格。 */
export const MAX_CELLS = 16;
/** 格间距（像素）。 */
export const GAP = 4;
/** 网格图的上限：和单张截图一样（长边和总像素）。 */
const SHEET_MAX_EDGE = 1568;
const SHEET_MAX_PIXELS = 1_150_000;
/** 单帧 JPEG 的质量，依次试到不超过上限为止。 */
export const JPEG_QUALITIES = [80, 60, 40];

/** 单帧编码：质量 80 超过上限就依次用 60、40 重编；还超就用最后一次的结果，tooBig 为真。 */
export function encodeFrame(encode: (quality: number) => Uint8Array, maxBytes = IMAGE_MAX_BYTES): { bytes: Uint8Array; quality: number; tooBig: boolean } {
  let bytes = encode(JPEG_QUALITIES[0]!);
  let quality = JPEG_QUALITIES[0]!;
  for (const q of JPEG_QUALITIES.slice(1)) {
    if (bytes.length <= maxBytes) break;
    bytes = encode(q);
    quality = q;
  }
  return { bytes, quality, tooBig: bytes.length > maxBytes };
}

/** 一个通道差超过这个值，像素就算变了。 */
const DIFF_THRESHOLD = 24;
const BACKGROUND = 0x30;

/** 从 n 帧里均匀挑最多 max 个下标：含第一帧和最后一帧，升序不重复。 */
export function pickFrames(n: number, max = MAX_CELLS): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max === 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (n - 1)) / (max - 1)));
  return out;
}

export interface Layout {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  sheetW: number;
  sheetH: number;
}

/** k 格、每帧 w×h：选使缩放比最大的列数。整张图不超过长边和总像素上限，格子不放大。 */
export function sheetLayout(k: number, w: number, h: number): Layout {
  let best: Layout | null = null;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols);
    const fit = (cellW: number): Layout => {
      const cellH = Math.max(1, Math.round((h * cellW) / w));
      return { cols, rows, cellW, cellH, sheetW: cols * cellW + (cols - 1) * GAP, sheetH: rows * cellH + (rows - 1) * GAP };
    };
    const ok = (l: Layout): boolean => l.sheetW <= SHEET_MAX_EDGE && l.sheetH <= SHEET_MAX_EDGE && l.sheetW * l.sheetH <= SHEET_MAX_PIXELS;
    let cellW = w;
    let l = fit(cellW);
    while (!ok(l) && cellW > 1) l = fit(--cellW);
    if (!ok(l)) continue;
    if (best === null || l.cellW > best.cellW) best = l;
  }
  if (best === null) throw new Fail(`${k} 格放不进网格图。`);
  return best;
}

/** 把帧（BGRA，w×h）按行从左到右排成网格图；每格用区域平均缩小。背景深灰。 */
export function composeSheet(frames: Uint8Array[], w: number, h: number, layout: Layout): Uint8Array {
  const { cols, cellW, cellH, sheetW, sheetH } = layout;
  const out = new Uint8Array(sheetW * sheetH * 4);
  for (let i = 0; i < sheetW * sheetH; i++) {
    out[i * 4] = BACKGROUND;
    out[i * 4 + 1] = BACKGROUND;
    out[i * 4 + 2] = BACKGROUND;
    out[i * 4 + 3] = 255;
  }
  frames.forEach((f, idx) => {
    const ox = (idx % cols) * (cellW + GAP);
    const oy = Math.floor(idx / cols) * (cellH + GAP);
    for (let dy = 0; dy < cellH; dy++) {
      const sy0 = Math.floor((dy * h) / cellH);
      const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * h) / cellH));
      for (let dx = 0; dx < cellW; dx++) {
        const sx0 = Math.floor((dx * w) / cellW);
        const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * w) / cellW));
        let b = 0;
        let g = 0;
        let r = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let p = (sy * w + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, p += 4) {
            b += f[p]!;
            g += f[p + 1]!;
            r += f[p + 2]!;
          }
        }
        const n = (sy1 - sy0) * (sx1 - sx0);
        const o = ((oy + dy) * sheetW + ox + dx) * 4;
        out[o] = Math.round(b / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(r / n);
      }
    }
  });
  return out;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface Diff {
  ratio: number;
  box: Box | null;
}

/** 两帧（BGRA，w×h）比较：B、G、R 任一通道差超过 24 的像素算变了。box 含边界，帧内坐标。 */
export function frameDiff(a: Uint8Array, b: Uint8Array, w: number, h: number): Diff {
  let changed = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (Math.abs(a[p]! - b[p]!) > DIFF_THRESHOLD || Math.abs(a[p + 1]! - b[p + 1]!) > DIFF_THRESHOLD || Math.abs(a[p + 2]! - b[p + 2]!) > DIFF_THRESHOLD) {
        changed++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { ratio: changed / (w * h), box: changed === 0 ? null : { x0, y0, x1, y1 } };
}

/** 帧内坐标的外框换成截图坐标。region 是截图里的区域（null 表示全屏，帧就是截图）；x = x0 + u × (x1 − x0) / 帧宽，取整。 */
export function boxToShot(box: Box, frame: Size, region: Quad | null): Box {
  if (region === null) return box;
  const [rx0, ry0, rx1, ry1] = region;
  const cx = (u: number): number => rx0 + Math.floor((u * (rx1 - rx0)) / frame.w);
  const cy = (v: number): number => ry0 + Math.floor((v * (ry1 - ry0)) / frame.h);
  return { x0: cx(box.x0), y0: cy(box.y0), x1: cx(box.x1), y1: cy(box.y1) };
}

export interface BurstInfo {
  /** 每帧距开始的毫秒。 */
  times: number[];
  /** 整个连拍的毫秒数。 */
  elapsedMs: number;
  shot: Size;
  /** 帧尺寸。 */
  frame: Size;
  region: Quad | null;
  /** 因输入桌面切走提前停。 */
  cutShort: boolean;
  sheetPath: string;
  layout: Layout;
  /** 网格图里每格对应的帧下标。 */
  picked: number[];
  /** 相邻两帧的差，长度是帧数减 1。 */
  diffs: Diff[];
  dir: string;
  /** 单帧文件名前缀（不含 -01.jpg）。 */
  prefix: string;
  /** 编完还超过图片上限、read 看不了的帧（下标）。 */
  oversize?: number[];
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 给模型看的文字。帧编号从 1 起。 */
export function burstText(i: BurstInfo): string {
  const n = i.times.length;
  const where = i.region === null ? `全屏，截图坐标 ${i.shot.w}×${i.shot.h}` : `截图区域 (${i.region[0]}, ${i.region[1]})–(${i.region[2]}, ${i.region[3]})`;
  const head = `连拍 ${n} 帧，用时 ${(i.elapsedMs / 1000).toFixed(2)} 秒，平均每 ${Math.round(i.elapsedMs / n)} 毫秒一帧。${where}。${i.cutShort ? "输入桌面切走了（多半是锁屏或 UAC 提示），提前停下。" : ""}`;
  const lines = [head, `网格图：${i.sheetPath}（${i.layout.cols} 列 × ${i.layout.rows} 行，按行从左到右；用 read 看）`];
  i.picked.forEach((j, k) => lines.push(`格 ${k + 1}：帧 ${j + 1}，${(i.times[j]! / 1000).toFixed(2)} 秒`));
  if (n >= 2) {
    lines.push("变化（相邻两帧，坐标按截图算）：");
    let j = 0;
    while (j < i.diffs.length) {
      const d = i.diffs[j]!;
      if (d.box === null) {
        let e = j;
        while (e + 1 < i.diffs.length && i.diffs[e + 1]!.box === null) e++;
        lines.push(e === j ? `帧 ${j + 1}→${j + 2}：没变` : `帧 ${j + 1}→${e + 2} 之间都没变`);
        j = e + 1;
      } else {
        const b = boxToShot(d.box, i.frame, i.region);
        lines.push(`帧 ${j + 1}→${j + 2}：变了 ${(d.ratio * 100).toFixed(2)}%，范围 (${b.x0}, ${b.y0})–(${b.x1}, ${b.y1})`);
        j++;
      }
    }
  }
  lines.push(`单帧：${i.dir}\\${i.prefix}-01.jpg 到 ${i.prefix}-${pad2(n)}.jpg，要细看用 read 打开。`);
  for (const j of i.oversize ?? []) lines.push(`第 ${j + 1} 帧太大，read 看不了。`);
  // 输出有几十行，模型常用 head 或 tail 截一段：网格图的路径首尾各写一次。
  lines.push(`网格图同上：${i.sheetPath}`);
  return lines.join("\n");
}

/** 命令行参数：--seconds（0.2 到 5，默认 2）、--region x0,y0,x1,y1。region 在截图内、非空的检查在知道截图尺寸之后（computer_lib 的 checkBounds）。 */
export function parseBurstArgs(argv: string[]): { seconds: number; region: Quad | null } {
  let seconds = DEFAULT_SECONDS;
  let region: Quad | null = null;
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k]!;
    const v = argv[k + 1];
    if (flag !== "--seconds" && flag !== "--region") throw new Fail(`不认识的参数 ${flag}。用法：burst.ts [--seconds 2] [--region x0,y0,x1,y1]`);
    if (v === undefined) throw new Fail(`${flag} 后面要跟值。`);
    if (flag === "--seconds") {
      const s = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!(s >= MIN_SECONDS && s <= MAX_SECONDS)) throw new Fail(`--seconds 要在 ${MIN_SECONDS} 到 ${MAX_SECONDS} 之间，收到 ${v}。`);
      seconds = s;
    } else {
      const parts = v.split(",");
      if (parts.length !== 4 || !parts.every((p) => /^-?\d+$/.test(p.trim()))) throw new Fail(`--region 要是四个整数 x0,y0,x1,y1（截图里的像素坐标），收到 ${v}。`);
      const a = parseArgs({ action: "zoom", region: parts.map((p) => Number(p.trim())) });
      if (a.action !== "zoom") throw new Fail("--region 不合法。");
      region = a.region;
    }
  }
  return { seconds, region };
}
