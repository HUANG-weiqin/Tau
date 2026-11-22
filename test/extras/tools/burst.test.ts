// burst（extras/tools）：纯函数的测试，加一次只截图的子进程。不发任何鼠标键盘输入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Fail } from "../../../extras/tools/common.ts";
import { GAP, boxToShot, burstText, composeSheet, encodeFrame, frameDiff, parseBurstArgs, pickFrames, sheetLayout } from "../../../extras/tools/burst_lib.ts";
import type { BurstInfo } from "../../../extras/tools/burst_lib.ts";

// ---------- pickFrames ----------

test("pickFrames：不超过 max 全选；超过就均匀挑，含首尾、升序不重复", () => {
  assert.deepEqual(pickFrames(0), []);
  assert.deepEqual(pickFrames(5), [0, 1, 2, 3, 4]);
  assert.deepEqual(pickFrames(16), Array.from({ length: 16 }, (_, i) => i));
  for (const n of [17, 18, 20, 29, 30, 100]) {
    const p = pickFrames(n);
    assert.equal(p.length, 16, `n=${n}`);
    assert.equal(p[0], 0);
    assert.equal(p[15], n - 1);
    assert.equal(new Set(p).size, 16);
    assert.deepEqual([...p].sort((a, b) => a - b), p);
  }
  assert.deepEqual(pickFrames(30, 3), [0, 15, 29]);
  assert.deepEqual(pickFrames(30, 1), [0]);
});

// ---------- sheetLayout ----------

function checkLayout(k: number, w: number, h: number): ReturnType<typeof sheetLayout> {
  const l = sheetLayout(k, w, h);
  assert.equal(l.rows, Math.ceil(k / l.cols));
  assert.ok(l.cols >= 1 && l.cols <= k);
  assert.equal(l.sheetW, l.cols * l.cellW + (l.cols - 1) * GAP);
  assert.equal(l.sheetH, l.rows * l.cellH + (l.rows - 1) * GAP);
  assert.ok(l.sheetW <= 1568 && l.sheetH <= 1568, JSON.stringify(l));
  assert.ok(l.sheetW * l.sheetH <= 1_150_000, JSON.stringify(l));
  assert.ok(l.cellW <= w && l.cellH <= h, "不放大");
  for (const v of Object.values(l)) assert.ok(Number.isInteger(v));
  return l;
}

test("sheetLayout：各种情况都满足约束", () => {
  checkLayout(16, 1568, 656);
  checkLayout(1, 1568, 656);
  checkLayout(1, 300, 200);
  checkLayout(16, 300, 200);
  checkLayout(7, 1000, 1000);
  checkLayout(2, 656, 1568);
});

test("sheetLayout：1 格、小帧不放大；全屏 16 格选缩放比最大的列数", () => {
  const one = checkLayout(1, 300, 200);
  assert.deepEqual(one, { cols: 1, rows: 1, cellW: 300, cellH: 200, sheetW: 300, sheetH: 200 });
  const big = checkLayout(1, 1568, 656);
  assert.equal(big.cellW, 1568);
  const l = checkLayout(16, 1568, 656);
  // 穷举所有列数，没有比它缩放比更大的。
  for (let cols = 1; cols <= 16; cols++) {
    const rows = Math.ceil(16 / cols);
    for (let cw = l.cellW + 1; cw <= 1568; cw++) {
      const ch = Math.round((656 * cw) / 1568);
      const sw = cols * cw + (cols - 1) * GAP;
      const sh = rows * ch + (rows - 1) * GAP;
      assert.ok(sw > 1568 || sh > 1568 || sw * sh > 1_150_000, `cols=${cols} cellW=${cw} 也放得下`);
    }
  }
});

// ---------- composeSheet ----------

const BG = 0x30;
function solid(w: number, h: number, b: number, g: number, r: number): Uint8Array {
  const f = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) f.set([b, g, r, 255], i * 4);
  return f;
}
const px = (s: Uint8Array, sheetW: number, x: number, y: number): number[] => Array.from(s.subarray((y * sheetW + x) * 4, (y * sheetW + x) * 4 + 3));

