// computer 工具的纯函数：参数检查、坐标换算、键名、输入事件、PNG/JPEG 编码、旧图清理。
// 不导入 koffi，不碰屏幕和输入；只有 `pruneComputerImages` 读写文件。脚本是 computer.ts，系统调用在 win32.ts。
import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import jpeg from "jpeg-js";
import { Fail } from "./common.ts";

/** 一张图片的字节上限、宽高上限：和内核的入口条件一样（extras/ 不许导入 src/，所以抄一份）。 */
export const IMAGE_MAX_BYTES = 1572864;
export const IMAGE_MAX_EDGE = 2000;
/** 给模型的图：长边和总像素的上限。Anthropic 会把更大的图再缩一次，模型看到的就不是我们的像素，坐标会偏。 */
const SHOT_MAX_EDGE = 1568;
const SHOT_MAX_PIXELS = 1_150_000;
/** 截图文件保留这么久，之后被下一次调用清掉。 */
const KEEP_MS = 60 * 60 * 1000;

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point, Size {}

/** 缩成不超过长边和总像素上限的大小，不放大。 */
export function fitSize(w: number, h: number): Size {
  const s = Math.min(1, SHOT_MAX_EDGE / Math.max(w, h), Math.sqrt(SHOT_MAX_PIXELS / (w * h)));
  // 加一个很小的数，免得 3440 * (1568 / 3440) 这类乘法差一点落到整数下面。
  return { w: Math.max(1, Math.floor(w * s + 1e-9)), h: Math.max(1, Math.floor(h * s + 1e-9)) };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 截图里的像素坐标换成屏幕坐标，按像素中心算。 */
export function toScreen(p: Point, shot: Size, screen: Size): Point {
  return {
    x: clamp(Math.floor(((p.x + 0.5) * screen.w) / shot.w), 0, screen.w - 1),
    y: clamp(Math.floor(((p.y + 0.5) * screen.h) / shot.h), 0, screen.h - 1),
  };
}

/** 截图里的一块区域（左上含、右下不含）对应的屏幕矩形，取整时向外，不出屏幕。 */
export function zoomRect(region: [number, number, number, number], shot: Size, screen: Size): Rect {
  const [x0, y0, x1, y1] = region;
  const left = clamp(Math.floor((x0 * screen.w) / shot.w), 0, screen.w - 1);
  const top = clamp(Math.floor((y0 * screen.h) / shot.h), 0, screen.h - 1);
  const right = clamp(Math.ceil((x1 * screen.w) / shot.w), left + 1, screen.w);
  const bottom = clamp(Math.ceil((y1 * screen.h) / shot.h), top + 1, screen.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** zoom 结果的文字：放大图里的点 (u, v) 换成截图坐标的公式和系数，免得模型自己算。 */
export function zoomText(region: Quad, rect: Size, out: Size): string {
  const [x0, y0, x1, y1] = region;
  const kx = ((x1 - x0) / out.w).toFixed(3);
  const ky = ((y1 - y0) / out.h).toFixed(3);
  return `放大图：截图区域 (${x0}, ${y0})–(${x1}, ${y1})，对应屏幕 ${rect.w}×${rect.h} 像素，图 ${out.w}×${out.h}。放大图里的点 (u, v) 在截图里是 (${x0} + u × kx, ${y0} + v × ky)，kx = ${kx}，ky = ${ky}；点的时候先换成截图坐标。`;
}

// ---------- 键盘 ----------

export interface Key {
  vk: number;
  /** 扩展键，发 KEYEVENTF_EXTENDEDKEY。 */
  ext: boolean;
}
export interface Combo {
  /** 先按下的修饰键，按下的顺序。 */
  mods: Key[];
  key: Key;
}

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RETURN = 0x0d;
const VK_TAB = 0x09;

const MODIFIERS: Record<string, Key> = {
  ctrl: { vk: VK_CONTROL, ext: false },
  control: { vk: VK_CONTROL, ext: false },
  shift: { vk: VK_SHIFT, ext: false },
  alt: { vk: VK_MENU, ext: false },
  win: { vk: VK_LWIN, ext: true },
  super: { vk: VK_LWIN, ext: true },
  meta: { vk: VK_LWIN, ext: true },
  cmd: { vk: VK_LWIN, ext: true },
};

const NAMED: Array<[string[], number, boolean]> = [
  [["return", "enter"], VK_RETURN, false],
  [["tab"], VK_TAB, false],
  [["escape", "esc"], 0x1b, false],
  [["backspace"], 0x08, false],
  [["delete", "del"], 0x2e, true],
  [["insert"], 0x2d, true],
  [["home"], 0x24, true],
  [["end"], 0x23, true],
  [["page_up", "pageup", "prior"], 0x21, true],
  [["page_down", "pagedown", "next"], 0x22, true],
  [["left"], 0x25, true],
  [["up"], 0x26, true],
  [["right"], 0x27, true],
  [["down"], 0x28, true],
  [["space"], 0x20, false],
  [["capslock"], 0x14, false],
  [["printscreen", "print"], 0x2c, true],
  [["menu", "apps"], 0x5d, true],
  [["minus", "-"], 0xbd, false],
  [["equal", "=", "plus"], 0xbb, false],
  [["comma", ","], 0xbc, false],
  [["period", "."], 0xbe, false],
  [["slash", "/"], 0xbf, false],
  [["semicolon", ";"], 0xba, false],
  [["apostrophe", "quote", "'"], 0xde, false],
  [["bracketleft", "["], 0xdb, false],
  [["bracketright", "]"], 0xdd, false],
  [["backslash", "\\"], 0xdc, false],
  [["grave", "`"], 0xc0, false],
];

const KEYS = new Map<string, Key>();
for (const [names, vk, ext] of NAMED) for (const n of names) KEYS.set(n, { vk, ext });
for (let i = 0; i < 26; i++) KEYS.set(String.fromCharCode(97 + i), { vk: 0x41 + i, ext: false });
for (let i = 0; i < 10; i++) KEYS.set(String(i), { vk: 0x30 + i, ext: false });
for (let i = 1; i <= 24; i++) KEYS.set(`f${i}`, { vk: 0x70 + i - 1, ext: false });

const KEY_EXAMPLES = "例如 ctrl+s、Return、Escape、alt+Tab、ctrl+shift+Left、F5、ctrl+a BackSpace（空格分开的是依次按的几个组合）";

/** xdotool 写法的按键：`ctrl+s`，空格分开的几个组合依次按。大小写不敏感。 */
export function parseKeys(s: string): Combo[] {
  const parts = s.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) throw new Fail(`keys 是空的。${KEY_EXAMPLES}。`);
  return parts.map((part) => {
    const names = part.split("+");
    const keys = names.map((n) => {
      const k = MODIFIERS[n.toLowerCase()] ?? KEYS.get(n.toLowerCase());
      if (k === undefined) throw new Fail(`认不出的键名：“${n}”（在“${part}”里）。${KEY_EXAMPLES}。`);
      return k;
    });
    const key = keys[keys.length - 1]!;
    const mods = keys.slice(0, -1);
    for (let i = 0; i < mods.length; i++) {
      if (MODIFIERS[names[i]!.toLowerCase()] === undefined) throw new Fail(`“${part}”里，加号前面只能是修饰键 ctrl、shift、alt、win：“${names[i]}”不是。${KEY_EXAMPLES}。`);
    }
    return { mods, key };
  });
}

/** `ctrl+shift` 这种，只认修饰键；空串是没有。 */
export function parseModifiers(s: string): Key[] {
  const out: Key[] = [];
  for (const n of s.split("+").map((x) => x.trim().toLowerCase()).filter((x) => x !== "")) {
    const k = MODIFIERS[n];
    if (k === undefined) throw new Fail(`modifiers 里认不出“${n}”：只认 ctrl、shift、alt、win，用加号连，例如 ctrl+shift。`);
    if (!out.some((o) => o.vk === k.vk)) out.push(k);
  }
  return out;
}

// ---------- 输入事件 ----------

export type InputEvent =
  | { kind: "key"; vk: number; ext: boolean; up: boolean }
  | { kind: "unit"; unit: number; up: boolean }
  | { kind: "mouse"; flags: number; data: number };

export type Button = "left" | "right" | "middle";
const MOUSE_FLAGS: Record<Button, [number, number]> = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };
export const WHEEL = 0x800;
export const HWHEEL = 0x1000;
const WHEEL_DELTA = 120;

/** 修饰键按下，几次（按下、松开），修饰键倒序松开。 */
export function clickEvents(button: Button, count: number, mods: Key[]): InputEvent[] {
  const [down, up] = MOUSE_FLAGS[button];
  const out: InputEvent[] = mods.map((m) => ({ kind: "key", vk: m.vk, ext: m.ext, up: false }));
  for (let i = 0; i < count; i++) out.push({ kind: "mouse", flags: down, data: 0 }, { kind: "mouse", flags: up, data: 0 });
  for (const m of [...mods].reverse()) out.push({ kind: "key", vk: m.vk, ext: m.ext, up: true });
  return out;
}

/** 事件全是“松开”：键盘（含 unit）up 为真，鼠标是左、中、右键的 UP。空数组算是（什么也不按下，不需要租约）；混入按下、滚轮、移动都不算。
 *  只松开的输入不经过租约：续租失败时，补发的松开不能被挡住，否则键会卡在按下状态。 */
export function onlyReleases(events: InputEvent[]): boolean {
  return events.every((e) => (e.kind === "mouse" ? Object.values(MOUSE_FLAGS).some(([, up]) => e.flags === up) : e.up));
}

export const buttonDown = (b: Button): InputEvent => ({ kind: "mouse", flags: MOUSE_FLAGS[b][0], data: 0 });
export const buttonUp = (b: Button): InputEvent => ({ kind: "mouse", flags: MOUSE_FLAGS[b][1], data: 0 });

export const keyDown = (k: Key): InputEvent => ({ kind: "key", vk: k.vk, ext: k.ext, up: false });
export const keyUp = (k: Key): InputEvent => ({ kind: "key", vk: k.vk, ext: k.ext, up: true });

/** 一个组合：修饰键按下，键按下、松开，修饰键倒序松开。 */
export function comboEvents(c: Combo): InputEvent[] {
  return [...c.mods.map(keyDown), keyDown(c.key), keyUp(c.key), ...[...c.mods].reverse().map(keyUp)];
}

/** 一格滚轮：向上、向右为正。`data` 是无符号的 32 位。 */
export function wheelEvent(direction: "up" | "down" | "left" | "right"): InputEvent {
  const horizontal = direction === "left" || direction === "right";
  const delta = direction === "up" || direction === "right" ? WHEEL_DELTA : -WHEEL_DELTA;
  return { kind: "mouse", flags: horizontal ? HWHEEL : WHEEL, data: delta >>> 0 };
}

/** 一段文字拆成要发的项：UTF-16 单位，换行是 Return 键，制表符是 Tab 键。 */
export type TypeItem = { unit: number } | { key: Key };
export function typeItems(text: string): TypeItem[] {
  const out: TypeItem[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d || c === 0x0a) {
      if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
      out.push({ key: { vk: VK_RETURN, ext: false } });
    } else if (c === 0x09) {
      out.push({ key: { vk: VK_TAB, ext: false } });
    } else {
      out.push({ unit: c });
    }
  }
  return out;
}

