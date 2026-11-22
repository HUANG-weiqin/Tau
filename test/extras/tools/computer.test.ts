// computer（extras/tools）：纯函数的测试，加两次只读的子进程（截图、放大）。
// 这里绝不移动鼠标、点击或按键：脚本只被要求截图和放大。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import type { InputEvent, Io, Point } from "../../../extras/tools/computer_lib.ts";
import { encodeInputs } from "../../../extras/tools/win32.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  IMAGE_MAX_BYTES,
  checkBounds,
  clickEvents,
  comboEvents,
  describeWindow,
  doneText,
  encodeImage,
  encodePng,
  fitSize,
  parseArgs,
  parseKeys,
  parseModifiers,
  perform,
  pruneComputerImages,
  scrollEvents,
  stuckEvents,
  toScreen,
  typeEvents,
  typeItems,
  wheelEvent,
  zoomRect,
} from "../../../extras/tools/computer_lib.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "extras", "tools", "computer.ts");

const failure = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail("应该报错");
};

test("fitSize：主屏、副屏、小屏", () => {
  assert.deepEqual(fitSize(3440, 1440), { w: 1568, h: 656 });
  assert.deepEqual(fitSize(1920, 1080), { w: 1429, h: 804 });
  assert.deepEqual(fitSize(1024, 768), { w: 1024, h: 768 });
  const s = fitSize(2560, 1600);
  assert.ok(Math.max(s.w, s.h) <= 1568 && s.w * s.h <= 1_150_000, JSON.stringify(s));
});

test("toScreen：角点、夹边、往返误差不超过一个缩放步长", () => {
  const screen = { w: 3440, h: 1440 };
  const shot = fitSize(screen.w, screen.h);
  assert.deepEqual(toScreen({ x: 0, y: 0 }, shot, screen), { x: 1, y: 1 });
  assert.deepEqual(toScreen({ x: shot.w - 1, y: shot.h - 1 }, shot, screen), { x: 3440 - 2, y: 1440 - 2 });
  assert.deepEqual(toScreen({ x: -5, y: -5 }, shot, screen), { x: 0, y: 0 });
  assert.deepEqual(toScreen({ x: 99999, y: 99999 }, shot, screen), { x: 3439, y: 1439 });
  const stepX = Math.ceil(screen.w / shot.w);
  const stepY = Math.ceil(screen.h / shot.h);
  for (let sx = 0; sx < screen.w; sx++) {
    const back = toScreen({ x: Math.floor((sx * shot.w) / screen.w), y: 0 }, shot, screen).x;
    assert.ok(Math.abs(back - sx) <= stepX, `x ${sx} -> ${back}`);
  }
  for (let sy = 0; sy < screen.h; sy++) {
    const back = toScreen({ x: 0, y: Math.floor((sy * shot.h) / screen.h) }, shot, screen).y;
    assert.ok(Math.abs(back - sy) <= stepY, `y ${sy} -> ${back}`);
  }
  // 不缩放时就是原点加 0.5 取整。
  assert.deepEqual(toScreen({ x: 7, y: 9 }, { w: 100, h: 100 }, { w: 100, h: 100 }), { x: 7, y: 9 });
});

test("zoomRect：向外取整、不出屏幕；输出尺寸用 fitSize", () => {
  const screen = { w: 3440, h: 1440 };
  const shot = fitSize(screen.w, screen.h);
  const r = zoomRect([100, 100, 200, 200], shot, screen);
  assert.deepEqual(r, { x: Math.floor((100 * 3440) / 1568), y: Math.floor((100 * 1440) / 656), w: Math.ceil((200 * 3440) / 1568) - Math.floor((100 * 3440) / 1568), h: Math.ceil((200 * 1440) / 656) - Math.floor((100 * 1440) / 656) });
  assert.deepEqual(zoomRect([0, 0, shot.w, shot.h], shot, screen), { x: 0, y: 0, w: 3440, h: 1440 });
  // 小区域是原分辨率，不放大。
  assert.deepEqual(fitSize(r.w, r.h), { w: r.w, h: r.h });
  // 整屏的放大图和截图一样大。
  assert.deepEqual(fitSize(3440, 1440), shot);
  // 一个像素宽也至少有 1 个屏幕像素。
  const tiny = zoomRect([5, 5, 6, 6], shot, screen);
  assert.ok(tiny.w >= 1 && tiny.h >= 1);
});