test("composeSheet：纯色帧按行从左到右，间隙和多余格是深灰背景", () => {
  const w = 8;
  const h = 4;
  const layout = sheetLayout(3, w, h);
  // 小帧不放大，3 格、选出来的列数不确定，换成明确的布局检查位置。
  const l = { cols: 2, rows: 2, cellW: 4, cellH: 2, sheetW: 2 * 4 + GAP, sheetH: 2 * 2 + GAP };
  assert.ok(layout.cellW >= 1);
  const frames = [solid(w, h, 255, 0, 0), solid(w, h, 0, 255, 0), solid(w, h, 0, 0, 255)];
  const s = composeSheet(frames, w, h, l);
  assert.equal(s.length, l.sheetW * l.sheetH * 4);
  assert.deepEqual(px(s, l.sheetW, 0, 0), [255, 0, 0]);
  assert.deepEqual(px(s, l.sheetW, 3, 1), [255, 0, 0]);
  assert.deepEqual(px(s, l.sheetW, 4, 0), [BG, BG, BG]); // 列间隙
  assert.deepEqual(px(s, l.sheetW, 4 + GAP, 0), [0, 255, 0]);
  assert.deepEqual(px(s, l.sheetW, 0, 2), [BG, BG, BG]); // 行间隙
  assert.deepEqual(px(s, l.sheetW, 0, 2 + GAP), [0, 0, 255]);
  assert.deepEqual(px(s, l.sheetW, 4 + GAP, 2 + GAP), [BG, BG, BG]); // 没用的格
  assert.equal(s[3], 255);
});

test("composeSheet：区域平均，不是最近邻", () => {
  // 4×2 帧，左半黑右半白，缩成 1×1：平均是中灰。
  const f = new Uint8Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) f.set(i % 4 < 2 ? [0, 0, 0, 255] : [200, 100, 50, 255], i * 4);
  const s = composeSheet([f], 4, 2, { cols: 1, rows: 1, cellW: 1, cellH: 1, sheetW: 1, sheetH: 1 });
  assert.deepEqual(px(s, 1, 0, 0), [100, 50, 25]);
});

// ---------- frameDiff ----------

test("frameDiff：不变、单像素变、阈值、外框", () => {
  const w = 10;
  const h = 6;
  const a = solid(w, h, 100, 100, 100);
  const same = frameDiff(a, solid(w, h, 100, 100, 100), w, h);
  assert.deepEqual(same, { ratio: 0, box: null });

  const b = solid(w, h, 100, 100, 100);
  b[(2 * w + 3) * 4 + 1] = 200;
  const one = frameDiff(a, b, w, h);
  assert.equal(one.ratio, 1 / 60);
  assert.deepEqual(one.box, { x0: 3, y0: 2, x1: 3, y1: 2 });

  // 阈值：差 24 不算，差 25 算；三个通道各试一次，正负方向都试。
  for (const ch of [0, 1, 2]) {
    for (const [d, want] of [[24, 0], [25, 1], [-24, 0], [-25, 1]] as const) {
      const c = solid(w, h, 100, 100, 100);
      c[ch] = 100 + d;
      assert.equal(frameDiff(a, c, w, h).ratio * 60, want, `ch=${ch} d=${d}`);
    }
  }

  const e = solid(w, h, 100, 100, 100);
  e.set([0, 0, 0, 255], (1 * w + 2) * 4);
  e.set([0, 0, 0, 255], (4 * w + 7) * 4);
  assert.deepEqual(frameDiff(a, e, w, h).box, { x0: 2, y0: 1, x1: 7, y1: 4 });
});

// ---------- 坐标换算 ----------

test("boxToShot：全屏原样；区域按位置和帧尺寸换算", () => {
  const box = { x0: 3, y0: 2, x1: 9, y1: 5 };
  assert.deepEqual(boxToShot(box, { w: 100, h: 50 }, null), box);
  // 区域 (200,100)–(400,200)，帧 100×50：每帧像素对应截图 2 个像素。
  assert.deepEqual(boxToShot({ x0: 0, y0: 0, x1: 99, y1: 49 }, { w: 100, h: 50 }, [200, 100, 400, 200]), { x0: 200, y0: 100, x1: 398, y1: 198 });
  assert.deepEqual(boxToShot(box, { w: 100, h: 50 }, [200, 100, 400, 200]), { x0: 206, y0: 104, x1: 218, y1: 110 });
  // 帧比区域大（放大的小区域）：向下取整。
  assert.deepEqual(boxToShot({ x0: 5, y0: 5, x1: 5, y1: 5 }, { w: 300, h: 150 }, [10, 20, 40, 50]), { x0: 10, y0: 21, x1: 10, y1: 21 });
  assert.deepEqual(boxToShot({ x0: 150, y0: 75, x1: 299, y1: 149 }, { w: 300, h: 150 }, [10, 20, 40, 50]), { x0: 25, y0: 35, x1: 39, y1: 49 });
});

// ---------- burstText ----------