/** 输入文字，每个字之间等这么久。成批一次发出时，新版记事本偶尔丢字或换字；逐字间隔约 15 毫秒实测全对。 */
export const TYPE_GAP_MS = 10;

export function typeEvents(items: TypeItem[]): InputEvent[] {
  const out: InputEvent[] = [];
  for (const it of items) {
    if ("unit" in it) out.push({ kind: "unit", unit: it.unit, up: false }, { kind: "unit", unit: it.unit, up: true });
    else out.push(keyDown(it.key), keyUp(it.key));
  }
  return out;
}

/** 一次发完：修饰键按下，滚轮 `amount` 格，修饰键倒序松开。被结束时不会留下按着的修饰键。 */
export function scrollEvents(direction: Direction, amount: number, mods: Key[]): InputEvent[] {
  return [...mods.map(keyDown), ...Array.from({ length: amount }, () => wheelEvent(direction)), ...[...mods].reverse().map(keyUp)];
}

// 左右 Shift、Ctrl、Alt，左右 Win。右 Ctrl、右 Alt、Win 是扩展键。
const STUCK_KEYS: Key[] = [
  { vk: 0xa0, ext: false },
  { vk: 0xa1, ext: false },
  { vk: 0xa2, ext: false },
  { vk: 0xa3, ext: true },
  { vk: 0xa4, ext: false },
  { vk: 0xa5, ext: true },
  { vk: 0x5b, ext: true },
  { vk: 0x5c, ext: true },
];
const STUCK_BUTTONS: Array<[number, Button]> = [[0x01, "left"], [0x02, "right"], [0x04, "middle"]];