test("parseKeys：组合、序列、只有修饰键、大小写", () => {
  assert.deepEqual(parseKeys("ctrl+s"), [{ mods: [{ vk: 0x11, ext: false }], key: { vk: 0x53, ext: false } }]);
  assert.deepEqual(parseKeys("CTRL+Shift+Left"), [
    { mods: [{ vk: 0x11, ext: false }, { vk: 0x10, ext: false }], key: { vk: 0x25, ext: true } },
  ]);
  const seq = parseKeys("ctrl+a BackSpace");
  assert.equal(seq.length, 2);
  assert.deepEqual(seq[1], { mods: [], key: { vk: 0x08, ext: false } });
  assert.deepEqual(parseKeys("ctrl"), [{ mods: [], key: { vk: 0x11, ext: false } }]);
  assert.deepEqual(parseKeys("win"), [{ mods: [], key: { vk: 0x5b, ext: true } }]);
  assert.deepEqual(parseKeys("  alt+F4  ")[0]!.key, { vk: 0x73, ext: false });
  assert.deepEqual(parseKeys("f24")[0]!.key, { vk: 0x87, ext: false });
  assert.deepEqual(parseKeys("ctrl+minus")[0]!.key, parseKeys("ctrl+-")[0]!.key);
  assert.deepEqual(parseKeys("grave")[0]!.key, { vk: 0xc0, ext: false });
  assert.deepEqual(parseKeys("backslash")[0]!.key, parseKeys("\\")[0]!.key);
  for (const [name, vk] of [["Return", 0x0d], ["Enter", 0x0d], ["Esc", 0x1b], ["Page_Up", 0x21], ["Next", 0x22], ["space", 0x20], ["0", 0x30], ["z", 0x5a], ["Menu", 0x5d]] as const) {
    assert.equal(parseKeys(name)[0]!.key.vk, vk, name);
  }
});

test("parseKeys：扩展键", () => {
  // 微软 Keyboard Input Overview 的清单：Ins、Del、Home、End、Page Up、Page Down 和四个方向键都是扩展键；再加 Win、PrintScreen、Menu。
  for (const n of ["Left", "Up", "Right", "Down", "Delete", "Insert", "Home", "End", "Page_Up", "Page_Down", "PrintScreen", "Menu", "win", "super"]) {
    assert.equal(parseKeys(n)[0]!.key.ext, true, n);
  }
  for (const n of ["a", "Return", "F5", "space", "ctrl", "shift", "alt", "Tab", "BackSpace"]) assert.equal(parseKeys(n)[0]!.key.ext, false, n);
});

test("parseKeys：认不出的、空的、悬空的加号都报错，错误里有例子", () => {
  for (const bad of ["", "   ", "ctrl+", "+a", "foo", "ctrl+foo", "a+b", "ctrl++"]) {
    assert.match(failure(() => parseKeys(bad)), /例如 ctrl\+s/, JSON.stringify(bad));
  }
  assert.match(failure(() => parseKeys("foo")), /“foo”/);
});

test("parseModifiers：只认四类，去重，空串是没有", () => {
  assert.deepEqual(parseModifiers("ctrl+shift"), [{ vk: 0x11, ext: false }, { vk: 0x10, ext: false }]);
  assert.deepEqual(parseModifiers("Control+ctrl+Alt").map((k) => k.vk), [0x11, 0x12]);
  assert.deepEqual(parseModifiers("cmd")[0], { vk: 0x5b, ext: true });
  assert.deepEqual(parseModifiers(""), []);
  assert.match(failure(() => parseModifiers("ctrl+a")), /认不出“a”/);
});

test("输入事件：组合、点击、滚轮、文字", () => {
  const [c] = parseKeys("ctrl+shift+a");
  assert.deepEqual(comboEvents(c!).map((e) => (e.kind === "key" ? `${e.vk.toString(16)}${e.up ? "u" : "d"}` : "?")), ["11d", "10d", "41d", "41u", "10u", "11u"]);
  const click = clickEvents("right", 2, parseModifiers("ctrl"));
  assert.deepEqual(click, [
    { kind: "key", vk: 0x11, ext: false, up: false },
    { kind: "mouse", flags: 0x8, data: 0 },
    { kind: "mouse", flags: 0x10, data: 0 },
    { kind: "mouse", flags: 0x8, data: 0 },
    { kind: "mouse", flags: 0x10, data: 0 },
    { kind: "key", vk: 0x11, ext: false, up: true },
  ]);
  assert.equal(clickEvents("left", 3, []).length, 6);
  assert.deepEqual(wheelEvent("up"), { kind: "mouse", flags: 0x800, data: 120 });
  assert.deepEqual(wheelEvent("down"), { kind: "mouse", flags: 0x800, data: (-120) >>> 0 });
  assert.deepEqual(wheelEvent("right"), { kind: "mouse", flags: 0x1000, data: 120 });
  assert.deepEqual(wheelEvent("left"), { kind: "mouse", flags: 0x1000, data: (-120) >>> 0 });

  const items = typeItems("a\r\nb\nc\td\r😀");
  assert.deepEqual(items, [
    { unit: 0x61 },
    { key: { vk: 0x0d, ext: false } },
    { unit: 0x62 },
    { key: { vk: 0x0d, ext: false } },
    { unit: 0x63 },
    { key: { vk: 0x09, ext: false } },
    { unit: 0x64 },
    { key: { vk: 0x0d, ext: false } },
    { unit: 0xd83d },
    { unit: 0xde00 },
  ]);
  const ev = typeEvents([{ unit: 0x4e2d }]);
  assert.deepEqual(ev, [{ kind: "unit", unit: 0x4e2d, up: false }, { kind: "unit", unit: 0x4e2d, up: true }]);
});