function info(over: Partial<BurstInfo> = {}): BurstInfo {
  const d = (ratio: number, box: BurstInfo["diffs"][number]["box"]) => ({ ratio, box });
  return {
    times: [0, 50, 100, 150, 200],
    elapsedMs: 250,
    shot: { w: 1568, h: 656 },
    frame: { w: 1568, h: 656 },
    region: null,
    cutShort: false,
    sheetPath: "C:\\x\\1-burst-sheet.png",
    layout: { cols: 3, rows: 2, cellW: 100, cellH: 50, sheetW: 308, sheetH: 104 },
    picked: [0, 1, 2, 3, 4],
    diffs: [d(0.0123, { x0: 10, y0: 20, x1: 30, y1: 40 }), d(0, null), d(0, null), d(0, null)],
    dir: "C:\\x",
    prefix: "1-burst",
    ...over,
  };
}

test("burstText：全屏，连续没变合成一行", () => {
  assert.equal(
    burstText(info()),
    [
      "连拍 5 帧，用时 0.25 秒，平均每 50 毫秒一帧。全屏，截图坐标 1568×656。",
      "网格图：C:\\x\\1-burst-sheet.png（3 列 × 2 行，按行从左到右；用 read 看）",
      "格 1：帧 1，0.00 秒",
      "格 2：帧 2，0.05 秒",
      "格 3：帧 3，0.10 秒",
      "格 4：帧 4，0.15 秒",
      "格 5：帧 5，0.20 秒",
      "变化（相邻两帧，坐标按截图算）：",
      "帧 1→2：变了 1.23%，范围 (10, 20)–(30, 40)",
      "帧 2→5 之间都没变",
      "单帧：C:\\x\\1-burst-01.jpg 到 1-burst-05.jpg，要细看用 read 打开。",
      "网格图同上：C:\\x\\1-burst-sheet.png",
    ].join("\n"),
  );
});

test("burstText：区域、单独一对没变、提前停、挑帧", () => {
  const t = burstText(
    info({
      times: [0, 100, 200],
      elapsedMs: 300,
      region: [200, 100, 400, 200],
      frame: { w: 100, h: 50 },
      cutShort: true,
      picked: [0, 2],
      layout: { cols: 2, rows: 1, cellW: 100, cellH: 50, sheetW: 204, sheetH: 50 },
      diffs: [{ ratio: 0, box: null }, { ratio: 0.5, box: { x0: 0, y0: 0, x1: 99, y1: 49 } }],
    }),
  );
  const lines = t.split("\n");
  assert.equal(lines[0], "连拍 3 帧，用时 0.30 秒，平均每 100 毫秒一帧。截图区域 (200, 100)–(400, 200)。输入桌面切走了（多半是锁屏或 UAC 提示），提前停下。");
  assert.ok(lines.includes("格 2：帧 3，0.20 秒"));
  assert.ok(!lines.some((l) => l.startsWith("格 3")));
  assert.ok(lines.includes("帧 1→2：没变"));
  assert.ok(lines.includes("帧 2→3：变了 50.00%，范围 (200, 100)–(398, 198)"));
  assert.equal(lines.at(-2), "单帧：C:\\x\\1-burst-01.jpg 到 1-burst-03.jpg，要细看用 read 打开。");
  assert.equal(lines.at(-1), "网格图同上：C:\\x\\1-burst-sheet.png");
});

test("burstText：只有一帧没有变化段", () => {
  const t = burstText(info({ times: [0], elapsedMs: 40, picked: [0], diffs: [] }));
  assert.ok(!t.includes("变化"));
  assert.ok(t.includes("1-burst-01.jpg 到 1-burst-01.jpg"));
});

// ---------- parseBurstArgs ----------

test("parseBurstArgs：默认值、边界、region", () => {
  assert.deepEqual(parseBurstArgs([]), { seconds: 2, region: null });
  assert.equal(parseBurstArgs(["--seconds", "0.2"]).seconds, 0.2);
  assert.equal(parseBurstArgs(["--seconds", "5"]).seconds, 5);
  assert.equal(parseBurstArgs(["--seconds", "1.5"]).seconds, 1.5);
  assert.deepEqual(parseBurstArgs(["--region", "0,10,200,300", "--seconds", "3"]), { seconds: 3, region: [0, 10, 200, 300] });
  assert.deepEqual(parseBurstArgs(["--region", "0, 10, 200, 300"]).region, [0, 10, 200, 300]);
});