/** 按着的键和鼠标键，要补发的松开事件。`isDown(vk)` 问某个虚拟键是不是按着。 */
export function stuckEvents(isDown: (vk: number) => boolean): InputEvent[] {
  const out: InputEvent[] = [];
  for (const k of STUCK_KEYS) if (isDown(k.vk)) out.push(keyUp(k));
  for (const [vk, b] of STUCK_BUTTONS) if (isDown(vk)) out.push(buttonUp(b));
  return out;
}

// ---------- 参数 ----------

export type Direction = "up" | "down" | "left" | "right";
export type Quad = [number, number, number, number];

export type Action =
  | { action: "screenshot" }
  | { action: "zoom"; region: Quad }
  | { action: "click"; at: [number, number]; button: Button; count: number; mods: Key[]; modsText: string }
  | { action: "move"; at: [number, number] }
  | { action: "drag"; from: [number, number]; to: [number, number] }
  | { action: "scroll"; at: [number, number]; direction: Direction; amount: number; mods: Key[]; modsText: string }
  | { action: "type"; text: string }
  | { action: "key"; keys: string; combos: Combo[] }
  | { action: "wait"; seconds: number };

const ACTIONS = ["screenshot", "zoom", "click", "move", "drag", "scroll", "type", "key", "wait"];