test("parseArgs：每个动作的必填、类型、范围和默认值", () => {
  assert.deepEqual(parseArgs({ action: "screenshot", coordinate: "忽略" }), { action: "screenshot" });
  assert.match(failure(() => parseArgs({})), /action 要是/);
  assert.match(failure(() => parseArgs({ action: "fly" })), /action 要是/);

  assert.match(failure(() => parseArgs({ action: "click" })), /^click 要 coordinate/);
  assert.match(failure(() => parseArgs({ action: "click", coordinate: [1] })), /click 的 coordinate 要是 2 个整数/);
  assert.match(failure(() => parseArgs({ action: "click", coordinate: [1.5, 2] })), /整数/);
  assert.match(failure(() => parseArgs({ action: "click", coordinate: ["1", 2] })), /整数/);
  assert.deepEqual(parseArgs({ action: "click", coordinate: [3, 4] }), { action: "click", at: [3, 4], button: "left", count: 1, mods: [], modsText: "" });
  const c = parseArgs({ action: "click", coordinate: [3, 4], button: "right", count: 2, modifiers: "ctrl+shift" });
  assert.ok(c.action === "click" && c.button === "right" && c.count === 2 && c.mods.length === 2 && c.modsText === "ctrl+shift");
  assert.match(failure(() => parseArgs({ action: "click", coordinate: [1, 1], button: "x" })), /button 要是 left、right、middle/);
  for (const count of [0, 4, 1.5, "2"]) assert.match(failure(() => parseArgs({ action: "click", coordinate: [1, 1], count })), /count 要是 1 到 3/);
  assert.match(failure(() => parseArgs({ action: "click", coordinate: [1, 1], modifiers: 5 })), /modifiers 要是字符串/);
  assert.match(failure(() => parseArgs({ action: "click", coordinate: [1, 1], modifiers: "ctrl+x" })), /认不出“x”/);

  assert.deepEqual(parseArgs({ action: "move", coordinate: [0, 0] }), { action: "move", at: [0, 0] });
  assert.match(failure(() => parseArgs({ action: "move" })), /^move 要 coordinate/);

  assert.match(failure(() => parseArgs({ action: "drag", from: [1, 1] })), /^drag 要 to/);
  assert.match(failure(() => parseArgs({ action: "drag", to: [1, 1] })), /^drag 要 from/);
  assert.deepEqual(parseArgs({ action: "drag", from: [1, 2], to: [3, 4] }), { action: "drag", from: [1, 2], to: [3, 4] });

  assert.match(failure(() => parseArgs({ action: "scroll", coordinate: [1, 1] })), /^scroll 要 direction/);
  assert.match(failure(() => parseArgs({ action: "scroll", coordinate: [1, 1], direction: "north" })), /direction 要是/);
  for (const amount of [0, 21, 2.5]) assert.match(failure(() => parseArgs({ action: "scroll", coordinate: [1, 1], direction: "up", amount })), /amount 要是 1 到 20/);
  const s = parseArgs({ action: "scroll", coordinate: [1, 1], direction: "down" });
  assert.ok(s.action === "scroll" && s.amount === 3);

  assert.match(failure(() => parseArgs({ action: "type" })), /^type 要 text/);
  assert.match(failure(() => parseArgs({ action: "type", text: "" })), /1 到 4000/);
  assert.match(failure(() => parseArgs({ action: "type", text: "a".repeat(4001) })), /1 到 4000/);
  assert.match(failure(() => parseArgs({ action: "type", text: 5 })), /1 到 4000/);
  assert.deepEqual(parseArgs({ action: "type", text: "a".repeat(4000) }).action, "type");

  assert.match(failure(() => parseArgs({ action: "key" })), /^key 要 keys/);
  assert.match(failure(() => parseArgs({ action: "key", keys: 5 })), /keys 要是字符串/);
  assert.match(failure(() => parseArgs({ action: "key", keys: "nope" })), /认不出的键名/);
  const k = parseArgs({ action: "key", keys: " ctrl+a BackSpace " });
  assert.ok(k.action === "key" && k.keys === "ctrl+a BackSpace" && k.combos.length === 2);

  assert.match(failure(() => parseArgs({ action: "wait" })), /^wait 要 seconds/);
  for (const seconds of [-1, 10.5, "2", Number.NaN]) assert.match(failure(() => parseArgs({ action: "wait", seconds })), /0 到 10/);
  assert.deepEqual(parseArgs({ action: "wait", seconds: 0.5 }), { action: "wait", seconds: 0.5 });

  assert.match(failure(() => parseArgs({ action: "zoom" })), /^zoom 要 region/);
  assert.match(failure(() => parseArgs({ action: "zoom", region: [1, 2, 3] })), /4 个整数/);
});