test("parseBurstArgs：错误都是中文 Fail", () => {
  const bad = (argv: string[], re: RegExp): void => assert.throws(() => parseBurstArgs(argv), (e) => e instanceof Fail && re.test(e.message), argv.join(" "));
  bad(["--seconds", "0.1"], /--seconds 要在 0.2 到 5 之间/);
  bad(["--seconds", "5.1"], /--seconds 要在/);
  bad(["--seconds", "abc"], /--seconds 要在/);
  bad(["--seconds", "-1"], /--seconds 要在/);
  bad(["--seconds"], /后面要跟值/);
  bad(["--region", "1,2,3"], /四个整数/);
  bad(["--region", "1,2,3,x"], /四个整数/);
  bad(["--region", "1,2,3,4.5"], /四个整数/);
  bad(["--fps", "3"], /不认识的参数/);
});

// ---------- 脚本（只截图） ----------

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "extras", "tools", "burst.ts");

function pngSize(b: Buffer): { w: number; h: number } {
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): { w: number; h: number } {
  let i = 2;
  while (i + 9 < b.length) {
    const m = b[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("找不到 SOF");
}

test("脚本：连拍 0.3 秒（只截图，不动鼠标键盘）", (t) => {
  const home = mkdtempSync(join(tmpdir(), "tau-burst-"));
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, TAU_PROCESS: "ptest", TAU_PIPE: "\\\\.\\pipe\\tau-burst-test" };
    const r = spawnSync(process.execPath, [SCRIPT, "--seconds", "0.3"], { env, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0 && /屏幕锁着/.test(r.stderr)) return t.skip("屏幕锁着，拿不到输入桌面");
    assert.equal(r.status, 0, r.stderr);
    const m = /网格图：(\S+)（(\d+) 列 × (\d+) 行/.exec(r.stdout);
    assert.ok(m, r.stdout);
    const p = m[1]!;
    assert.ok(p.startsWith(join(home, ".tau", "extras", "computer", "ptest")), p);
    assert.ok(existsSync(p));
    assert.ok(statSync(p).size <= 1572864);
    const bytes = readFileSync(p);
    const isPng = bytes.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n";
    const size = isPng ? pngSize(bytes) : jpegSize(bytes);
    assert.ok(size.w <= 1568 && size.h <= 1568 && size.w * size.h <= 1_150_000, JSON.stringify(size));
    assert.match(r.stdout, /^连拍 \d+ 帧，用时 [\d.]+ 秒，平均每 \d+ 毫秒一帧。全屏，截图坐标 \d+×\d+。/);
    const first = join(home, ".tau", "extras", "computer", "ptest");
    assert.ok(r.stdout.includes(`单帧：${first}\\`), r.stdout);
    const f = /单帧：(\S+\\\d+-[0-9a-f]{6}-burst)-01\.jpg 到/.exec(r.stdout);
    assert.ok(f, r.stdout);
    assert.ok(existsSync(`${f[1]}-01.jpg`));

    const bad = spawnSync(process.execPath, [SCRIPT, "--region", "0,0,99999,10"], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /超出截图范围/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 单帧 JPEG 质量 ----------

test("encodeFrame：80 够就停；超过依次 60、40；还超就照存并标 tooBig", () => {
  const tried: number[] = [];
  const mk = (sizes: Record<number, number>) => (q: number): Uint8Array => {
    tried.push(q);
    return new Uint8Array(sizes[q]!);
  };
  let r = encodeFrame(mk({ 80: 100, 60: 50, 40: 10 }), 100);
  assert.deepEqual([tried.splice(0), r.quality, r.tooBig], [[80], 80, false]);
  r = encodeFrame(mk({ 80: 101, 60: 100, 40: 10 }), 100);
  assert.deepEqual([tried.splice(0), r.quality, r.tooBig, r.bytes.length], [[80, 60], 60, false, 100]);
  r = encodeFrame(mk({ 80: 300, 60: 200, 40: 100 }), 100);
  assert.deepEqual([tried.splice(0), r.quality, r.tooBig], [[80, 60, 40], 40, false]);
  r = encodeFrame(mk({ 80: 300, 60: 200, 40: 101 }), 100);
  assert.deepEqual([tried.splice(0), r.quality, r.tooBig, r.bytes.length], [[80, 60, 40], 40, true, 101]);
});

test("burstText：太大的帧提一句", () => {
  const t = burstText(info({ oversize: [1, 3] }));
  assert.ok(t.endsWith("第 2 帧太大，read 看不了。\n第 4 帧太大，read 看不了。\n网格图同上：C:\\x\\1-burst-sheet.png"));
});