function ints(action: string, name: string, v: unknown, n: number, hint: string): number[] {
  if (v === undefined || v === null) throw new Fail(`${action} 要 ${name}：${hint}`);
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => Number.isInteger(x))) throw new Fail(`${action} 的 ${name} 要是 ${n} 个整数的数组：${hint}`);
  return v as number[];
}

function oneOf<T extends string>(action: string, name: string, v: unknown, allowed: readonly T[], dflt?: T): T {
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw new Fail(`${action} 要 ${name}：${allowed.join("、")} 之一。`);
  }
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Fail(`${action} 的 ${name} 要是 ${allowed.join("、")} 之一。`);
  return v as T;
}

function intIn(action: string, name: string, v: unknown, lo: number, hi: number, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new Fail(`${action} 的 ${name} 要是 ${lo} 到 ${hi} 的整数。`);
  return v;
}

const pair = (a: number[]): [number, number] => [a[0]!, a[1]!];

/** 检查类型、必填和范围，不涉及屏幕尺寸（那一半是 `checkBounds`）。 */
export function parseArgs(raw: Record<string, unknown>): Action {
  const action = raw["action"];
  if (typeof action !== "string" || !ACTIONS.includes(action)) throw new Fail(`action 要是 ${ACTIONS.join("、")} 之一。`);
  const point = (name: string): [number, number] => pair(ints(action, name, raw[name], 2, "[x, y]，截图里的像素坐标。"));
  const modsOf = (): { mods: Key[]; modsText: string } => {
    const m = raw["modifiers"];
    if (m === undefined || m === null) return { mods: [], modsText: "" };
    if (typeof m !== "string") throw new Fail(`${action} 的 modifiers 要是字符串，例如 ctrl+shift。`);
    const mods = parseModifiers(m);
    return { mods, modsText: m.trim() };
  };
  switch (action) {
    case "screenshot":
      return { action };
    case "zoom": {
      const r = ints(action, "region", raw["region"], 4, "[x0, y0, x1, y1]，截图里的像素坐标。");
      return { action, region: [r[0]!, r[1]!, r[2]!, r[3]!] };
    }
    case "click":
      return {
        action,
        at: point("coordinate"),
        button: oneOf(action, "button", raw["button"], ["left", "right", "middle"], "left"),
        count: intIn(action, "count", raw["count"], 1, 3, 1),
        ...modsOf(),
      };
    case "move":
      return { action, at: point("coordinate") };
    case "drag":
      return { action, from: point("from"), to: point("to") };
    case "scroll":
      return {
        action,
        at: point("coordinate"),
        direction: oneOf(action, "direction", raw["direction"], ["up", "down", "left", "right"]),
        amount: intIn(action, "amount", raw["amount"], 1, 20, 3),
        ...modsOf(),
      };
    case "type": {
      const t = raw["text"];
      if (t === undefined || t === null) throw new Fail("type 要 text：要输入的文字。");
      if (typeof t !== "string" || t.length < 1 || t.length > 1000) throw new Fail("type 的 text 要是 1 到 1000 个字的字符串；长文字分几次输入。");
      return { action, text: t };
    }
    case "key": {
      const k = raw["keys"];
      if (k === undefined || k === null) throw new Fail(`key 要 keys：按键，${KEY_EXAMPLES}。`);
      if (typeof k !== "string") throw new Fail("key 的 keys 要是字符串。");
      return { action, keys: k.trim(), combos: parseKeys(k) };
    }
    default: {
      const s = raw["seconds"];
      if (s === undefined || s === null) throw new Fail("wait 要 seconds：0 到 10 的数。");
      if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 10) throw new Fail("wait 的 seconds 要是 0 到 10 的数。");
      return { action: "wait", seconds: s };
    }
  }
}