test("checkBounds：越界和不合法的区域，错误里写出截图尺寸", () => {
  const shot = { w: 1568, h: 656 };
  checkBounds(parseArgs({ action: "click", coordinate: [1567, 655] }), shot);
  checkBounds(parseArgs({ action: "wait", seconds: 1 }), shot);
  for (const [x, y] of [[1568, 0], [0, 656], [-1, 0], [0, -1]]) {
    assert.match(failure(() => checkBounds(parseArgs({ action: "click", coordinate: [x, y] }), shot)), /超出截图范围.*1568×656/, `${x},${y}`);
  }
  assert.match(failure(() => checkBounds(parseArgs({ action: "scroll", coordinate: [9999, 1], direction: "up" }), shot)), /1568×656/);
  assert.match(failure(() => checkBounds(parseArgs({ action: "drag", from: [1, 1], to: [1568, 1] }), shot)), /drag 的 to .*1568×656/);
  assert.match(failure(() => checkBounds(parseArgs({ action: "move", coordinate: [0, 700] }), shot)), /1568×656/);

  checkBounds(parseArgs({ action: "zoom", region: [0, 0, 1568, 656] }), shot);
  for (const region of [[10, 10, 10, 20], [20, 10, 10, 20], [10, 20, 30, 20], [-1, 0, 5, 5], [0, 0, 1569, 5], [0, 0, 5, 657]]) {
    assert.match(failure(() => checkBounds(parseArgs({ action: "zoom", region }), shot)), /region.*1568×656/, JSON.stringify(region));
  }
});

test("doneText 和 describeWindow", () => {
  assert.equal(doneText(parseArgs({ action: "click", coordinate: [812, 344] })), "已点击 (812, 344)");
  assert.equal(doneText(parseArgs({ action: "click", coordinate: [1, 2], button: "right", count: 2, modifiers: "ctrl" })), "已右键双击 (1, 2)，按住 ctrl");
  assert.equal(doneText(parseArgs({ action: "type", text: "hello world!" })), "已输入 12 个字");
  assert.equal(doneText(parseArgs({ action: "key", keys: "ctrl+s" })), "已按 ctrl+s");
  assert.equal(doneText(parseArgs({ action: "scroll", coordinate: [5, 6], direction: "down", amount: 3 })), "已在 (5, 6) 滚动 down 3 格");
  assert.equal(doneText(parseArgs({ action: "wait", seconds: 2 })), "等了 2 秒");
  assert.equal(doneText(parseArgs({ action: "drag", from: [1, 2], to: [3, 4] })), "已从 (1, 2) 拖到 (3, 4)");
  assert.equal(doneText(parseArgs({ action: "screenshot" })), "");
  assert.equal(describeWindow("记事本", "notepad.exe"), "记事本（notepad.exe）");
  assert.equal(describeWindow("记事本", ""), "记事本");
  assert.equal(describeWindow("", "x.exe"), "无标题（x.exe）");
  assert.equal(describeWindow("", ""), "无");
});

// ---------- PNG ----------