/** 坐标和区域要落在截图里；错误里写出截图的尺寸。 */
export function checkBounds(a: Action, shot: Size): void {
  const where = `截图是 ${shot.w}×${shot.h}：x 要在 0 到 ${shot.w - 1}，y 要在 0 到 ${shot.h - 1}`;
  const inside = (name: string, p: [number, number]): void => {
    if (p[0] < 0 || p[0] >= shot.w || p[1] < 0 || p[1] >= shot.h) throw new Fail(`${a.action} 的 ${name} (${p[0]}, ${p[1]}) 超出截图范围。${where}。`);
  };
  switch (a.action) {
    case "click":
    case "move":
    case "scroll":
      inside("coordinate", a.at);
      return;
    case "drag":
      inside("from", a.from);
      inside("to", a.to);
      return;
    case "zoom": {
      const [x0, y0, x1, y1] = a.region;
      if (x0 < 0 || y0 < 0 || x1 > shot.w || y1 > shot.h) throw new Fail(`zoom 的 region [${a.region.join(", ")}] 超出截图范围。截图是 ${shot.w}×${shot.h}：x 要在 0 到 ${shot.w}，y 要在 0 到 ${shot.h}。`);
      if (x0 >= x1 || y0 >= y1) throw new Fail(`zoom 的 region [${a.region.join(", ")}] 不合法：要 x0 < x1 且 y0 < y1。截图是 ${shot.w}×${shot.h}。`);
      return;
    }
    default:
      return;
  }
}

// ---------- 文字 ----------

/** 前台窗口：标题和程序名，哪个拿不到就缺哪个。 */
export function describeWindow(title: string, exe: string): string {
  if (title === "" && exe === "") return "无";
  if (exe === "") return title;
  return `${title === "" ? "无标题" : title}（${exe}）`;
}

/** 做了什么，一句话；单纯截图和放大没有。 */
export function doneText(a: Action): string {
  const at = (p: [number, number]): string => `(${p[0]}, ${p[1]})`;
  const mods = (m: string): string => (m === "" ? "" : `，按住 ${m}`);
  switch (a.action) {
    case "click": {
      const who = a.button === "left" ? "" : a.button === "right" ? "右键" : "中键";
      const how = a.count === 1 ? "点击" : a.count === 2 ? "双击" : "三击";
      return `已${who}${how} ${at(a.at)}${mods(a.modsText)}`;
    }
    case "move":
      return `已移动到 ${at(a.at)}`;
    case "drag":
      return `已从 ${at(a.from)} 拖到 ${at(a.to)}`;
    case "scroll":
      return `已在 ${at(a.at)} 滚动 ${a.direction} ${a.amount} 格${mods(a.modsText)}`;
    case "type":
      return `已输入 ${a.text.length} 个字`;
    case "key":
      return `已按 ${a.keys}`;
    case "wait":
      return `等了 ${a.seconds} 秒`;
    default:
      return "";
  }
}

// ---------- 做动作 ----------

/** 做动作要用的外部能力：测试里换成假的。 */
export interface Io {
  send(events: InputEvent[]): void;
  setCursor(p: Point): void;
  sleep(ms: number): Promise<void>;
  /** 放开卡住的键。 */
  releaseStuck(): void;
}

const DRAG_STEPS = 10;

/** 做动作。会动鼠标键盘的先放开卡住的键。所有输入尽量一次 `send` 发完。 */
export async function perform(a: Action, shot: Size, screen: Size, io: Io): Promise<void> {
  const at = (p: [number, number]): Point => toScreen({ x: p[0], y: p[1] }, shot, screen);
  switch (a.action) {
    case "screenshot":
    case "zoom":
      return;
    case "wait":
      await io.sleep(a.seconds * 1000);
      return;
    case "move":
      io.releaseStuck();
      io.setCursor(at(a.at));
      return;
    case "click":
      io.releaseStuck();
      io.setCursor(at(a.at));
      await io.sleep(30);
      io.send(clickEvents(a.button, a.count, a.mods));
      return;
    case "drag": {
      io.releaseStuck();
      const from = at(a.from);
      const to = at(a.to);
      io.setCursor(from);
      io.send([buttonDown("left")]);
      try {
        await io.sleep(50);
        for (let i = 1; i <= DRAG_STEPS; i++) {
          io.setCursor({ x: Math.round(from.x + ((to.x - from.x) * i) / DRAG_STEPS), y: Math.round(from.y + ((to.y - from.y) * i) / DRAG_STEPS) });
          await io.sleep(15);
        }
        await io.sleep(50);
      } finally {
        io.send([buttonUp("left")]);
      }
      return;
    }
    case "scroll":
      io.releaseStuck();
      io.setCursor(at(a.at));
      io.send(scrollEvents(a.direction, a.amount, a.mods));
      return;
    case "type": {
      io.releaseStuck();
      const items = typeItems(a.text);
      for (const it of items) {
        io.send(typeEvents([it]));
        await io.sleep(TYPE_GAP_MS);
      }
      return;
    }
    case "key":
      io.releaseStuck();
      for (let i = 0; i < a.combos.length; i++) {
        if (i > 0) await io.sleep(30);
        io.send(comboEvents(a.combos[i]!));
      }
      return;
  }
}