/** 解开 PNG，反滤波，返回 RGB 像素；顺手检查签名、IHDR、每个块的 CRC，并记下用到的滤波类型。 */
function decodePng(png: Buffer): { width: number; height: number; rgb: Buffer; filters: Set<number> } {
  assert.equal(png.toString("latin1", 0, 8), "\x89PNG\r\n\x1a\n");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const names: string[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), zlib.crc32(png.subarray(off + 4, off + 8 + len)), `${type} 的 CRC`);
    names.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  assert.equal(off, png.length);
  assert.deepEqual([names[0], names[names.length - 1]], ["IHDR", "IEND"]);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  assert.equal(raw.length, (stride + 1) * height);
  const rgb = Buffer.alloc(stride * height);
  const filters = new Set<number>();
  for (let y = 0; y < height; y++) {
    const t = raw[y * (stride + 1)]!;
    filters.add(t);
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= 3 ? rgb[y * stride + i - 3]! : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i]! : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3]! : 0;
      let pred = 0;
      if (t === 1) pred = a;
      else if (t === 2) pred = b;
      else if (t === 3) pred = (a + b) >> 1;
      else if (t === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else assert.equal(t, 0);
      rgb[y * stride + i] = (x + pred) & 0xff;
    }
  }
  return { width, height, rgb, filters };
}

function rgbOf(bgra: Uint8Array): Buffer {
  const out = Buffer.alloc((bgra.length / 4) * 3);
  for (let i = 0; i < bgra.length / 4; i++) {
    out[i * 3] = bgra[i * 4 + 2]!;
    out[i * 3 + 1] = bgra[i * 4 + 1]!;
    out[i * 3 + 2] = bgra[i * 4]!;
  }
  return out;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

test("encodePng：随机图和各种渐变，解开后和输入逐个相等，五种滤波都会被选到", () => {
  const w = 97;
  const h = 60;
  const rnd = lcg(42);
  const filtersSeen = new Set<number>();
  const make = (f: (x: number, y: number, c: number) => number): Uint8Array => {
    const b = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) b[(y * w + x) * 4 + c] = c === 3 ? 0 : f(x, y, c) & 0xff;
    return b;
  };
  const images = [
    make(() => rnd()),
    make((x) => x * 2), // 横向渐变：Sub
    make((_x, y) => y * 4), // 纵向渐变：Up
    make((x, y) => x + y), // 对角：Average 或 Paeth
    make((x, y) => (x * 3 + y * 5 + ((x * y) % 7)) * 2),
    make(() => 0),
    make((x, y) => (((x >> 3) + (y >> 3)) & 1 ? 255 : 0)),
    make((x, y) => Math.round(120 + 100 * Math.sin(x / 5) * Math.cos(y / 4))),
  ];
  for (const bgra of images) {
    const d = decodePng(encodePng(bgra, w, h));
    assert.equal(d.width, w);
    assert.equal(d.height, h);
    assert.ok(d.rgb.equals(rgbOf(bgra)));
    for (const t of d.filters) filtersSeen.add(t);
  }
  assert.deepEqual([...filtersSeen].sort(), [0, 1, 2, 3, 4]);
});

test("encodePng：一像素宽、一像素高", () => {
  for (const [w, h] of [[1, 1], [1, 9], [9, 1]] as const) {
    const bgra = new Uint8Array(w * h * 4).map((_, i) => (i * 37) & 0xff);
    const d = decodePng(encodePng(bgra, w, h));
    assert.ok(d.rgb.equals(rgbOf(bgra)));
  }
});

test("encodeImage：够小用 PNG；超过上限改 JPEG；再超就报错", () => {
  const w = 64;
  const h = 64;
  const rnd = lcg(7);
  const noise = new Uint8Array(w * h * 4).map(() => rnd());
  const flat = new Uint8Array(w * h * 4);
  assert.equal(encodeImage(flat, w, h).ext, "png");
  const png = encodePng(noise, w, h);
  const j = encodeImage(noise, w, h, png.length - 1);
  assert.equal(j.ext, "jpg");
  assert.equal(j.bytes.toString("latin1", 0, 3), "\xff\xd8\xff");
  assert.ok(j.bytes.length <= png.length - 1);
  assert.match(failure(() => encodeImage(noise, w, h, 100)), /超过 100 字节/);
  assert.equal(IMAGE_MAX_BYTES, 1572864);
});