// ---------- 图片 ----------

function crcChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** 一行按某种滤波写进 `out[1..]`，`out[0]` 是滤波类型。`bpp` 是每像素字节数。 */
function filterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array): void {
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const x = row[i]!;
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i + 1] = (x - pred) & 0xff;
  }
}

const absSum = (b: Uint8Array): number => {
  let s = 0;
  for (let i = 1; i < b.length; i++) s += Math.abs((b[i]! << 24) >> 24);
  return s;
};

/** 32 位 BGRA（自上而下）编成 8 位 RGB 的 PNG。每行从五种滤波里挑“滤波后字节当有符号数的绝对值之和”最小的。 */
export function encodePng(bgra: Uint8Array, width: number, height: number): Buffer {
  const len = width * 3;
  const raw = Buffer.alloc((len + 1) * height);
  let prev: Uint8Array = new Uint8Array(len);
  const row = new Uint8Array(len);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(len + 1));
  for (let y = 0; y < height; y++) {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      row[x * 3] = bgra[base + x * 4 + 2]!;
      row[x * 3 + 1] = bgra[base + x * 4 + 1]!;
      row[x * 3 + 2] = bgra[base + x * 4]!;
    }
    let best = 0;
    let bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, row, prev, 3, cand[t]!);
      const s = absSum(cand[t]!);
      if (s < bestSum) {
        bestSum = s;
        best = t;
      }
    }
    raw.set(cand[best]!, y * (len + 1));
    prev = Uint8Array.from(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    crcChunk("IHDR", ihdr),
    crcChunk("IDAT", zlib.deflateSync(raw)),
    crcChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 32 位 BGRA 编成 JPEG。 */
export function encodeJpeg(bgra: Uint8Array, width: number, height: number, quality: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = bgra[i * 4 + 2]!;
    rgba[i * 4 + 1] = bgra[i * 4 + 1]!;
    rgba[i * 4 + 2] = bgra[i * 4]!;
    rgba[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width, height }, quality).data;
}

/** PNG；超过上限改 JPEG（质量 80，再 60），还超就报错。 */
export function encodeImage(bgra: Uint8Array, width: number, height: number, maxBytes = IMAGE_MAX_BYTES): { bytes: Buffer; ext: "png" | "jpg" } {
  const png = encodePng(bgra, width, height);
  if (png.length <= maxBytes) return { bytes: png, ext: "png" };
  for (const q of [80, 60]) {
    const j = encodeJpeg(bgra, width, height, q);
    if (j.length <= maxBytes) return { bytes: j, ext: "jpg" };
  }
  throw new Fail(`截图编码以后还是超过 ${maxBytes} 字节：画面太花。可以用 zoom 看一小块。`);
}

// ---------- 清理 ----------

function tryGet<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** 删 `root` 下修改时间早于 1 小时的文件，删空了的进程目录也删（`keep` 除外）。每一步失败都忽略。 */
export function pruneComputerImages(root: string, now: number, keep?: string): number {
  let gone = 0;
  for (const name of tryGet(() => readdirSync(root)) ?? []) {
    const dir = path.join(root, name);
    for (const f of tryGet(() => (statSync(dir).isDirectory() ? readdirSync(dir) : [])) ?? []) {
      const p = path.join(dir, f);
      if (!(tryGet(() => statSync(p).isFile() && now - statSync(p).mtimeMs > KEEP_MS) ?? false)) continue;
      if (tryGet(() => { unlinkSync(p); return true; }) === true) gone++;
    }
    if (dir !== keep) tryGet(() => (readdirSync(dir).length === 0 ? rmdirSync(dir) : undefined));
  }
  return gone;
}