test("pruneComputerImages：删超过 1 小时的文件和空目录，留着新的、留着自己的目录", () => {
  const root = mkdtempSync(join(tmpdir(), "tau-computer-prune-"));
  try {
    const now = Date.now();
    const put = (dir: string, name: string, ageMs: number): string => {
      mkdirSync(join(root, dir), { recursive: true });
      const p = join(root, dir, name);
      writeFileSync(p, "x");
      utimesSync(p, new Date(now - ageMs), new Date(now - ageMs));
      return p;
    };
    const oldA = put("p1", "a.png", 2 * 3600_000);
    const newA = put("p1", "b.png", 10 * 60_000);
    const oldB = put("p2", "c.png", 90 * 60_000);
    const oldMine = put("mine", "d.png", 5 * 3600_000);
    writeFileSync(join(root, "loose.txt"), "不是目录");
    mkdirSync(join(root, "empty-old"));
    assert.equal(pruneComputerImages(root, now, join(root, "mine")), 3);
    assert.ok(!existsSync(oldA) && !existsSync(oldB) && !existsSync(oldMine));
    assert.ok(existsSync(newA));
    assert.ok(!existsSync(join(root, "p2")), "删空了的目录也删");
    assert.ok(!existsSync(join(root, "empty-old")));
    assert.ok(existsSync(join(root, "mine")), "自己的目录不删");
    assert.ok(existsSync(join(root, "p1")));
    assert.ok(existsSync(join(root, "loose.txt")));
    assert.equal(pruneComputerImages(join(root, "不存在"), now), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 脚本（只读：截图、放大） ----------

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

function runScript(home: string, input: unknown): SpawnSyncReturns<string> {
  const env = { ...process.env, USERPROFILE: home, HOME: home, TAU_PROCESS: "ptest", TAU_PIPE: "\\\\.\\pipe\\tau-computer-test" };
  return spawnSync(process.execPath, [SCRIPT], { env, input: JSON.stringify(input), encoding: "utf8", timeout: 60_000 });
}

function checkImage(home: string, items: Array<{ type: string; text?: string; path?: string }>): { w: number; h: number } {
  assert.equal(items.length, 2);
  assert.equal(items[0]!.type, "text");
  assert.equal(items[1]!.type, "image");
  const p = items[1]!.path!;
  assert.match(p, /^[A-Za-z]:\\/);
  assert.ok(p.startsWith(join(home, ".tau", "extras", "computer", "ptest")), p);
  assert.ok(existsSync(p));
  const bytes = readFileSync(p);
  assert.ok(statSync(p).size <= 1572864);
  const isPng = bytes.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n";
  const isJpg = bytes.toString("latin1", 0, 3) === "\xff\xd8\xff";
  assert.ok(isPng || isJpg, "魔数");
  assert.equal(p.endsWith(isPng ? ".png" : ".jpg"), true);
  const size = isPng ? pngSize(bytes) : jpegSize(bytes);
  assert.ok(size.w <= 2000 && size.h <= 2000);
  return size;
}

test("脚本：截图和放大（只读，不动鼠标键盘）", (t) => {
  const home = mkdtempSync(join(tmpdir(), "tau-computer-"));
  try {
    const shot = runScript(home, { action: "screenshot" });
    if (shot.status !== 0 && /屏幕锁着/.test(shot.stderr)) return t.skip("屏幕锁着，拿不到输入桌面");
    assert.equal(shot.status, 0, shot.stderr);
    const items = JSON.parse(shot.stdout) as Array<{ type: string; text?: string; path?: string }>;
    const size = checkImage(home, items);
    const m = /^截图 (\d+)×(\d+)，主屏 (\d+)×(\d+)；坐标按截图算。前台窗口：/.exec(items[0]!.text!);
    assert.ok(m, items[0]!.text);
    assert.deepEqual({ w: Number(m[1]), h: Number(m[2]) }, size);
    assert.deepEqual(fitSize(Number(m[3]), Number(m[4])), size);

    const zoom = runScript(home, { action: "zoom", region: [0, 0, Math.min(200, size.w), Math.min(100, size.h)] });
    assert.equal(zoom.status, 0, zoom.stderr);
    const zitems = JSON.parse(zoom.stdout) as Array<{ type: string; text?: string; path?: string }>;
    const zsize = checkImage(home, zitems);
    const zm = /^放大图：截图区域 \(0, 0\)–\((\d+), (\d+)\)，对应屏幕 (\d+)×(\d+) 像素，图 (\d+)×(\d+)。这张图里的坐标不能拿去点/.exec(zitems[0]!.text!);
    assert.ok(zm, zitems[0]!.text);
    assert.deepEqual({ w: Number(zm[5]), h: Number(zm[6]) }, zsize);
    assert.deepEqual(fitSize(Number(zm[3]), Number(zm[4])), zsize);

    // 越界和缺参数在动屏幕之前就报错，退出码 1。
    const bad = runScript(home, { action: "zoom", region: [0, 0, 99999, 10] });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /超出截图范围/);
    const missing = runScript(home, { action: "zoom" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /^zoom 要 region/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 输入：只编码、只用假的 Io，不碰真的鼠标键盘 ----------

const SIZE = 40;
const flagsAt = (b: Buffer, i: number): { type: number; vk: number; scan: number; flags: number; mouseData: number; mouseFlags: number } => ({
  type: b.readUInt32LE(i * SIZE),
  vk: b.readUInt16LE(i * SIZE + 8),
  scan: b.readUInt16LE(i * SIZE + 10),
  flags: b.readUInt32LE(i * SIZE + 12),
  mouseData: b.readUInt32LE(i * SIZE + 16),
  mouseFlags: b.readUInt32LE(i * SIZE + 20),
});

test("encodeInputs：INPUT 的字节和标志位（不调 SendInput）", () => {
  const ev: InputEvent[] = [
    { kind: "mouse", flags: 0x2, data: 0 },
    { kind: "mouse", flags: 0x4, data: 0 },
    { kind: "mouse", flags: 0x800, data: 120 },
    { kind: "mouse", flags: 0x800, data: (-120) >>> 0 },
    { kind: "mouse", flags: 0x1000, data: 120 },
    { kind: "mouse", flags: 0x1000, data: (-120) >>> 0 },
    { kind: "key", vk: 0x25, ext: true, up: false },
    { kind: "key", vk: 0x25, ext: true, up: true },
    { kind: "key", vk: 0x0d, ext: false, up: false },
    { kind: "unit", unit: 0x4e2d, up: false },
    { kind: "unit", unit: 0x4e2d, up: true },
  ];
  const b = encodeInputs(ev);
  assert.equal(b.length, SIZE * ev.length);
  const m = (i: number) => flagsAt(b, i);
  // 鼠标：type 0，dwFlags 在 mi 里偏移 12（INPUT 偏移 20），mouseData 在偏移 8（INPUT 偏移 16）。
  assert.deepEqual([m(0).type, m(0).mouseFlags, m(0).mouseData], [0, 0x2, 0]);
  assert.deepEqual([m(1).type, m(1).mouseFlags], [0, 0x4]);
  assert.deepEqual([m(2).mouseFlags, m(2).mouseData | 0], [0x800, 120]);
  assert.deepEqual([m(3).mouseFlags, m(3).mouseData | 0], [0x800, -120]);
  assert.deepEqual([m(4).mouseFlags, m(4).mouseData | 0], [0x1000, 120]);
  assert.deepEqual([m(5).mouseFlags, m(5).mouseData | 0], [0x1000, -120]);
  // 键盘：type 1；dwFlags 的 0x1 是扩展键，0x2 是松开，0x4 是 Unicode。
  assert.deepEqual([m(6).type, m(6).vk, m(6).flags], [1, 0x25, 0x1]);
  assert.deepEqual([m(7).vk, m(7).flags], [0x25, 0x3]);
  assert.equal(m(6).scan, 0x4b, "Left 的扫描码");
  assert.deepEqual([m(8).vk, m(8).scan, m(8).flags], [0x0d, 0x1c, 0]);
  assert.deepEqual([m(9).type, m(9).vk, m(9).scan, m(9).flags], [1, 0, 0x4e2d, 0x4]);
  assert.deepEqual([m(10).scan, m(10).flags], [0x4e2d, 0x6]);
});

test("stuckEvents：按着的才补发松开，右 Ctrl、右 Alt、Win 带扩展键", () => {
  assert.deepEqual(stuckEvents(() => false), []);
  const down = new Set([0xa2, 0xa3, 0xa5, 0x5b, 0x01]);
  assert.deepEqual(stuckEvents((vk) => down.has(vk)), [
    { kind: "key", vk: 0xa2, ext: false, up: true },
    { kind: "key", vk: 0xa3, ext: true, up: true },
    { kind: "key", vk: 0xa5, ext: true, up: true },
    { kind: "key", vk: 0x5b, ext: true, up: true },
    { kind: "mouse", flags: 0x4, data: 0 },
  ]);
  assert.deepEqual(stuckEvents((vk) => vk === 0x02 || vk === 0x04), [{ kind: "mouse", flags: 0x10, data: 0 }, { kind: "mouse", flags: 0x40, data: 0 }]);
});

function fakeIo(opts: { failCursorAt?: number } = {}): { io: Io; sends: InputEvent[][]; cursors: Point[]; sleeps: number[]; log: string[] } {
  const sends: InputEvent[][] = [];
  const cursors: Point[] = [];
  const sleeps: number[] = [];
  const log: string[] = [];
  const io: Io = {
    send: (e) => {
      sends.push(e);
      log.push("send");
    },
    setCursor: (p) => {
      cursors.push(p);
      log.push("cursor");
      if (opts.failCursorAt !== undefined && cursors.length === opts.failCursorAt) throw new Error("光标出错");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    releaseStuck: () => void log.push("release"),
  };
  return { io, sends, cursors, sleeps, log };
}

const SHOT = { w: 1568, h: 656 };
const SCREEN = { w: 3440, h: 1440 };

test("perform：screenshot、zoom、wait 从不发输入、不动光标", async () => {
  for (const raw of [{ action: "screenshot" }, { action: "zoom", region: [0, 0, 10, 10] }, { action: "wait", seconds: 2 }]) {
    const f = fakeIo();
    await perform(parseArgs(raw), SHOT, SCREEN, f.io);
    assert.deepEqual(f.log, [], JSON.stringify(raw));
    assert.deepEqual(f.sends, []);
    assert.deepEqual(f.cursors, []);
    assert.deepEqual(f.sleeps, raw.action === "wait" ? [2000] : []);
  }
});

test("perform：带修饰键的点击和滚动只发一次，修饰键先按后放", async () => {
  const click = fakeIo();
  await perform(parseArgs({ action: "click", coordinate: [10, 10], modifiers: "ctrl+shift", count: 2 }), SHOT, SCREEN, click.io);
  assert.equal(click.sends.length, 1);
  assert.deepEqual(click.log, ["release", "cursor", "send"]);
  const c = click.sends[0]!;
  assert.deepEqual(c.slice(0, 2).map((e) => e.kind === "key" && !e.up && e.vk), [0x11, 0x10]);
  assert.deepEqual(c.slice(-2).map((e) => e.kind === "key" && e.up && e.vk), [0x10, 0x11]);
  assert.equal(c.filter((e) => e.kind === "mouse").length, 4);

  const scroll = fakeIo();
  await perform(parseArgs({ action: "scroll", coordinate: [10, 10], direction: "down", amount: 5, modifiers: "ctrl" }), SHOT, SCREEN, scroll.io);
  assert.equal(scroll.sends.length, 1);
  assert.deepEqual(scroll.sleeps, []);
  const s = scroll.sends[0]!;
  assert.equal(s.length, 7);
  assert.deepEqual(s[0], { kind: "key", vk: 0x11, ext: false, up: false });
  assert.deepEqual(s[6], { kind: "key", vk: 0x11, ext: false, up: true });
  assert.ok(s.slice(1, 6).every((e) => e.kind === "mouse" && e.flags === 0x800));
  assert.deepEqual(scrollEvents("up", 2, []), [wheelEvent("up"), wheelEvent("up")]);
});

test("perform：type 分批不超过 64 个 INPUT，key 每个组合一次", async () => {
  const t = fakeIo();
  await perform(parseArgs({ action: "type", text: "x".repeat(70) }), SHOT, SCREEN, t.io);
  assert.deepEqual(t.sends.map((s) => s.length), [64, 64, 12]);
  assert.deepEqual(t.sleeps, [10, 10]);
  const k = fakeIo();
  await perform(parseArgs({ action: "key", keys: "ctrl+a BackSpace" }), SHOT, SCREEN, k.io);
  assert.deepEqual(k.sends.map((s) => s.length), [4, 2]);
  assert.deepEqual(k.sleeps, [30]);
});

test("perform：拖动中途出错也松开左键；每个动作开始前先放开卡住的键", async () => {
  const f = fakeIo({ failCursorAt: 4 });
  await assert.rejects(perform(parseArgs({ action: "drag", from: [1, 1], to: [500, 300] }), SHOT, SCREEN, f.io), /光标出错/);
  assert.equal(f.log[0], "release");
  assert.deepEqual(f.sends[0], [{ kind: "mouse", flags: 0x2, data: 0 }]);
  assert.deepEqual(f.sends[f.sends.length - 1], [{ kind: "mouse", flags: 0x4, data: 0 }]);
  const ok = fakeIo();
  await perform(parseArgs({ action: "drag", from: [1, 1], to: [500, 300] }), SHOT, SCREEN, ok.io);
  assert.equal(ok.cursors.length, 11);
  assert.deepEqual(ok.cursors[10], toScreen({ x: 500, y: 300 }, SHOT, SCREEN));
  for (const raw of [{ action: "move", coordinate: [1, 1] }, { action: "type", text: "a" }, { action: "key", keys: "a" }]) {
    const g = fakeIo();
    await perform(parseArgs(raw), SHOT, SCREEN, g.io);
    assert.equal(g.log[0], "release", raw.action);
  }
});
